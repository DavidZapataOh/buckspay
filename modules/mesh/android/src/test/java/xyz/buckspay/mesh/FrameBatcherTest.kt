package xyz.buckspay.mesh

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class FrameBatcherTest {
  @Test
  fun dropsDuplicatesWithinSixtySecondsAndFlushesAtSixteen() {
    var now = 0L
    val out = mutableListOf<List<ByteArray>>()
    val batcher =
      FrameBatcher(maxFrames = 16, maxDelayMs = 2_000, dedupeMs = 60_000, clock = { now }) {
        out += it.map { frame -> frame.bytes }
      }
    batcher.add(byteArrayOf(2, 1), -50)
    batcher.add(byteArrayOf(2, 1), -40)
    repeat(15) { i -> batcher.add(byteArrayOf(3, i.toByte()), -60) }
    assertEquals(1, out.size)
    assertEquals(16, out[0].size)
    now = 61_000
    batcher.add(byteArrayOf(2, 1), -50)
    batcher.tick(now + 2_000)
    assertEquals(2, out.size)
  }

  @Test
  fun keepsTheStrongestFirstRssiAndTheFramesInOrder() {
    var now = 0L
    val out = mutableListOf<List<ScannedFrame>>()
    val batcher = FrameBatcher(16, 2_000, 60_000, { now }) { out += it }
    batcher.add(byteArrayOf(3), -70)
    batcher.add(byteArrayOf(2), -55)
    now = 2_000
    batcher.tick(now)
    assertEquals(listOf(-70, -55), out[0].map { it.rssi })
    assertArrayEquals(byteArrayOf(2), out[0][1].bytes)
  }

  @Test
  fun doesNotFlushBeforeTheDelayOrWhenEmpty() {
    var now = 0L
    var flushes = 0
    val batcher = FrameBatcher(16, 2_000, 60_000, { now }) { flushes++ }
    batcher.tick(5_000)
    batcher.add(byteArrayOf(3), 0)
    batcher.tick(1_999)
    assertEquals(0, flushes)
    batcher.tick(2_000)
    assertEquals(1, flushes)
  }

  @Test
  fun aDuplicateOfAnEarlierBatchStaysDroppedUntilTheWindowEnds() {
    var now = 0L
    var flushes = 0
    val batcher = FrameBatcher(1, 2_000, 60_000, { now }) { flushes++ }
    batcher.add(byteArrayOf(3), 0)
    now = 59_999
    batcher.add(byteArrayOf(3), 0)
    assertEquals(1, flushes)
    now = 60_000
    batcher.add(byteArrayOf(3), 0)
    assertEquals(2, flushes)
  }

  @Test
  fun theDelayRunsFromTheFirstFrameOfTheBatch() {
    var now = 0L
    var flushes = 0
    val batcher = FrameBatcher(16, 2_000, 60_000, { now }) { flushes++ }
    batcher.add(byteArrayOf(3), 0)
    now = 1_500
    batcher.add(byteArrayOf(2), 0)
    batcher.tick(2_000)
    assertEquals(1, flushes)
  }

  @Test
  fun theDedupeWindowRunsFromTheTimeTheFrameWasSeen() {
    var now = 10_000L
    var flushes = 0
    val batcher = FrameBatcher(1, 2_000, 60_000, { now }) { flushes++ }
    batcher.add(byteArrayOf(3), 0)
    now = 69_999
    batcher.add(byteArrayOf(3), 0)
    assertEquals(1, flushes)
  }

  @Test
  fun repeatsABeaconSoonerThanOtherFrames() {
    var now = 0L
    val out = mutableListOf<List<ScannedFrame>>()
    val batcher = FrameBatcher(16, 2_000, 60_000, { now }) { out += it }
    batcher.add(byteArrayOf(1, 9), -50, "a")
    batcher.add(byteArrayOf(2, 9), -50, "a")
    now = 21_000
    batcher.add(byteArrayOf(1, 9), -50, "a")
    batcher.add(byteArrayOf(2, 9), -50, "a")
    batcher.tick(now + 2_000)
    assertEquals(listOf(1, 2, 1), out.flatten().map { it.bytes[0].toInt() })
    assertEquals("a", out[0][0].address)
  }
}
