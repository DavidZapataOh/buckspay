package xyz.buckspay.hardwarekeys

import android.database.DatabaseUtils
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteDatabaseLockedException
import android.os.Debug
import android.system.Os
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.OverlappingFileLockException
import java.security.MessageDigest
import kotlin.random.Random

@RunWith(AndroidJUnit4::class)
class NoteGuardTest {
  @get:Rule val folder = TemporaryFolder()

  private val file by lazy { File(folder.root, "notes") }
  private val lockFile by lazy { File(folder.root, "notes.lock") }
  private val journal by lazy { File(folder.root, "notes-journal") }
  private val binding = ByteArray(32) { 5 }
  private val synced = mutableListOf<File>()
  private val a = ByteArray(32) { 1 }
  private val b = ByteArray(32) { 2 }
  private val slot = ByteArray(32) { 9 }
  private var lock: GuardLock? = null

  @After
  fun release() {
    lock?.close()
  }

  private fun lock() = lock ?: GuardLock.acquire(lockFile).also { lock = it }

  private fun open(): NoteGuard {
    NoteGuard.create(file, binding, synced::add)
    return NoteGuard.open(file, binding, lock())
  }

  private fun NoteGuard.admit(
    slot: ByteArray,
    content: ByteArray,
  ) = admit(slot, content) {}

  @Test
  fun signsASpendSlotWithOneContentOnly() {
    open().use { guard ->
      guard.admit(slot, a)
      guard.admit(slot, a)
      assertThrows(EquivocationException::class.java) { guard.admit(slot, b) }
      guard.admit(ByteArray(32) { 8 }, b)
      assertEquals(2L, guard.size)
    }
    assertEquals("ERR_EQUIVOCATION", EquivocationException().code)
  }

  @Test
  fun issuesOnlyAfterTheLastIssueOnTheLock() {
    open().use { guard ->
      guard.admit(issue(1, 0, 100), a)
      guard.admit(issue(1, 100, 150), b)
      guard.admit(issue(1, 100, 150), b)
      assertThrows(EquivocationException::class.java) { guard.admit(issue(1, 100, 150), a) }
      assertThrows(OverIssuanceException::class.java) { guard.admit(issue(1, 149, 200), a) }
      assertThrows(OverIssuanceException::class.java) { guard.admit(issue(1, 20, 30), a) }
      assertThrows(OverIssuanceException::class.java) { guard.admit(issue(1, 0, 100), a) }
      guard.admit(issue(2, 0, 100), a)
      guard.admit(issue(1, 300, 400), a)
      assertThrows(OverIssuanceException::class.java) { guard.admit(issue(1, 200, 250), a) }
    }
    assertEquals("ERR_OVER_ISSUANCE", OverIssuanceException().code)
  }

  @Test
  fun comparesLocksAndIntervalsAsUnsignedIntegers() {
    open().use { guard ->
      guard.admit(issue(0, 1L shl 63, -2L), a)
      assertThrows(OverIssuanceException::class.java) { guard.admit(issue(0, 5, 10), a) }
      guard.admit(issue(0, -2L, -1L), a)
      guard.admit(issue(-1, 0, 10), a)
      guard.admit(issue(Int.MAX_VALUE, 0, 10), a)
    }
    open().use { restarted ->
      assertThrows(OverIssuanceException::class.java) { restarted.admit(issue(-1, 5, 20), a) }
      assertThrows(OverIssuanceException::class.java) { restarted.admit(issue(Int.MAX_VALUE, 5, 20), a) }
      restarted.admit(issue(-1, 10, 20), a)
    }
  }

  @Test
  fun refusesAnEmptyIntervalOrAPartThatIsNot32Bytes() {
    open().use { guard ->
      assertThrows(IllegalArgumentException::class.java) { guard.admit(issue(1, 5, 5), a) }
      assertThrows(IllegalArgumentException::class.java) { guard.admit(issue(1, 6, 5), a) }
      assertThrows(IllegalArgumentException::class.java) { guard.admit(a, ByteArray(31)) }
      assertThrows(IllegalArgumentException::class.java) { guard.admit(ByteArray(33), a) }
      assertEquals(0L, guard.size)
    }
  }

