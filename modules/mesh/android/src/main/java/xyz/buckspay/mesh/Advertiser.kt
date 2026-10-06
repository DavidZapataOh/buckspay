package xyz.buckspay.mesh

import android.bluetooth.BluetoothAdapter
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertisingSet
import android.bluetooth.le.AdvertisingSetCallback
import android.bluetooth.le.AdvertisingSetParameters
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

private const val TAG = "MeshAdvertiser"
private const val ROTATION_MS = 2_000L
internal const val MAX_FRAMES = 5

/** Advertises the active frames one at a time from a single advertising set, rotating every two seconds. */
internal class Advertiser(
  private val adapter: BluetoothAdapter,
  private val executor: ScheduledExecutorService,
) {
  private class Entry(
    val frame: ByteArray,
    val expiresAt: Long,
  )

  private val frames = LinkedHashMap<String, Entry>()
  private var set: AdvertisingSet? = null
  private var starting = false
  private var running = false
  private var cursor = 0
  private var rotation: ScheduledFuture<*>? = null
  private val uuid = ParcelUuid(SERVICE_UUID)

  private val callback =
    object : AdvertisingSetCallback() {
      override fun onAdvertisingSetStarted(
        advertisingSet: AdvertisingSet?,
        txPower: Int,
        status: Int,
      ) = executor.execute {
        synchronized(this@Advertiser) {
          starting = false
          if (status == ADVERTISE_SUCCESS) set = advertisingSet else Log.w(TAG, "advertising failed: $status")
        }
      }

      override fun onAdvertisingSetStopped(advertisingSet: AdvertisingSet?) =
        executor.execute {
          synchronized(this@Advertiser) { set = null }
        }
    }

  @Synchronized
  fun advertise(
    id: String,
    frame: ByteArray,
    ttlSeconds: Long,
  ) {
    if (SERVICE_DATA_OVERHEAD + frame.size > maxAdvertisingBytes(adapter)) throw MeshException("frame-too-large")
    if (id !in frames && frames.size >= MAX_FRAMES) throw MeshException("too-many-frames")
    frames[id] = Entry(frame, SystemClock.elapsedRealtime() + ttlSeconds * 1_000)
    sync()
  }

  @Synchronized
  fun withdraw(id: String) {
    frames.remove(id)
    sync()
  }

  /** Starts the advertising set again, which takes a new random address. */
  @Synchronized
  fun restart() {
    stopSet()
    sync()
  }

  @Synchronized
  fun setRunning(value: Boolean) {
    running = value
    sync()
  }

  @Synchronized
  fun release() {
    frames.clear()
    running = false
    sync()
  }

  private fun sync() {
    val now = SystemClock.elapsedRealtime()
    frames.values.removeAll { it.expiresAt <= now }
    if (!running || frames.isEmpty()) {
      rotation?.cancel(false)
      rotation = null
      stopSet()
      return
    }
    if (set == null && !starting) startSet()
    if (rotation == null) rotation = executor.scheduleWithFixedDelay({ rotate() }, ROTATION_MS, ROTATION_MS, TimeUnit.MILLISECONDS)
  }

  @Synchronized
  private fun rotate() {
    sync()
    next()?.let { set?.setAdvertisingData(it) }
  }

  private fun next(): AdvertiseData? {
    if (frames.isEmpty()) return null
    cursor = (cursor + 1) % frames.size
    return dataOf(frames.values.elementAt(cursor).frame)
  }

  private fun dataOf(frame: ByteArray) =
    AdvertiseData
      .Builder()
      .addServiceData(uuid, frame)
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .build()

  private fun startSet() {
    val extended = adapter.isLeExtendedAdvertisingSupported
    val parameters =
      AdvertisingSetParameters
        .Builder()
        .setLegacyMode(!extended)
        .setConnectable(false)
        .setScannable(!extended)
        .setInterval(AdvertisingSetParameters.INTERVAL_HIGH)
        .setTxPowerLevel(AdvertisingSetParameters.TX_POWER_LOW)
        .build()
    cursor %= frames.size
    val advertiser = adapter.bluetoothLeAdvertiser ?: return
    starting = true
    try {
      advertiser.startAdvertisingSet(parameters, dataOf(frames.values.elementAt(cursor).frame), null, null, null, callback)
    } catch (error: SecurityException) {
      starting = false
      Log.w(TAG, "advertising refused", error)
    }
  }

  private fun stopSet() {
    if (set == null && !starting) return
    set = null
    starting = false
    try {
      adapter.bluetoothLeAdvertiser?.stopAdvertisingSet(callback)
    } catch (error: SecurityException) {
      Log.w(TAG, "stop refused", error)
    }
  }
}
