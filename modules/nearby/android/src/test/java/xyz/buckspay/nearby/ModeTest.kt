package xyz.buckspay.nearby

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ModeTest {
  @Test
  fun missingNameIsPayAndKnownNamesParse() {
    assertEquals(Mode.Pay, Mode.parse(null))
    assertEquals(Mode.Pay, Mode.parse("pay"))
    assertEquals(Mode.Group, Mode.parse("group"))
    assertEquals(Mode.GroupSequential, Mode.parse("groupSequential"))
  }

  @Test
  fun unknownNameIsRefused() {
    assertThrows(NearbyException::class.java) { Mode.parse("star") }
  }

  @Test
  fun payAndGroupDoNotShareAServiceIdButGroupModesDo() {
    assertNotEquals(Mode.Pay.serviceId, Mode.Group.serviceId)
    assertEquals(Mode.Group.serviceId, Mode.GroupSequential.serviceId)
    assertEquals(Topology.Star, Mode.Group.topology)
    assertEquals(Topology.PointToPoint, Mode.Pay.topology)
    assertEquals(Topology.PointToPoint, Mode.GroupSequential.topology)
  }
}
