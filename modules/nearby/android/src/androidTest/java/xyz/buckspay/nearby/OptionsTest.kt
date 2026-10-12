package xyz.buckspay.nearby

import com.google.android.gms.nearby.connection.ConnectionType
import com.google.android.gms.nearby.connection.Strategy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class OptionsTest {
  private fun assertFullPowerNonDisruptive(
    mode: Mode,
    strategy: Strategy,
  ) {
    val advertising = Options.advertising(mode)
    assertEquals(strategy, advertising.strategy)
    assertFalse(advertising.lowPower)
    assertEquals(ConnectionType.NON_DISRUPTIVE, advertising.connectionType)
    val discovery = Options.discovery(mode)
    assertEquals(strategy, discovery.strategy)
    assertFalse(discovery.lowPower)
  }

  @Test
  fun payOptionsArePointToPointFullPowerAndNonDisruptive() = assertFullPowerNonDisruptive(Mode.Pay, Strategy.P2P_POINT_TO_POINT)

  @Test
  fun groupOptionsAreStarFullPowerAndNonDisruptive() = assertFullPowerNonDisruptive(Mode.Group, Strategy.P2P_STAR)

  @Test
  fun sequentialGroupOptionsArePointToPoint() = assertFullPowerNonDisruptive(Mode.GroupSequential, Strategy.P2P_POINT_TO_POINT)

  @Test
  fun connectionOptionsAreUnchanged() {
    val connection = Options.connection()
    assertFalse(connection.lowPower)
    assertEquals(ConnectionType.NON_DISRUPTIVE, connection.connectionType)
  }
}
