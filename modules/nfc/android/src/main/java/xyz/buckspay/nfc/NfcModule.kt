package xyz.buckspay.nfc

import android.content.pm.PackageManager
import android.nfc.NfcAdapter
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class NfcMessage : Record {
  @Field var kind: Int = 0

  @Field var payload: ByteArray = ByteArray(0)
}

class NfcModule : Module() {
  private val context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun support(instance: Int): Map<String, Boolean> {
    if (instance != 0) return mapOf("hardware" to true, "hce" to true, "enabled" to true, "reader" to true)
    val adapter = NfcAdapter.getDefaultAdapter(context)
    val features = context.packageManager
    val reader =
      Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM ||
        adapter == null ||
        !adapter.isReaderOptionSupported ||
        adapter.isReaderOptionEnabled
    return mapOf(
      "hardware" to features.hasSystemFeature(PackageManager.FEATURE_NFC),
      "hce" to features.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION),
      "enabled" to (adapter?.isEnabled == true),
      "reader" to reader,
    )
  }

  override fun definition() =
    ModuleDefinition {
      Name("Nfc")

      Events("onProgress")

      AsyncFunction("support") { instance: Int -> support(instance) }

      AsyncFunction("acquire") { role: String, instance: Int -> NfcRuntime.side(instance).acquire(role) }

      AsyncFunction("release") { instance: Int -> NfcRuntime.side(instance).release() }

      AsyncFunction("offer") { opId: Int, kind: Int, payload: ByteArray, instance: Int, promise: Promise ->
        NfcRuntime.side(instance).offer(opId, kind, payload, promise)
      }

      AsyncFunction("push") { opId: Int, kind: Int, payload: ByteArray, instance: Int, promise: Promise ->
        NfcRuntime.side(instance).push(opId, kind, payload, promise)
      }

      AsyncFunction("receive") { opId: Int, acceptMask: Int, instance: Int, promise: Promise ->
        NfcRuntime.side(instance).receive(opId, acceptMask, promise)
      }

      Function("cancel") { opId: Int, instance: Int -> NfcRuntime.side(instance).cancel(opId) }

      Function("stats") { NfcRuntime.stats() }

      OnCreate { NfcRuntime.progressListener = { sendEvent("onProgress", it) } }

      OnActivityEntersForeground { NfcRuntime.resume(appContext.currentActivity) }

      OnActivityEntersBackground { NfcRuntime.pause() }

      OnDestroy {
        NfcRuntime.progressListener = null
        NfcRuntime.release()
      }
    }
}
