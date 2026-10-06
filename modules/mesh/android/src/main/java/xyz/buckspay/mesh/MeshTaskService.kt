package xyz.buckspay.mesh

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Runs the JavaScript task `mesh` with a batch of scanned frames, or with `unlocked` when the person unlocked the phone. */
class MeshTaskService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    if (intent == null) return null
    val data =
      Arguments.createMap().apply {
        putArray("frames", Arguments.fromArray(intent.getStringArrayExtra(FRAMES) ?: emptyArray<String>()))
        putArray("rssi", Arguments.fromArray(intent.getIntArrayExtra(RSSI) ?: IntArray(0)))
        putBoolean("unlocked", intent.getBooleanExtra(UNLOCKED, false))
      }
    return HeadlessJsTaskConfig(TASK, data, TIMEOUT_MS, true)
  }

  companion object {
    const val FRAMES = "frames"
    const val RSSI = "rssi"
    const val UNLOCKED = "unlocked"
    private const val TASK = "mesh"
    private const val TIMEOUT_MS = 30_000L
  }
}
