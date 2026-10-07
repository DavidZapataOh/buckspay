package xyz.buckspay.prover

import android.content.ComponentName
import android.content.pm.PackageManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkInfo
import androidx.work.WorkManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class NativeTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext

  @Test
  fun theLibraryLoadsAndAnswersThroughJni() {
    val empty = File(context.cacheDir, "no-key").apply { mkdirs() }
    assertNotEquals(Native.OK, Native.load(empty.path))
    assertEquals(Native.FAILED, Native.proveInto(ByteArray(8), 0, ByteArray(Native.PROOF_AND_PUBLIC)))
    assertEquals(Native.BAD_ARGS, Native.proveInto(ByteArray(8), 0, ByteArray(4)))
    Native.release()
  }

  @Test
  fun expandingAMissingKeyFails() {
    assertNotEquals(Native.OK, Native.expand(File(context.cacheDir, "absent.bin").path, File(context.cacheDir, "absent.dump").path))
  }

  @Test
  fun theWorkerServiceRunsInItsOwnProcessAndIsNotExported() {
    val info =
      context.packageManager.getServiceInfo(
        ComponentName(context, androidx.work.multiprocess.RemoteWorkerService::class.java),
        PackageManager.GET_META_DATA,
      )
    assertEquals("${context.packageName}:prover", info.processName)
    assertFalse(info.exported)
  }

  @Test
  fun aProveJobRunsInTheProverProcessAndFailsCleanlyWithoutAKey() {
    val files = proverFiles(context)
    files.putChain("instrumented", byteArrayOf(1))
    val vk = "ab".repeat(32)
    val request = ProveWorker.request(context.packageName, "instrumented", vk, intArrayOf(0), "now", expedite = false)
    val manager = WorkManager.getInstance(context)
    manager.enqueue(request).result.get()
    var info: WorkInfo?
    val deadline = System.currentTimeMillis() + 60_000
    do {
      Thread.sleep(250)
      info = manager.getWorkInfoById(request.id).get()
    } while (info?.state?.isFinished != true && System.currentTimeMillis() < deadline)
    assertEquals(WorkInfo.State.FAILED, info?.state)
    assertEquals("no-key", info?.outputData?.getString(ProveWorker.REASON))
    files.forget("instrumented")
  }
}