  @Test
  fun guardsASlotWithTheIssueTagButNotItsLayoutAsASpend() {
    val ground = issue(1, 0, 100).also { it[31] = 1 }
    assertNull(NoteGuard.issueInterval(ground))
    open().use { guard ->
      guard.admit(issue(1, 0, 100), a)
      guard.admit(ground, a)
      assertThrows(EquivocationException::class.java) { guard.admit(ground, b) }
    }
  }

  @Test
  fun keepsEverySpendAndTheLastIssueOfEachLockAcrossRestarts() {
    open().use { guard ->
      guard.admit(slot, a)
      guard.admit(issue(1, 0, 100), a)
      guard.admit(issue(1, 100, 200), b)
      guard.admit(issue(2, 0, 100), a)
    }
    open().use { restarted ->
      assertEquals(3L, restarted.size)
      restarted.admit(slot, a)
      restarted.admit(issue(1, 100, 200), b)
      assertThrows(EquivocationException::class.java) { restarted.admit(slot, b) }
      assertThrows(OverIssuanceException::class.java) { restarted.admit(issue(1, 0, 100), a) }
      assertThrows(OverIssuanceException::class.java) { restarted.admit(issue(2, 50, 150), b) }
    }
  }

  @Test
  fun keepsTheExpiryOfEveryOutputAcrossRestarts() {
    open().use { guard ->
      assertNull(guard.expiryOf(a))
      guard.recordOutput(a, 1_900_000_000)
      guard.recordOutput(b, 0xffff_ffffL)
      guard.recordOutput(a, 1_900_000_000)
    }
    open().use { guard ->
      assertEquals(1_900_000_000L, guard.expiryOf(a))
      assertEquals(0xffff_ffffL, guard.expiryOf(b))
      assertNull(guard.expiryOf(slot))
    }
  }

  @Test
  fun refusesAnOutputThatIsNot32BytesOrAnExpiryThatIsNotAU32() {
    open().use { guard ->
      assertThrows(IllegalArgumentException::class.java) { guard.recordOutput(ByteArray(31), 1) }
      assertThrows(IllegalArgumentException::class.java) { guard.recordOutput(a, -1) }
      assertThrows(IllegalArgumentException::class.java) { guard.recordOutput(a, 0x1_0000_0000L) }
      assertNull(guard.expiryOf(a))
    }
  }

