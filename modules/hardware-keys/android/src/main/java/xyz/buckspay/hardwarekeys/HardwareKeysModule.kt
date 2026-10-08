package xyz.buckspay.hardwarekeys

import android.content.Context
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import java.util.concurrent.Executors

internal class NotConfiguredException : CodedException("Call configure first")

class HardwareKeysModule : Module() {
  override fun definition() =
    ModuleDefinition {
      Name("HardwareKeys")

      Function("isStrongBoxAvailable") { deviceKey().isStrongBoxAvailable() }

      Function("configure") { cluster: String, programId: ByteArray, grace: Long ->
        configuration.configure(cluster, programId, grace)
      }

      AsyncFunction("createKey") Coroutine { challenge: ByteArray ->
        val domains = configuration.domains ?: throw NotConfiguredException()
        withContext(keystore) { deviceKey().create(domains, challenge) }
      }

      AsyncFunction("getKey").Coroutine<KeyRecord?> { withContext(keystore) { deviceKey().get() } }

      AsyncFunction("signNote") Coroutine { slot: ByteArray, content: ByteArray ->
        val domains = configuration.domains ?: throw NotConfiguredException()
        withContext(keystore) { deviceKey().signNote(domains, slot, content) }
      }

      AsyncFunction("signIou") Coroutine { body: ByteArray ->
        val domains = configuration.domains ?: throw NotConfiguredException()
        withContext(keystore) { deviceKey().signIou(domains, body) }
      }

      AsyncFunction("sign") Coroutine { purpose: String, slot: ByteArray, content: ByteArray ->
        val domains = configuration.domains ?: throw NotConfiguredException()
        withContext(keystore) { deviceKey().sign(domains, purpose, slot, content) }
      }

      AsyncFunction("recordOutput") Coroutine { output: ByteArray, expiry: Long ->
        val domains = configuration.domains ?: throw NotConfiguredException()
        withContext(keystore) { deviceKey().recordOutput(domains, output, expiry) }
      }

      AsyncFunction("signReclaim") Coroutine { output: ByteArray, deadline: Long ->
        val domains = configuration.domains ?: throw NotConfiguredException()
        val grace = configuration.grace ?: throw NotConfiguredException()
        withContext(keystore) { deviceKey().signReclaim(domains, output, deadline, grace, System.currentTimeMillis() / 1000) }
      }

      AsyncFunction("signDeviceBinding") Coroutine { wallet: ByteArray ->
        val domains = configuration.domains ?: throw NotConfiguredException()
        withContext(keystore) { deviceKey().signDeviceBinding(domains, wallet) }
      }

      AsyncFunction("resetKey").Coroutine<Unit> { withContext(keystore) { deviceKey().reset() } }
    }

  private fun deviceKey() = deviceKey(appContext.reactContext ?: throw Exceptions.ReactContextLost())

  // Shared by every instance of the module in the process.
  private companion object {
    // StrongBox operations can take hundreds of milliseconds; one thread keeps them off shared
    // pools and runs every key operation, and so every note guard check, in order.
    val keystore = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    val configuration = Configuration()

    @Volatile var key: DeviceKey? = null

    fun deviceKey(context: Context): DeviceKey =
      key ?: synchronized(this) { key ?: DeviceKey(context.applicationContext).also { key = it } }
  }
}
