package xyz.buckspay.copresence

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioManager
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue

private const val MAX_QUEUED = 8

private class CopresenceException(
  code: String,
) : CodedException(code, code, null)

class CopresenceModule : Module() {
  private val context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private val audio get() = context.getSystemService(AudioManager::class.java)
  private var recorder: Recorder? = null
  private val inbox = ConcurrentLinkedQueue<ByteArray>()
  private val plays = ConcurrentHashMap<Int, Player>()

  @Volatile private var silenced = false

  override fun definition() =
    ModuleDefinition {
      Name("Copresence")

      Events("onMessage", "onState")

      AsyncFunction("check") { check() }

      AsyncFunction("requestPermission") { promise: Promise ->
        val permissions = appContext.permissions ?: throw Exceptions.PermissionsModuleNotFound()
        permissions.askForPermissions({ result ->
          promise.resolve(result[Manifest.permission.RECORD_AUDIO]?.status == PermissionsStatus.GRANTED)
        }, Manifest.permission.RECORD_AUDIO)
      }

      AsyncFunction("start") { name: String ->
        if (!granted()) throw CopresenceException("PermissionMissing")
        if (recorder != null) throw CopresenceException("AlreadyActive")
        val chosen = Band.parse(name)
        val started =
          Recorder(audio, chosen, ::deliver) { silenced ->
            this@CopresenceModule.silenced = silenced
            sendState(recording = true)
          }
        try {
          started.start()
        } catch (_: IllegalStateException) {
          throw CopresenceException("Unsupported")
        }
        recorder = started
        sendState(recording = true)
      }

      AsyncFunction("stop") { stop() }

      Function("take") { inbox.poll() }

      AsyncFunction("play") Coroutine { opId: Int, payload: ByteArray, name: String ->
        val samples = Encoder(Band.parse(name).protocol).use { it.encode(payload) }
        val player = Player(audio, samples)
        plays[opId] = player
        recorder?.deaf(true)
        try {
          player.play()
        } finally {
          plays.remove(opId)
          recorder?.deaf(false)
        }
      }

      Function("cancel") { opId: Int -> plays[opId]?.cancel() }

      OnActivityEntersBackground { stop() }

      OnDestroy { stop() }
    }

  private fun granted() = appContext.permissions?.hasGrantedPermissions(Manifest.permission.RECORD_AUDIO) == true

  private fun check(): Map<String, Any?> {
    val packageManager = context.packageManager
    val route = routeOf(audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { it.type })
    val low = volumeLow(audio.getStreamVolume(AudioManager.STREAM_MUSIC), audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC))
    val reason =
      when {
        !packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE) ||
          !packageManager.hasSystemFeature(PackageManager.FEATURE_AUDIO_OUTPUT) -> "hardware-missing"

        !granted() -> "permission-denied"

        silenced -> "disabled"

        else -> null
      }
    return mapOf("ready" to (reason == null), "reason" to reason, "volumeLow" to low, "route" to route)
  }

  private fun deliver(payload: ByteArray) {
    while (inbox.size >= MAX_QUEUED) inbox.poll()
    inbox.add(payload)
    sendEvent("onMessage", mapOf("length" to payload.size))
  }

  private fun sendState(recording: Boolean) {
    val state = check()
    sendEvent(
      "onState",
      mapOf(
        "recording" to recording,
        "silenced" to silenced,
        "volumeLow" to state["volumeLow"],
        "route" to state["route"],
      ),
    )
  }

  private fun stop() {
    plays.values.forEach { it.cancel() }
    recorder?.stop()
    recorder = null
    silenced = false
    inbox.clear()
  }
}
