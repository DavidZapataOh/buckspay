package xyz.buckspay.nearby

import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionOptions
import com.google.android.gms.nearby.connection.ConnectionType
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.Strategy

/**
 * Low power stays off so the advertisement carries the Bluetooth Classic address and the link can upgrade to Wi-Fi;
 * the non-disruptive connection type keeps Nearby from changing the phone's Wi-Fi or Bluetooth state. JavaScript
 * can set neither, only the mode, which picks the strategy: one peer for a payment, a star for a group session.
 */
internal object Options {
  private fun strategy(mode: Mode): Strategy =
    when (mode.topology) {
      Topology.PointToPoint -> Strategy.P2P_POINT_TO_POINT
      Topology.Star -> Strategy.P2P_STAR
    }

  fun advertising(mode: Mode): AdvertisingOptions =
    AdvertisingOptions
      .Builder()
      .setStrategy(strategy(mode))
      .setConnectionType(ConnectionType.NON_DISRUPTIVE)
      .build()

  fun discovery(mode: Mode): DiscoveryOptions =
    DiscoveryOptions
      .Builder()
      .setStrategy(strategy(mode))
      .build()

  fun connection(): ConnectionOptions =
    ConnectionOptions
      .Builder()
      .setConnectionType(ConnectionType.NON_DISRUPTIVE)
      .build()
}
