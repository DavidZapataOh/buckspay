package xyz.buckspay.nearby

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean

private const val BACKGROUND_GRACE_MS = 10_000L

private class PendingSend(
  val endpointId: String,
  val promise: Promise,
)

class NearbyModule : Module() {
  private val context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private var client: ConnectionsClient? = null
  private val advertising = AtomicBoolean(false)
  private val discovering = AtomicBoolean(false)
  private val connected: MutableSet<String> = ConcurrentHashMap.newKeySet()
  private val inbox = ConcurrentHashMap<String, ConcurrentLinkedQueue<ByteArray>>()
  private val sends = ConcurrentHashMap<Long, PendingSend>()
  private val main = Handler(Looper.getMainLooper())
  private val stopWhenAway = Runnable { stopAll("the app stayed in the background") }

  private val nearby: ConnectionsClient
    get() = client ?: Nearby.getConnectionsClient(context).also { client = it }

  private val lifecycle =
    object : ConnectionLifecycleCallback() {
      override fun onConnectionInitiated(
        endpointId: String,
        info: ConnectionInfo,
      ) {
        Log.i(TAG, "connection initiated endpoint=$endpointId incoming=${info.isIncomingConnection}")
        emit(
          "initiated",
          endpointId,
          "digits" to info.authenticationDigits,
          "incoming" to info.isIncomingConnection,
          "infoHex" to info.endpointInfo.toHex(),
        )
      }

      override fun onConnectionResult(
        endpointId: String,
        result: ConnectionResolution,
      ) {
        val ok = result.status.statusCode == ConnectionsStatusCodes.STATUS_OK
        Log.i(
          TAG,
          "connection result endpoint=$endpointId status=${result.status.statusCode} (${result.status.statusMessage})",
        )
        if (ok) connected.add(endpointId)
        emit("result", endpointId, "ok" to ok)
      }

      override fun onDisconnected(endpointId: String) {
        Log.i(TAG, "disconnected endpoint=$endpointId")
        forget(endpointId)
      }
    }

  private val discovery =
    object : EndpointDiscoveryCallback() {
      override fun onEndpointFound(
        endpointId: String,
        info: DiscoveredEndpointInfo,
      ) {
        Log.i(TAG, "endpoint found endpoint=$endpointId")
        emit("found", endpointId, "infoHex" to info.endpointInfo.toHex())
      }

      override fun onEndpointLost(endpointId: String) {
        Log.i(TAG, "endpoint lost endpoint=$endpointId")
        emit("lost", endpointId)
      }
    }

  private val payloads =
    object : PayloadCallback() {
      override fun onPayloadReceived(
        endpointId: String,
        payload: Payload,
      ) {
        val bytes = if (payload.type == Payload.Type.BYTES) payload.asBytes() else null
        if (bytes == null) {
          Log.w(TAG, "payload of type ${payload.type} from endpoint=$endpointId is not bytes; disconnecting")
          nearby.disconnectFromEndpoint(endpointId)
          return
        }
        Log.i(TAG, "payload received endpoint=$endpointId size=${bytes.size}")
        inbox.getOrPut(endpointId) { ConcurrentLinkedQueue() }.add(bytes)
        emit("message", endpointId)
      }

      override fun onPayloadTransferUpdate(
        endpointId: String,
        update: PayloadTransferUpdate,
      ) {
        val pending = sends[update.payloadId]
        Log.i(
          TAG,
          "payload transfer endpoint=$endpointId status=${update.status} " +
            "${update.bytesTransferred}/${update.totalBytes} outgoing=${pending != null}",
        )
        if (pending == null) return
        when (update.status) {
          PayloadTransferUpdate.Status.SUCCESS -> {
            pending.promise.resolve(null)
          }

          PayloadTransferUpdate.Status.FAILURE, PayloadTransferUpdate.Status.CANCELED -> {
            Log.w(TAG, "payload send to endpoint=$endpointId ended with status=${update.status}")
            pending.promise.reject(NearbyException("Failed"))
          }

          else -> {
            return
          }
        }
        sends.remove(update.payloadId)
      }
    }

