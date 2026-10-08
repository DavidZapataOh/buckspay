package xyz.buckspay.prover

import android.content.ComponentName
import android.content.pm.PackageManager
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkInfo
import androidx.work.WorkManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
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

  private val keys = File("/data/local/tmp/keys-0803/netting")

  private fun installTestNettingKey(): File =
    File(context.cacheDir, "netting-keys").apply {
      mkdirs()
      keys.listFiles()?.forEach { it.copyTo(File(this, it.name), overwrite = true) }
    }

  private fun assetBytes(name: String) =
    InstrumentationRegistry
      .getInstrumentation()
      .context.assets
      .open(name)
      .use { it.readBytes() }

  private fun vmHwmKb() =
    File("/proc/self/status")
      .readLines()
      .first { it.startsWith("VmHWM:") }
      .filter { it.isDigit() }
      .toLong()

  @Test
  fun proveAndVerifyNettingFixture() {
    val dir = installTestNettingKey()
    val witness = assetBytes("netting/w8.bin")
    val proof = Native.proveNetting(witness, dir.path)
    assertEquals(Native.NETTING_PROOF, proof.size)
    val publics = assetBytes("netting/public8.bin")
    assertEquals(1, Native.verifyNetting(proof, publics, File(dir, "vk.bin").path))
    proof[40] = (proof[40].toInt() xor 1).toByte()
    assertEquals(0, Native.verifyNetting(proof, publics, File(dir, "vk.bin").path))
    Native.release()
  }

  @Test
  fun measureNetting() {
    val dir = installTestNettingKey()
    val witness = assetBytes("netting/w8.bin")
    repeat(3) {
      val start = SystemClock.elapsedRealtime()
      Native.proveNetting(witness.copyOf(), dir.path)
      Log.i("M3", "netting prove ms=${SystemClock.elapsedRealtime() - start} vmhwm_kb=${vmHwmKb()}")
      Native.release()
    }
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
