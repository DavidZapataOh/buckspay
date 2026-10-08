package xyz.buckspay.hardwarekeys

import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import java.io.Closeable

/**
 * The tab states and netting joins the device key has signed, kept for good in the key's guard
 * database so that it never signs two bodies for one slot. It shares the note guard's file, admission
 * lock and journal check, and has a table of its own: an IOU slot never collides with a note slot.
 */
internal class IouGuard internal constructor(
  private val database: SQLiteDatabase,
  private val requireJournal: () -> Unit,
) : Closeable {
  private val held = database.compileStatement("SELECT coalesce((SELECT content = ? FROM ious WHERE slot = ?), -1)")
  private val insert = database.compileStatement("INSERT INTO ious (slot, content) VALUES (?, ?)")
  private val delete = database.compileStatement("DELETE FROM ious WHERE slot = ?")

  /**
   * Runs `sign` if `slot` is new (recorded first, removed again if `sign` throws) or already holds
   * `content`; `EquivocationException` otherwise.
   */
  fun <T> admit(
    slot: ByteArray,
    content: ByteArray,
    sign: () -> T,
  ): T {
    require(slot.size == 32 && content.size == 32) { "slot and content are 32 bytes" }
    synchronized(NoteGuard.ADMISSIONS) {
      requireJournal()
      val recorded =
        try {
          database.inTransaction { record(slot, content) }
        } catch (e: SQLiteException) {
          throw NoteGuardUnavailableException("The note guard cannot record this slot", e)
        }
      requireJournal()
      if (!recorded) return sign()
      try {
        return sign()
      } catch (e: Throwable) {
        try {
          database.inTransaction {
            delete.bindBlob(1, slot)
            delete.executeUpdateDelete()
          }
        } catch (removal: Exception) {
          e.addSuppressed(removal)
        }
        throw e
      }
    }
  }

  /** Records a new slot and returns true, or false if it already holds `content`. */
  private fun record(
    slot: ByteArray,
    content: ByteArray,
  ): Boolean {
    held.bindBlob(1, content)
    held.bindBlob(2, slot)
    when (held.simpleQueryForLong()) {
      1L -> return false
      0L -> throw EquivocationException()
    }
    insert.bindBlob(1, slot)
    insert.bindBlob(2, content)
    insert.executeInsert()
    return true
  }

  override fun close() {
    listOf(held, insert, delete).forEach { it.close() }
  }
}