  override fun definition() =
    ModuleDefinition {
      Name("Nearby")

      Events("onEvent")

      AsyncFunction("support") { support(context) }

      AsyncFunction("requestPermissions") { promise: Promise ->
        Permissions.askForPermissionsWithPermissionsManager(
          appContext.permissions,
          promise,
          *requiredPermissions(android.os.Build.VERSION.SDK_INT).toTypedArray(),
        )
      }

      AsyncFunction("startAdvertising") { infoHex: String, promise: Promise ->
        if (!advertising.compareAndSet(false, true)) throw NearbyException("AlreadyActive")
        nearby
          .startAdvertising(infoHex.hexToBytes(), Options.SERVICE_ID, lifecycle, Options.advertising())
          .addOnSuccessListener { promise.resolve(null) }
          .addOnFailureListener {
            warn("startAdvertising", it)
            advertising.set(false)
            promise.reject(failure(it))
          }
      }

      AsyncFunction("stopAdvertising") {
        Log.i(TAG, "stopAdvertising requested")
        advertising.set(false)
        nearby.stopAdvertising()
      }

      AsyncFunction("startDiscovery") { promise: Promise ->
        if (!discovering.compareAndSet(false, true)) throw NearbyException("AlreadyActive")
        nearby
          .startDiscovery(Options.SERVICE_ID, discovery, Options.discovery())
          .addOnSuccessListener { promise.resolve(null) }
          .addOnFailureListener {
            warn("startDiscovery", it)
            discovering.set(false)
            promise.reject(failure(it))
          }
      }

      AsyncFunction("stopDiscovery") {
        Log.i(TAG, "stopDiscovery requested")
        discovering.set(false)
        nearby.stopDiscovery()
      }

      AsyncFunction("requestConnection") { endpointId: String, infoHex: String, promise: Promise ->
        nearby
          .requestConnection(infoHex.hexToBytes(), endpointId, lifecycle, Options.connection())
          .addOnSuccessListener { promise.resolve(null) }
          .addOnFailureListener {
            warn("requestConnection", it)
            promise.reject(failure(it))
          }
      }

      AsyncFunction("acceptConnection") { endpointId: String, promise: Promise ->
        nearby
          .acceptConnection(endpointId, payloads)
          .addOnSuccessListener { promise.resolve(null) }
          .addOnFailureListener {
            warn("acceptConnection", it)
            promise.reject(failure(it))
          }
      }

      AsyncFunction("rejectConnection") { endpointId: String, promise: Promise ->
        nearby
          .rejectConnection(endpointId)
          .addOnSuccessListener { promise.resolve(null) }
          .addOnFailureListener {
            warn("rejectConnection", it)
            promise.reject(failure(it))
          }
      }

      AsyncFunction("sendBytes") { endpointId: String, bytes: ByteArray, promise: Promise ->
        val payload = Payload.fromBytes(bytes)
        sends[payload.id] = PendingSend(endpointId, promise)
        Log.i(TAG, "sending endpoint=$endpointId size=${bytes.size} connected=${connected.contains(endpointId)}")
        nearby.sendPayload(endpointId, payload).addOnFailureListener {
          warn("sendPayload", it)
          sends.remove(payload.id)
          promise.reject(failure(it))
        }
      }

      AsyncFunction("takeMessage") { endpointId: String -> inbox[endpointId]?.poll() }

      AsyncFunction("disconnect") { endpointId: String ->
        Log.i(TAG, "disconnect requested endpoint=$endpointId")
        nearby.disconnectFromEndpoint(endpointId)
        forget(endpointId)
      }

      AsyncFunction("stopAll") { stopAll("stopAll requested") }

      OnActivityEntersBackground { main.postDelayed(stopWhenAway, BACKGROUND_GRACE_MS) }

      OnActivityEntersForeground { main.removeCallbacks(stopWhenAway) }

      OnDestroy {
        Log.i(TAG, "module destroyed; stopping all endpoints")
        main.removeCallbacks(stopWhenAway)
        client?.stopAllEndpoints()
      }
    }

  private fun stopAll(reason: String) {
    Log.i(TAG, "stopping all endpoints: $reason connected=${connected.size}")
    client?.stopAllEndpoints()
    advertising.set(false)
    discovering.set(false)
    connected.toList().forEach { forget(it) }
  }

  private fun forget(endpointId: String) {
    val wasConnected = connected.remove(endpointId)
    Log.i(TAG, "forget endpoint=$endpointId wasConnected=$wasConnected")
    inbox.remove(endpointId)
    sends.entries.removeIf { (_, pending) ->
      (pending.endpointId == endpointId).also {
        if (it) {
          Log.w(TAG, "send to endpoint=$endpointId dropped: the link ended first")
          pending.promise.reject(NearbyException("Failed"))
        }
      }
    }
    if (wasConnected) emit("disconnected", endpointId)
  }

  private fun emit(
    type: String,
    endpointId: String,
    vararg fields: Pair<String, Any>,
  ) = sendEvent("onEvent", mapOf("type" to type, "endpointId" to endpointId) + fields)
}
