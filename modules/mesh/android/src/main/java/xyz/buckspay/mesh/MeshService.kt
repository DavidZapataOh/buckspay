package xyz.buckspay.mesh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.IBinder
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private const val TAG = "MeshService"
private const val CHANNEL = "mesh"
private const val NOTIFICATION_ID = 1
private const val MAX_STARTS = 3
private const val START_WINDOW_MS = 30_000L
private const val BATCH_FRAMES = 16
private const val BATCH_DELAY_MS = 2_000L
private const val DEDUPE_MS = 60_000L
private const val PSM_ROTATION_MS = 10 * 60_000L
private const val BEACON_ID = "beacon"

/** The foreground service (type `connectedDevice`) that scans for and advertises mesh frames while the switch is on. */
class MeshService : Service() {
  private val executor = Executors.newSingleThreadScheduledExecutor()
  private val io = Executors.newCachedThreadPool()
  private val clock = SystemClock::elapsedRealtime
  private val limiter = StartLimiter(MAX_STARTS, START_WINDOW_MS, clock)
  private val delivered = AtomicInteger()
  private var scanner: Scanner? = null
  internal var advertiser: Advertiser? = null
    private set

  internal var hub: L2capHub? = null
    private set

  private class BeaconConfig(
    val online: Boolean,
    val clusterTag: ByteArray,
    val keyId: Int,
  )

  private var beacon: BeaconConfig? = null

  @Volatile private var validated = false

  private val network =
    object : ConnectivityManager.NetworkCallback() {
      override fun onCapabilitiesChanged(
        network: Network,
        capabilities: NetworkCapabilities,
      ) {
        validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        executor.execute { publishBeacon() }
      }

      override fun onLost(network: Network) {
        validated = false
        executor.execute { publishBeacon() }
      }
    }

  @Volatile private var paused = false

  @Volatile private var radioOn = false
  private var batcher: FrameBatcher? = null

