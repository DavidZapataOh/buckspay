package xyz.buckspay.mesh

import android.bluetooth.BluetoothAdapter
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.os.ParcelUuid
import android.util.Log
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

private const val TAG = "MeshScanner"
private const val RESTART_MS = 25 * 60_000L

/** One long-lived scan filtered on the mesh UUID, so it keeps delivering with the screen off. All state lives on `executor`. */
internal class Scanner(
  private val adapter: BluetoothAdapter,
  private val limiter: StartLimiter,
  private val executor: ScheduledExecutorService,
  private val onFrame: (ByteArray, Int, String) -> Unit,
) {
  private var running = false
  private var screenOn = true
  private var scanning = false
  private var restart: ScheduledFuture<*>? = null
  private val uuid = ParcelUuid(SERVICE_UUID)

  private val callback =
    object : ScanCallback() {
      override fun onScanResult(
        callbackType: Int,
        result: ScanResult,
      ) {
        val frame = result.scanRecord?.getServiceData(uuid) ?: return
        val rssi = result.rssi
        val address = result.device.address
        executor.execute { onFrame(frame, rssi, address) }
      }

      override fun onScanFailed(errorCode: Int) {
        Log.w(TAG, "scan failed: $errorCode")
        executor.execute { scanning = false }
      }
    }

  fun setRunning(value: Boolean) =
    executor.execute {
      running = value
      reschedule()
    }

  fun setScreenOn(value: Boolean) =
    executor.execute {
      screenOn = value
      if (running) reschedule()
    }

  private fun reschedule() {
    restart?.cancel(false)
    stopScan()
    if (running) begin()
  }

  private fun begin() {
    if (!limiter.tryStart()) {
      restart = executor.schedule({ reschedule() }, limiter.msUntilNextStart(), TimeUnit.MILLISECONDS)
      return
    }
    val filter = ScanFilter.Builder().setServiceData(uuid, byteArrayOf(), byteArrayOf()).build()
    val mode = if (screenOn) ScanSettings.SCAN_MODE_BALANCED else ScanSettings.SCAN_MODE_LOW_POWER
    // Extended advertisements are only reported to a scan that asks for non-legacy results.
    val settings =
      ScanSettings
        .Builder()
        .setScanMode(mode)
        .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
        .setLegacy(false)
        .build()
    try {
      adapter.bluetoothLeScanner?.startScan(listOf(filter), settings, callback)
      scanning = true
    } catch (error: SecurityException) {
      Log.w(TAG, "scan refused", error)
    }
    restart = executor.schedule({ reschedule() }, RESTART_MS, TimeUnit.MILLISECONDS)
  }

  private fun stopScan() {
    if (!scanning) return
    scanning = false
    try {
      adapter.bluetoothLeScanner?.stopScan(callback)
    } catch (error: SecurityException) {
      Log.w(TAG, "stop refused", error)
    }
  }
}
