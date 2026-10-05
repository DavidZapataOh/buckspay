package xyz.buckspay.hardwarekeys

import android.content.ContentValues
import android.database.DatabaseErrorHandler
import android.database.DatabaseUtils
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.security.MessageDigest

internal class EquivocationException : CodedException("This slot is already signed with another content")

internal class OverIssuanceException : CodedException("This issue overlaps an interval already issued on its lock")

internal class NoteGuardUnavailableException(
  message: String,
  cause: Throwable? = null,
) : CodedException(message, cause)

/**
 * The lock that lets one process at a time use the note guards of a key alias. It is taken on a
 * file that is never renamed or deleted, so every opener contends for the same inode, and at most
 * once per process: closing a second channel on the file would release the operating system's lock.
 */
internal class GuardLock private constructor(
  private val path: String,
  private val channel: FileChannel,
  private val lock: FileLock,
) : Closeable {
  val isHeld: Boolean get() = lock.isValid

  override fun close() {
    synchronized(held) {
      if (!channel.isOpen) return
      lock.release()
      channel.close()
      held.remove(path)
    }
  }

  companion object {
    private val held = HashSet<String>()

    /** Takes the lock on `file` or throws `NoteGuardUnavailableException` if a process holds it. */
    fun acquire(file: File): GuardLock {
      val path = file.canonicalPath
      synchronized(held) {
        if (path in held) throw NoteGuardUnavailableException("The note guard is open elsewhere")
        val channel = RandomAccessFile(file, "rw").channel
        val lock =
          try {
            channel.tryLock()
          } catch (e: OverlappingFileLockException) {
            null
          }
        if (lock == null) {
          channel.close()
          throw NoteGuardUnavailableException("The note guard is open elsewhere")
        }
        held.add(path)
        return GuardLock(path, channel, lock)
      }
    }
  }
}

/**
 * The `note` slots the device key has signed under one note domain, kept for good so that it never
 * signs two contents for one slot or two overlapping issues on one lock, the two conflicts that
 * slash its bond. It is a SQLite database bound to `SHA-256(spki ‖ DOMAIN(note))`: a spend slot
 * keeps its content forever, and a lock keeps its last issue, where every new issue on it must
 * start. A new slot is committed to disk before its signature exists; nothing is kept in memory.
 */