  private val receiver =
    object : BroadcastReceiver() {
      override fun onReceive(
        context: Context,
        intent: Intent,
      ) {
        when (intent.action) {
          Intent.ACTION_SCREEN_ON -> {
            scanner?.setScreenOn(true)
          }

          Intent.ACTION_SCREEN_OFF -> {
            scanner?.setScreenOn(false)
          }

          Intent.ACTION_USER_PRESENT -> {
            startTask(emptyList())
          }

          BluetoothAdapter.ACTION_STATE_CHANGED -> {
            radioOn = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.STATE_OFF) == BluetoothAdapter.STATE_ON
            apply()
          }
        }
      }
    }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(
    intent: Intent?,
    flags: Int,
    startId: Int,
  ): Int {
    if (intent?.action == ACTION_STOP) {
      MeshPrefs.setEnabled(this, false)
      stopSelf()
      return START_NOT_STICKY
    }
    if (instance != null) return START_STICKY
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } catch (error: RuntimeException) {
      Log.w(TAG, "cannot run as a foreground service", error)
      stopSelf()
      return START_NOT_STICKY
    }
    val adapter = adapterOf(this)
    if (adapter == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    val batcher = FrameBatcher(BATCH_FRAMES, BATCH_DELAY_MS, DEDUPE_MS, clock) { startTask(it) }
    this.batcher = batcher
    scanner = Scanner(adapter, limiter, executor) { bytes, rssi, address -> batcher.add(bytes, rssi, address) }
    advertiser = Advertiser(adapter, executor)
    hub = L2capHub(adapter, io) { channel, peer -> startTask(emptyList(), listOf(channel), listOf(peer)) }
    getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(network)
    executor.scheduleWithFixedDelay({ rotateBeacon() }, PSM_ROTATION_MS, PSM_ROTATION_MS, TimeUnit.MILLISECONDS)
    radioOn = adapter.isEnabled
    executor.scheduleWithFixedDelay({ batcher.tick(clock()) }, BATCH_DELAY_MS / 4, BATCH_DELAY_MS / 4, TimeUnit.MILLISECONDS)
    val filter =
      IntentFilter().apply {
        addAction(Intent.ACTION_SCREEN_ON)
        addAction(Intent.ACTION_SCREEN_OFF)
        addAction(Intent.ACTION_USER_PRESENT)
        addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
      }
    ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    instance = this
    apply()
    return START_STICKY
  }

  override fun onDestroy() {
    instance = null
    unregisterReceiver(receiver)
    getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(network)
    scanner?.setRunning(false)
    advertiser?.release()
    hub?.stop()
    executor.shutdown()
    io.shutdown()
    super.onDestroy()
  }

  internal fun setPaused(value: Boolean) {
    paused = value
    apply()
  }

  internal fun status(): Map<String, Any> =
    mapOf(
      "enabled" to true,
      "running" to true,
      "paused" to paused,
      "scanStartsLast30s" to limiter.recentStarts(),
      "frames" to delivered.get(),
      "validated" to validated,
      "psm" to (hub?.psm ?: 0),
    )

  /** Tells phones nearby that this one can take a payment to the internet, on the PSM of the L2CAP server it opens. */
  internal fun setBeacon(
    online: Boolean,
    clusterTag: ByteArray,
    keyId: Int,
  ) = executor.execute {
    beacon = BeaconConfig(online, clusterTag, keyId)
    val hub = hub ?: return@execute
    if (hub.psm == 0) hub.listen()
    publishBeacon()
  }

  internal fun clearBeacon() =
    executor.execute {
      beacon = null
      advertiser?.withdraw(BEACON_ID)
      hub?.stop()
    }

  /** The beacon says online only while Android validates the connection: an offline phone must not take blobs it cannot post. */
  private fun publishBeacon() {
    val config = beacon ?: return
    val frame = beaconFrame(config.online && validated, config.clusterTag, config.keyId, hub?.psm ?: return)
    try {
      advertiser?.advertise(BEACON_ID, frame, BEACON_TTL_SECONDS)
    } catch (error: MeshException) {
      Log.w(TAG, "the beacon does not fit the air: ${error.code}")
    }
  }

  /** A new PSM and a new advertising address every ten minutes: a scanner cannot follow one phone for longer. */
  private fun rotateBeacon() {
    if (beacon == null) return
    hub?.listen()
    advertiser?.restart()
    publishBeacon()
  }

  private fun apply() {
    val active = radioOn && !paused
    scanner?.setRunning(active)
    advertiser?.setRunning(active)
  }

  private fun startTask(
    frames: List<ScannedFrame>,
    channels: List<Int> = emptyList(),
    peers: List<String> = emptyList(),
  ) {
    delivered.addAndGet(frames.size)
    val intent =
      Intent(this, MeshTaskService::class.java)
        .putExtra(MeshTaskService.FRAMES, frames.map { Base64.encodeToString(it.bytes, Base64.NO_WRAP) }.toTypedArray())
        .putExtra(MeshTaskService.RSSI, frames.map { it.rssi }.toIntArray())
        .putExtra(MeshTaskService.ADDRESSES, frames.map { it.address }.toTypedArray())
        .putExtra(MeshTaskService.CHANNELS, channels.toIntArray())
        .putExtra(MeshTaskService.PEERS, peers.toTypedArray())
        .putExtra(MeshTaskService.UNLOCKED, frames.isEmpty() && channels.isEmpty())
    try {
      startService(intent)
    } catch (error: IllegalStateException) {
      Log.w(TAG, "cannot start the JavaScript task", error)
    }
  }

  private fun notification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL, getString(R.string.mesh_channel), NotificationManager.IMPORTANCE_LOW),
    )
    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    val stop = PendingIntent.getService(this, 0, Intent(this, MeshService::class.java).setAction(ACTION_STOP), flags)
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let { PendingIntent.getActivity(this, 0, it, flags) }
    val turnOff =
      Notification.Action
        .Builder(Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel), getString(R.string.mesh_turn_off), stop)
        .build()
    return Notification
      .Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
      .setContentTitle(getString(R.string.mesh_notification_title))
      .setContentIntent(open)
      .setOngoing(true)
      .addAction(turnOff)
      .build()
  }

  internal companion object {
    const val ACTION_STOP = "xyz.buckspay.mesh.STOP"

    @Volatile var instance: MeshService? = null
  }
}
