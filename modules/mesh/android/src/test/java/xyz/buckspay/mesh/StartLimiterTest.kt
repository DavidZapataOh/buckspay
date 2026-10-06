package xyz.buckspay.mesh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StartLimiterTest {
  @Test
  fun allowsThreeStartsPerThirtySeconds() {
    var now = 0L
    val limiter = StartLimiter(maxStarts = 3, windowMs = 30_000) { now }
    repeat(3) { assertTrue(limiter.tryStart()) }
    assertFalse(limiter.tryStart())
    now = 29_999
    assertFalse(limiter.tryStart())
    now = 30_000
    assertFalse(limiter.tryStart())
    now = 30_001
    assertTrue(limiter.tryStart())
  }

  @Test
  fun delayUntilNextStartIsReported() {
    var now = 0L
    val limiter = StartLimiter(3, 30_000) { now }
    repeat(3) {
      limiter.tryStart()
      now += 1_000
    }
    assertEquals(27_001L, limiter.msUntilNextStart())
  }

  @Test
  fun noDelayWhileStartsRemain() {
    val limiter = StartLimiter(3, 30_000) { 0L }
    limiter.tryStart()
    assertEquals(0L, limiter.msUntilNextStart())
  }

  @Test
  fun countsTheStartsInTheWindow() {
    var now = 0L
    val limiter = StartLimiter(3, 30_000) { now }
    limiter.tryStart()
    now = 10_000
    limiter.tryStart()
    assertEquals(2, limiter.recentStarts())
    now = 30_001
    assertEquals(1, limiter.recentStarts())
  }
}
