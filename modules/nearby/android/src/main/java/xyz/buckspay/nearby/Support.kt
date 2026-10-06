package xyz.buckspay.nearby

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability

/** The runtime permissions Nearby needs on this Android version; location only where Android still ties scanning to it. */
internal fun requiredPermissions(sdk: Int): List<String> =
  when {
    sdk >= Build.VERSION_CODES.TIRAMISU -> {
      listOf(
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_ADVERTISE,
        Manifest.permission.BLUETOOTH_CONNECT,
        Manifest.permission.NEARBY_WIFI_DEVICES,
      )
    }

    sdk >= Build.VERSION_CODES.S_V2 -> {
      listOf(
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_ADVERTISE,
        Manifest.permission.BLUETOOTH_CONNECT,
      )
    }

    sdk == Build.VERSION_CODES.S -> {
      listOf(
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_ADVERTISE,
        Manifest.permission.BLUETOOTH_CONNECT,
        Manifest.permission.ACCESS_FINE_LOCATION,
      )
    }

    sdk >= Build.VERSION_CODES.Q -> {
      listOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

    else -> {
      listOf(Manifest.permission.ACCESS_COARSE_LOCATION)
    }
  }

internal fun support(context: Context): Map<String, Boolean> {
  val sdk = Build.VERSION.SDK_INT
  val playServices = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
  val permissions =
    requiredPermissions(sdk).all {
      ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }
  val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
  val location = context.getSystemService(LocationManager::class.java)
  val locationReady = sdk >= Build.VERSION_CODES.S || (location != null && LocationManagerCompat.isLocationEnabled(location))
  return mapOf(
    "playServices" to playServices,
    "permissions" to permissions,
    "bluetooth" to (adapter?.isEnabled == true && locationReady),
  )
}
