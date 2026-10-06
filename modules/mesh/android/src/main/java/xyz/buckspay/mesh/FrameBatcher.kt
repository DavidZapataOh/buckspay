package xyz.buckspay.mesh

import java.nio.ByteBuffer
import java.security.MessageDigest

internal class ScannedFrame(
  val bytes: ByteArray,
  val rssi: Int,
)

/** Collects scanned frames into batches for the JavaScript task, dropping a frame already seen recently. Single-threaded. */
internal class FrameBatcher(
  private val maxFrames: Int,
  private val maxDelayMs: Long,
  private val dedupeMs: Long,
  private val clock: () -> Long,
  private val flush: (List<ScannedFrame>) -> Unit,
) {
  private val seen = HashMap<ByteBuffer, Long>()
  private var batch = ArrayList<ScannedFrame>()
  private var batchStart = 0L

  fun add(
    bytes: ByteArray,
    rssi: Int,
  ) {
    val now = clock()
    val key = ByteBuffer.wrap(MessageDigest.getInstance("SHA-256").digest(bytes))
    val last = seen[key]
    if (last != null && now - last < dedupeMs) return
    seen[key] = now
    if (batch.isEmpty()) batchStart = now
    batch.add(ScannedFrame(bytes, rssi))
    if (batch.size >= maxFrames) flushNow(now)
  }

  fun tick(now: Long) {
    if (batch.isNotEmpty() && now - batchStart >= maxDelayMs) flushNow(now)
  }

  private fun flushNow(now: Long) {
    seen.values.removeAll { now - it >= dedupeMs }
    val out = batch
    batch = ArrayList()
    flush(out)
  }
}
