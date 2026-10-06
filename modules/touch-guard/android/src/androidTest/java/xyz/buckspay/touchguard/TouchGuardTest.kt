package xyz.buckspay.touchguard

import android.os.Build
import android.view.View
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TouchGuardTest {
  private val view = View(InstrumentationRegistry.getInstrumentation().targetContext)

  @Test
  fun dropsTouchesThroughAnOverlayWhileEnabled() {
    TouchProtection.apply(view, true)
    assertTrue(view.filterTouchesWhenObscured)
    TouchProtection.apply(view, false)
    assertFalse(view.filterTouchesWhenObscured)
  }

  @Test
  fun hidesTheViewFromAccessibilityServicesThatAreNotToolsOnAndroid14() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return
    TouchProtection.apply(view, true)
    assertTrue(view.isAccessibilityDataSensitive)
    TouchProtection.apply(view, false)
    assertFalse(view.isAccessibilityDataSensitive)
  }
}
