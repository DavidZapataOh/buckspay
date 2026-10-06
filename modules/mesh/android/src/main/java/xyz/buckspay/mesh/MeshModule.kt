package xyz.buckspay.mesh

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MeshModule : Module() {
  private val context: Context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun service(): MeshService = MeshService.instance ?: throw MeshException("not-running")

  private fun hub(): L2capHub = service().hub ?: throw MeshException("not-running")

  override fun definition() =
    ModuleDefinition {
      Name("Mesh")

      AsyncFunction("support") {
        val adapter = adapterOf(context)
        val ble = adapter != null && context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
        mapOf(
          "ble" to ble,
          "extended" to (ble && adapter!!.isLeExtendedAdvertisingSupported),
          "maxAdvertisingBytes" to if (ble) maxAdvertisingBytes(adapter!!) else 0,
          "gattServer" to (ble && adapter!!.bluetoothLeAdvertiser != null),
        )
      }

      AsyncFunction("start") {
        val adapter = adapterOf(context)
        if (adapter == null || !MeshPrefs.supported()) throw MeshException("unsupported")
        if (!MeshPrefs.canRun(context)) throw MeshException("permission-denied")
        if (!adapter.isEnabled) throw MeshException("bluetooth-off")
        MeshPrefs.setEnabled(context, true)
        ContextCompat.startForegroundService(context, Intent(context, MeshService::class.java))
      }

      AsyncFunction("stop") {
        MeshPrefs.setEnabled(context, false)
        context.stopService(Intent(context, MeshService::class.java))
      }

      AsyncFunction("pause") { MeshService.instance?.setPaused(true) }

      AsyncFunction("resume") { MeshService.instance?.setPaused(false) }

      AsyncFunction("advertise") { frameId: String, frame: ByteArray, ttlSeconds: Double ->
        service().advertiser?.advertise(frameId, frame, ttlSeconds.toLong())
      }

      AsyncFunction("withdraw") { frameId: String -> MeshService.instance?.advertiser?.withdraw(frameId) }

      AsyncFunction("setBeacon") { online: Boolean, clusterTag: ByteArray, keyId: Int ->
        service().setBeacon(online, clusterTag, keyId)
      }

      AsyncFunction("clearBeacon") { MeshService.instance?.clearBeacon() }

      AsyncFunction("l2capConnect") { address: String, psm: Int -> hub().connect(address, psm) }

      AsyncFunction("l2capRead") { channel: Int, length: Int, timeoutMs: Double -> hub().read(channel, length, timeoutMs.toLong()) }

      AsyncFunction("l2capWrite") { channel: Int, bytes: ByteArray -> hub().write(channel, bytes) }

      AsyncFunction("l2capClose") { channel: Int -> MeshService.instance?.hub?.close(channel) }

      AsyncFunction("status") {
        MeshService.instance?.status()
          ?: mapOf(
            "enabled" to MeshPrefs.isEnabled(context),
            "running" to false,
            "paused" to false,
            "scanStartsLast30s" to 0,
            "frames" to 0,
            "validated" to false,
            "psm" to 0,
          )
      }
    }
}
