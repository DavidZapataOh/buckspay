package xyz.buckspay.mesh

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import java.util.UUID

/** The service-data UUID every mesh frame is advertised under; `MESH_SERVICE_UUID` in `src/features/mesh/frame.ts` is the same value. */
internal val SERVICE_UUID: UUID = UUID.fromString("7c2f1d3a-5b8e-4f60-9a47-2e6d0b9c81f5")

/** Bytes a service-data entry spends before the frame: length, type and the 128-bit UUID. */
internal const val SERVICE_DATA_OVERHEAD = 18

internal const val LEGACY_ADVERTISING_BYTES = 31

/** A failure JavaScript maps to a `MeshError`; the code is one of its `MeshErrorCode` values. */
internal class MeshException(
  code: String,
) : CodedException(code, code, null)

internal fun adapterOf(context: Context): BluetoothAdapter? = context.getSystemService(BluetoothManager::class.java)?.adapter

internal fun maxAdvertisingBytes(adapter: BluetoothAdapter): Int =
  if (adapter.isLeExtendedAdvertisingSupported) adapter.leMaximumAdvertisingDataLength else LEGACY_ADVERTISING_BYTES

internal object MeshPrefs {
  private const val FILE = "mesh"
  private const val ENABLED = "enabled"

  fun isEnabled(context: Context): Boolean = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean(ENABLED, false)

  fun setEnabled(
    context: Context,
    enabled: Boolean,
  ) = context
    .getSharedPreferences(FILE, Context.MODE_PRIVATE)
    .edit()
    .putBoolean(ENABLED, enabled)
    .apply()

  /** The mesh runs on Android 12 and later, where Bluetooth permissions replace location. */
  fun supported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

  fun canRun(context: Context): Boolean =
    supported() &&
      listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT)
        .all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
}
