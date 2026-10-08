package xyz.buckspay.nearby

import com.google.android.gms.nearby.connection.ConnectionType
import com.google.android.gms.nearby.connection.Strategy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class OptionsTest {
  @Test
  fun everyOptionIsPointToPointFullPowerAndNonDisruptive() {
    val advertising = Options.advertising()
    assertEquals(Strategy.P2P_POINT_TO_POINT, advertising.strategy)
    assertFalse(advertising.lowPower)
    assertEquals(ConnectionType.NON_DISRUPTIVE, advertising.connectionType)
    val discovery = Options.discovery()
    assertEquals(Strategy.P2P_POINT_TO_POINT, discovery.strategy)
    assertFalse(discovery.lowPower)
    val connection = Options.connection()
    assertFalse(connection.lowPower)
    assertEquals(ConnectionType.NON_DISRUPTIVE, connection.connectionType)
  }
}
