package xyz.buckspay.mesh

import android.content.ComponentName
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ManifestTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext

  @Test
  fun theServiceIsAConnectedDeviceForegroundServiceThatOnlyTheAppCanStart() {
    val info = context.packageManager.getServiceInfo(ComponentName(context, MeshService::class.java), PackageManager.GET_META_DATA)
    assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE, info.foregroundServiceType)
    assertFalse(info.exported)
  }

  @Test
  fun theTaskServiceAndTheBootReceiverAreNotExportedBeyondTheBootBroadcast() {
    val task = context.packageManager.getServiceInfo(ComponentName(context, MeshTaskService::class.java), 0)
    assertFalse(task.exported)
    val receiver = context.packageManager.getReceiverInfo(ComponentName(context, BootReceiver::class.java), 0)
    assertFalse(receiver.exported)
  }
}
