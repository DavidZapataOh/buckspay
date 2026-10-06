package xyz.buckspay.mesh

import java.nio.ByteBuffer
import java.security.MessageDigest

private const val BEACON_DEDUPE_MS = 20_000L

internal class ScannedFrame(
  val bytes: ByteArray,
  val rssi: Int,
  val address: String = "",
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
    address: String = "",
  ) {
    val now = clock()
    val key = ByteBuffer.wrap(MessageDigest.getInstance("SHA-256").digest(bytes))
    val last = seen[key]
    // A beacon is repeated sooner: a phone in range is one seen in the last minute.
    val window = if (bytes.firstOrNull() == BEACON_KIND) BEACON_DEDUPE_MS else dedupeMs
    if (last != null && now - last < window) return
    seen[key] = now
    if (batch.isEmpty()) batchStart = now
    batch.add(ScannedFrame(bytes, rssi, address))
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
