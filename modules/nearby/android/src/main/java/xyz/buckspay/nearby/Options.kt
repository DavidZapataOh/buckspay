package xyz.buckspay.nearby

import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionOptions
import com.google.android.gms.nearby.connection.ConnectionType
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.Strategy

/**
 * Low power keeps the advertisement on BLE, without the Bluetooth Classic address; the non-disruptive
 * connection type keeps Nearby from changing the phone's Wi-Fi or Bluetooth state. JavaScript can set neither.
 */
internal object Options {
  const val SERVICE_ID = "xyz.buckspay.pay"

  private val strategy = Strategy.P2P_POINT_TO_POINT

  fun advertising(): AdvertisingOptions =
    AdvertisingOptions
      .Builder()
      .setStrategy(strategy)
      .setConnectionType(ConnectionType.NON_DISRUPTIVE)
      .build()

  fun discovery(): DiscoveryOptions =
    DiscoveryOptions
      .Builder()
      .setStrategy(strategy)
      .build()

  fun connection(): ConnectionOptions =
    ConnectionOptions
      .Builder()
      .setConnectionType(ConnectionType.NON_DISRUPTIVE)
      .build()
}
