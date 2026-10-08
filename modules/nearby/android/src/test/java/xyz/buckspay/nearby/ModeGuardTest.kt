package xyz.buckspay.nearby

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModeGuardTest {
  @Test
  fun aSecondModeIsRefusedWhileOneIsActive() {
    val guard = ModeGuard()
    assertTrue(guard.enter(Mode.Pay))
    assertTrue(guard.enter(Mode.Pay))
    assertFalse(guard.enter(Mode.Group))
    assertFalse(guard.enter(Mode.GroupSequential))
    assertEquals(Mode.Pay, guard.active)
  }

  @Test
  fun leavingFreesTheGuardForAnotherMode() {
    val guard = ModeGuard()
    assertTrue(guard.enter(Mode.Group))
    guard.leave()
    assertNull(guard.active)
    assertTrue(guard.enter(Mode.Pay))
  }
}