internal class NoteGuard private constructor(
  private val database: SQLiteDatabase,
) : Closeable {
  private val spend = database.compileStatement("SELECT coalesce((SELECT content = ? FROM spends WHERE slot = ?), -1)")
  private val insertSpend = database.compileStatement("INSERT INTO spends (slot, content) VALUES (?, ?)")
  private val deleteSpend = database.compileStatement("DELETE FROM spends WHERE slot = ?")
  private val journal = File("${database.path}-journal")
  private var journalSeen = journal.exists()

  val size: Long get() = DatabaseUtils.queryNumEntries(database, "spends") + DatabaseUtils.queryNumEntries(database, "issues")

  /**
   * Runs `sign` if the guard admits `content` in `slot`: the same content again, a new spend slot,
   * or a new issue that starts at or after the end of the last one on its lock. A new slot is
   * committed before `sign` runs and removed again if `sign` throws, since no signature exists then.
   * It refuses, without signing, once a journal it has seen is gone: the connection keeps its handle
   * to the unlinked file and would go on committing with no journal to recover from.
   */
  fun <T> admit(
    slot: ByteArray,
    content: ByteArray,
    sign: () -> T,
  ): T {
    require(slot.size == 32 && content.size == 32) { "slot and content are 32 bytes" }
    val interval = issueInterval(slot)
    if (interval != null) require(java.lang.Long.compareUnsigned(interval.second, interval.third) < 0) { "empty issue interval" }
    synchronized(ADMISSIONS) {
      requireJournal()
      val undo =
        try {
          transaction { if (interval == null) recordSpend(slot, content) else recordIssue(interval, slot, content) }
        } catch (e: SQLiteException) {
          throw NoteGuardUnavailableException("The note guard cannot record this slot", e)
        }
      requireJournal()
      if (undo == null) return sign()
      try {
        return sign()
      } catch (e: Throwable) {
        try {
          transaction(undo)
        } catch (removal: Exception) {
          e.addSuppressed(removal)
        }
        throw e
      }
    }
  }

  /** SQLite opens the journal at the first write where the filesystem needs one; F2FS's atomic writes may never open it. */
  private fun requireJournal() {
    if (journal.exists()) {
      journalSeen = true
    } else if (journalSeen) {
      throw NoteGuardUnavailableException("The note guard lost its journal")
    }
  }

  override fun close() {
    listOf(spend, insertSpend, deleteSpend).forEach { it.close() }
    database.close()
  }

  /** Records a new spend slot and returns how to remove it, or null if it already holds `content`. */
  private fun recordSpend(
    slot: ByteArray,
    content: ByteArray,
  ): (() -> Unit)? {
    spend.bindBlob(1, content)
    spend.bindBlob(2, slot)
    when (spend.simpleQueryForLong()) {
      1L -> return null
      0L -> throw EquivocationException()
    }
    insertSpend.bindBlob(1, slot)
    insertSpend.bindBlob(2, content)
    insertSpend.executeInsert()
    return {
      deleteSpend.bindBlob(1, slot)
      deleteSpend.executeUpdateDelete()
    }
  }

  /** Records a new last issue on its lock and returns how to restore the previous one, or null if it is the last one already. */
  private fun recordIssue(
    interval: Triple<Int, Long, Long>,
    slot: ByteArray,
    content: ByteArray,
  ): (() -> Unit)? {
    val lockSeq = Integer.toUnsignedLong(interval.first)
    val previous =
      database.rawQuery("SELECT slot, content FROM issues WHERE lock_seq = ?", arrayOf(lockSeq.toString())).use {
        if (it.moveToFirst()) it.getBlob(0) to it.getBlob(1) else null
      }
    if (previous != null) {
      val (lastSlot, lastContent) = previous
      if (lastSlot.contentEquals(slot)) {
        if (lastContent.contentEquals(content)) return null
        throw EquivocationException()
      }
      if (java.lang.Long.compareUnsigned(interval.second, checkNotNull(issueInterval(lastSlot)).third) < 0) throw OverIssuanceException()
    }
    replaceIssue(lockSeq, slot, content)
    return {
      if (previous == null) {
        database.delete("issues", "lock_seq = ?", arrayOf(lockSeq.toString()))
      } else {
        replaceIssue(lockSeq, previous.first, previous.second)
      }
    }
  }

  private fun replaceIssue(
    lockSeq: Long,
    slot: ByteArray,
    content: ByteArray,
  ) {
    val row =
      ContentValues().apply {
        put("lock_seq", lockSeq)
        put("slot", slot)
        put("content", content)
      }
    database.insertWithOnConflict("issues", null, row, SQLiteDatabase.CONFLICT_REPLACE)
  }

  private fun <T> transaction(block: () -> T): T {
    database.beginTransaction()
    try {
      return block().also { database.setTransactionSuccessful() }
    } finally {
      database.endTransaction()
    }
  }

  companion object {
    private const val JOURNAL_MODE = "TRUNCATE"
    private const val SYNCHRONOUS = "FULL"
    private const val SYNCHRONOUS_FULL = 2L
    private const val LOCKING_MODE = "EXCLUSIVE"
    private val SCHEMA =
      listOf(
        "CREATE TABLE IF NOT EXISTS guard (binding BLOB NOT NULL)",
        "CREATE TABLE IF NOT EXISTS spends (slot BLOB PRIMARY KEY, content BLOB NOT NULL) WITHOUT ROWID",
        "CREATE TABLE IF NOT EXISTS issues (lock_seq INTEGER PRIMARY KEY, slot BLOB NOT NULL, content BLOB NOT NULL)",
      )
    private val ISSUE_TAG = "ISSU".toByteArray(Charsets.US_ASCII)

    // Admissions are serialised across every guard in the process, so a removal never races another admission.
    private val ADMISSIONS = Any()

    /** What a guard is bound to: one device key (its X.509 encoding) and one note domain. */
    fun binding(
      publicKey: ByteArray,
      noteDomain: ByteArray,
    ): ByteArray =
      MessageDigest.getInstance("SHA-256").run {
        update(publicKey)
        update(noteDomain)
        digest()
      }

    /**
     * Creates an empty guard in `file` bound to `binding` and syncs its directory; an existing guard
     * is kept if it is bound to `binding`, and refused otherwise.
     */
    fun create(
      file: File,
      binding: ByteArray,
      syncDirectory: (File) -> Unit,
    ) {
      database(file, create = true).use { database ->
        database.beginTransaction()
        try {
          SCHEMA.forEach(database::execSQL)
          val bound = bindingOf(database)
          if (bound == null) {
            database.insertOrThrow("guard", null, ContentValues().apply { put("binding", binding) })
          } else if (!bound.contentEquals(binding)) {
            throw NoteGuardUnavailableException("The note guard belongs to another key or domain")
          }
          database.setTransactionSuccessful()
        } finally {
          database.endTransaction()
        }
      }
      syncDirectory(requireNotNull(file.parentFile))
    }

    /** Opens the guard in `file`, which must exist and be bound to `binding`, under the process's `lock`. */
    fun open(
      file: File,
      binding: ByteArray,
      lock: GuardLock,
    ): NoteGuard {
      check(lock.isHeld) { "the guard lock is not held" }
      if (!file.exists()) throw NoteGuardUnavailableException("The note guard does not exist")
      val database = database(file, create = false)
      try {
        val bound =
          try {
            bindingOf(database)
          } catch (e: SQLiteException) {
            throw NoteGuardUnavailableException("The note guard cannot be read", e)
          }
        if (bound == null || !bound.contentEquals(binding)) {
          throw NoteGuardUnavailableException("The note guard belongs to another key or domain")
        }
        return NoteGuard(database)
      } catch (e: Throwable) {
        database.close()
        throw e
      }
    }

    /**
     * `(lock_seq, start, end)` of an issue slot, `"ISSU" ‖ lock_seq:u32 ‖ start:u64 ‖ end:u64 ‖ 0×8`
     * little-endian, or null for a spend slot. Only the exact layout counts as an issue, so a
     * spent output id ground to begin with the tag is still guarded as a spend.
     */
    fun issueInterval(slot: ByteArray): Triple<Int, Long, Long>? {
      val issue = slot.size == 32 && slot.copyOfRange(0, 4).contentEquals(ISSUE_TAG) && slot.copyOfRange(24, 32).all { it == 0.toByte() }
      if (!issue) return null
      val fields = ByteBuffer.wrap(slot).order(ByteOrder.LITTLE_ENDIAN)
      return Triple(fields.getInt(4), fields.getLong(8), fields.getLong(16))
    }

    private fun bindingOf(database: SQLiteDatabase): ByteArray? =
      database.rawQuery("SELECT binding FROM guard", null).use { if (it.moveToFirst()) it.getBlob(0) else null }

    /**
     * Opens `file` with a rollback journal and `synchronous=FULL`, so a committed record survives a
     * power loss, and keeps a database SQLite reports corrupt instead of deleting it. The connection
     * takes the database's exclusive lock and, in the exclusive locking mode, keeps it (and its
     * journal open) until it closes, so no other connection reads or writes the guard meanwhile.
     * Any failure closes the connection.
     */
    private fun database(
      file: File,
      create: Boolean,
    ): SQLiteDatabase {
      val database =
        try {
          connect(file, SQLiteDatabase.OPEN_READWRITE or if (create) SQLiteDatabase.CREATE_IF_NECESSARY else 0)
        } catch (e: SQLiteException) {
          throw NoteGuardUnavailableException("The note guard cannot be opened", e)
        }
      try {
        // Outside WAL the pool keeps one connection open, so the pragmas set on it stay applied.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
          DatabaseUtils.stringForQuery(database, "PRAGMA journal_mode=$JOURNAL_MODE", null)
          database.execSQL("PRAGMA synchronous=$SYNCHRONOUS")
        }
        DatabaseUtils.stringForQuery(database, "PRAGMA locking_mode=$LOCKING_MODE", null)
        val journalMode = DatabaseUtils.stringForQuery(database, "PRAGMA journal_mode", null)
        val synchronous = DatabaseUtils.longForQuery(database, "PRAGMA synchronous", null)
        val lockingMode = DatabaseUtils.stringForQuery(database, "PRAGMA locking_mode", null)
        val durable = journalMode.equals(JOURNAL_MODE, ignoreCase = true) && synchronous == SYNCHRONOUS_FULL
        if (!durable || !lockingMode.equals(LOCKING_MODE, ignoreCase = true)) {
          throw NoteGuardUnavailableException("The note guard cannot be written durably")
        }
        // An empty exclusive transaction takes the lock, which the locking mode then keeps.
        database.beginTransaction()
        database.endTransaction()
        return database
      } catch (e: Throwable) {
        database.close()
        if (e is SQLiteException) throw NoteGuardUnavailableException("The note guard cannot be opened", e)
        throw e
      }
    }

    private fun connect(
      file: File,
      flags: Int,
    ): SQLiteDatabase {
      val keep = DatabaseErrorHandler {}
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return SQLiteDatabase.openDatabase(file.path, null, flags, keep)
      val params =
        SQLiteDatabase.OpenParams
          .Builder()
          .setOpenFlags(flags)
          .setErrorHandler(keep)
          .setJournalMode(JOURNAL_MODE)
          .setSynchronousMode(SYNCHRONOUS)
          .build()
      return SQLiteDatabase.openDatabase(file, params)
    }
  }
}
