package xyz.buckspay.touchguard

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TouchGuardModule : Module() {
  override fun definition() =
    ModuleDefinition {
      Name("TouchGuard")

      AsyncFunction("protect") { enabled: Boolean ->
        val activity = if (enabled) appContext.throwingActivity else appContext.currentActivity
        activity?.let { TouchProtection.apply(it.window.decorView, enabled) }
      }.runOnQueue(Queues.MAIN)
    }
}
