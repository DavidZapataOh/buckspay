package xyz.buckspay.nearby

import com.google.android.gms.nearby.connection.ConnectionType
import com.google.android.gms.nearby.connection.Strategy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OptionsTest {
  @Test
  fun everyOptionIsPointToPointLowPowerAndNonDisruptive() {
    val advertising = Options.advertising()
    assertEquals(Strategy.P2P_POINT_TO_POINT, advertising.strategy)
    assertTrue(advertising.lowPower)
    assertEquals(ConnectionType.NON_DISRUPTIVE, advertising.connectionType)
    val discovery = Options.discovery()
    assertEquals(Strategy.P2P_POINT_TO_POINT, discovery.strategy)
    assertTrue(discovery.lowPower)
    val connection = Options.connection()
    assertTrue(connection.lowPower)
    assertEquals(ConnectionType.NON_DISRUPTIVE, connection.connectionType)
  }
}
