package xyz.buckspay.nearby

/** The radio serves one mode at a time: a payment and a group session never share it. */
internal class ModeGuard {
  var active: Mode? = null
    @Synchronized get
    private set

  /** True when no mode is active or [mode] is the active one; false when another mode is active. */
  @Synchronized
  fun enter(mode: Mode): Boolean {
    if (active != null && active != mode) return false
    active = mode
    return true
  }

  @Synchronized
  fun leave() {
    active = null
  }
}
