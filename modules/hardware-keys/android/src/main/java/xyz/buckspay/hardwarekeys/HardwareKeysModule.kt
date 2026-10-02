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

      Function("configure") { cluster: String, programId: ByteArray ->
        configuration.configure(cluster, programId)
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

      AsyncFunction("sign") Coroutine { purpose: String, slot: ByteArray, content: ByteArray ->
        val domains = configuration.domains ?: throw NotConfiguredException()
        withContext(keystore) { deviceKey().sign(domains, purpose, slot, content) }
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
