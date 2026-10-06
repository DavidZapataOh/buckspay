package xyz.buckspay.touchguard

import android.os.Build
import android.view.View

internal object TouchProtection {
  /**
   * Sets on `view` whether touches that reach it through an overlay are dropped, and from API 34
   * whether accessibility services that are not tools may read it.
   */
  fun apply(
    view: View,
    enabled: Boolean,
  ) {
    view.filterTouchesWhenObscured = enabled
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      view.setAccessibilityDataSensitive(
        if (enabled) View.ACCESSIBILITY_DATA_SENSITIVE_YES else View.ACCESSIBILITY_DATA_SENSITIVE_AUTO,
      )
    }
  }
}