  @Test
  fun aGuardMadeBeforeOutputsWereKeptGetsTheirTableWhenItIsOpened() {
    open().close()
    SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE).use { it.execSQL("DROP TABLE outputs") }
    open().use { guard ->
      guard.recordOutput(a, 5)
      assertEquals(5L, guard.expiryOf(a))
    }
  }

  @Test
  fun forgetsARecordWhoseSignatureFailed() {
    open().use { guard ->
      guard.admit(issue(1, 0, 100), a)
      assertThrows(IllegalStateException::class.java) { guard.admit(slot, a) { error("Keystore failed") } }
      assertThrows(IllegalStateException::class.java) { guard.admit(issue(1, 100, 200), a) { error("Keystore failed") } }
      assertThrows(IllegalStateException::class.java) { guard.admit(issue(2, 0, 100), a) { error("Keystore failed") } }
      assertEquals(1L, guard.size)
      guard.admit(slot, b)
      guard.admit(issue(1, 0, 100), a)
      guard.admit(issue(1, 100, 150), b)
      guard.admit(issue(2, 50, 100), b)
    }
    open().use { assertEquals(3L, it.size) }
  }

  @Test
  fun keepsARecordItCannotRemove() {
    val guard = open()
    val failed =
      assertThrows(IllegalStateException::class.java) {
        guard.admit(slot, a) {
          guard.close()
          error("Keystore failed")
        }
      }
    assertEquals(1, failed.suppressed.size)
    open().use { restarted ->
      assertThrows(EquivocationException::class.java) { restarted.admit(slot, b) }
      restarted.admit(slot, a)
    }
  }

  @Test
  fun signsNothingOnceItsJournalIsGone() {
    val other = ByteArray(32) { 8 }
    open().use { guard ->
      guard.admit(slot, a)
      assertTrue(journal.delete())
      var signed = false
      assertThrows(NoteGuardUnavailableException::class.java) { guard.admit(other, a) { signed = true } }
      assertFalse(signed)
      assertThrows(NoteGuardUnavailableException::class.java) { guard.admit(slot, a) { signed = true } }
      assertFalse(signed)
    }
    open().use { restarted ->
      assertThrows(EquivocationException::class.java) { restarted.admit(slot, b) }
      restarted.admit(other, b)
    }
  }

  @Test
  fun signsOnlyWhatItRecordedWhereItCannotCreateAJournal() {
    val other = ByteArray(32) { 8 }
    open().use { guard ->
      guard.admit(slot, a)
    }
    assertTrue(journal.delete())
    var signed = false
    val unavailable =
      open().use { guard ->
        assertTrue(folder.root.setWritable(false))
        try {
          runCatching { guard.admit(other, a) { signed = true } }.exceptionOrNull()
        } finally {
          folder.root.setWritable(true)
        }
      }
    // Where SQLite needs a journal (ext4) the spend is refused; F2FS commits it atomically with none.
    if (signed) assertNull(unavailable) else assertTrue(unavailable is NoteGuardUnavailableException)
    open().use { restarted ->
      if (signed) assertThrows(EquivocationException::class.java) { restarted.admit(other, b) } else restarted.admit(other, b)
    }
  }

  @Test
  fun refusesAGuardItCannotWrite() {
    NoteGuard.create(file, binding, synced::add)
    assertTrue(file.setReadOnly())
    try {
      assertThrows(NoteGuardUnavailableException::class.java) { NoteGuard.open(file, binding, lock()) }
    } finally {
      assertTrue(file.setWritable(true))
    }
    open().use { it.admit(slot, a) }
  }

  @Test
  fun excludesEveryOtherConnectionWhileOpen() {
    open().use { guard ->
      guard.admit(slot, a)
      val unavailable = NoteGuardUnavailableException::class.java
      assertThrows(unavailable) { NoteGuard.open(file, binding, lock()) }
      assertThrows(unavailable) { NoteGuard.create(file, binding, synced::add) }
      assertThrows(SQLiteDatabaseLockedException::class.java) {
        SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { DatabaseUtils.queryNumEntries(it, "spends") }
      }
      guard.admit(issue(1, 0, 100), a)
    }
    open().use { reopened ->
      assertThrows(EquivocationException::class.java) { reopened.admit(slot, b) }
      assertThrows(OverIssuanceException::class.java) { reopened.admit(issue(1, 50, 150), b) }
    }
  }

  @Test
  fun failsClosedAndLetsGoWhenAnotherConnectionHoldsTheDatabase() {
    NoteGuard.create(file, binding, synced::add)
    SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE).use { other ->
      other.beginTransactionNonExclusive()
      assertThrows(NoteGuardUnavailableException::class.java) { NoteGuard.open(file, binding, lock()) }
      assertThrows(NoteGuardUnavailableException::class.java) { NoteGuard.create(file, binding, synced::add) }
      other.endTransaction()
    }
    open().use { it.admit(slot, a) }
  }

  @Test
  fun isCreatedDurablyAndBoundToOneKeyAndDomain() {
    NoteGuard.create(file, binding, synced::add)
    assertEquals(listOf(folder.root), synced)
    NoteGuard.create(file, binding, synced::add)
    val unavailable = NoteGuardUnavailableException::class.java
    assertThrows(unavailable) { NoteGuard.create(file, ByteArray(32), synced::add) }
    assertThrows(unavailable) { NoteGuard.open(file, ByteArray(32), lock()) }
    NoteGuard.open(file, binding, lock()).close()
    assertThrows(unavailable) { NoteGuard.open(File(folder.root, "missing"), binding, lock()) }
    assertFalse(File(folder.root, "missing").exists())
    assertEquals("ERR_NOTE_GUARD_UNAVAILABLE", NoteGuardUnavailableException("").code)
  }

  @Test
  fun keepsAGuardItCannotRead() {
    val garbage = ByteArray(4096) { 0x5a }
    file.writeBytes(garbage)
    assertThrows(NoteGuardUnavailableException::class.java) { NoteGuard.open(file, binding, lock()) }
    assertThrows(NoteGuardUnavailableException::class.java) { NoteGuard.create(file, binding, synced::add) }
    assertArrayEquals(garbage, file.readBytes())
  }

  @Test
  fun isUsedByOneProcessThroughALockFileItNeverReplaces() {
    val early = RandomAccessFile(lockFile, "rw").channel
    val inode = Os.stat(lockFile.path).st_ino
    try {
      open().use { it.admit(slot, a) }
      open().use { it.admit(slot, a) }
      assertEquals(inode, Os.stat(lockFile.path).st_ino)
      assertThrows(OverlappingFileLockException::class.java) { early.tryLock() }
      assertThrows(NoteGuardUnavailableException::class.java) { GuardLock.acquire(lockFile) }
      lock?.close()
      assertThrows(IllegalStateException::class.java) { NoteGuard.open(file, binding, checkNotNull(lock)) }
      checkNotNull(early.tryLock()).release()
    } finally {
      early.close()
    }
    assertEquals(inode, Os.stat(lockFile.path).st_ino)
  }

  @Test
  fun bindsToTheKeyAndTheNoteDomain() {
    val key = ByteArray(91) { 1 }
    val domain = ByteArray(32) { 2 }
    assertArrayEquals(MessageDigest.getInstance("SHA-256").digest(key + domain), NoteGuard.binding(key, domain))
  }

  @Test
  fun measuresTheNoteGuard() {
    val records = InstrumentationRegistry.getArguments().getString("guarded")?.toInt() ?: GUARDED
    val random = Random(7)
    val signed = ArrayList<ByteArray>()
    NoteGuard.create(file, binding) {}
    val started = System.nanoTime()
    SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE).use { database ->
      database.beginTransaction()
      database.compileStatement("INSERT INTO spends (slot, content) VALUES (?, ?)").use { insert ->
        repeat(records) { i ->
          val spent = random.nextBytes(32)
          if (i % (records / MEASURED) == 0) signed.add(spent)
          insert.bindBlob(1, spent)
          insert.bindBlob(2, a)
          insert.executeInsert()
        }
      }
      database.setTransactionSuccessful()
      database.endTransaction()
    }
    val filled = (System.nanoTime() - started) / 1_000_000
    Runtime.getRuntime().gc()
    val before = memory()
    NoteGuard.open(file, binding, lock()).use { guard ->
      val lookups = signed.map { timed { guard.admit(it, a) } }
      val inserts = List(MEASURED) { random.nextBytes(32) }.map { timed { guard.admit(it, a) } }
      Runtime.getRuntime().gc()
      val after = memory()
      val total = records + MEASURED
      val bytes = file.length()
      Log.i(
        TAG,
        "note guard: $total spends in $bytes bytes (${bytes / total} B each, filled in $filled ms), " +
          "lookup ${percentiles(lookups)}, insert ${percentiles(inserts)}, " +
          "memory before open $before, after ${lookups.size + inserts.size} admissions $after",
      )
      assertTrue(bytes < total * 200L)
    }
  }

  private fun memory(): String {
    val runtime = Runtime.getRuntime()
    val heap = (runtime.totalMemory() - runtime.freeMemory()) / 1024
    val native = Debug.getNativeHeapAllocatedSize() / 1024
    return "heap $heap KB, native $native KB, PSS ${Debug.getPss()} KB"
  }

  private fun timed(block: () -> Unit): Double {
    val started = System.nanoTime()
    block()
    return (System.nanoTime() - started) / 1_000_000.0
  }

  private fun percentiles(millis: List<Double>): String {
    val sorted = millis.sorted()
    return "p50 ${"%.2f".format(sorted[sorted.size / 2])} ms, p95 ${"%.2f".format(sorted[sorted.size * 95 / 100])} ms"
  }

  private fun issue(
    lockSeq: Int,
    start: Long,
    end: Long,
  ): ByteArray =
    ByteBuffer
      .allocate(32)
      .order(ByteOrder.LITTLE_ENDIAN)
      .put("ISSU".toByteArray(Charsets.US_ASCII))
      .putInt(lockSeq)
      .putLong(start)
      .putLong(end)
      .array()

  private companion object {
    const val TAG = "NoteGuardTest"
    const val GUARDED = 100_000
    const val MEASURED = 1_000
  }
}
