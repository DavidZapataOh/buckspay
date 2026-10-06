package xyz.buckspay.mesh

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/** Restarts the service after a reboot or an update when the person left the switch on. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(
    context: Context,
    intent: Intent,
  ) {
    if (!MeshPrefs.isEnabled(context) || !MeshPrefs.canRun(context)) return
    try {
      ContextCompat.startForegroundService(context, Intent(context, MeshService::class.java))
    } catch (error: RuntimeException) {
      Log.w("MeshBoot", "the service was not allowed to start", error)
    }
  }
}
