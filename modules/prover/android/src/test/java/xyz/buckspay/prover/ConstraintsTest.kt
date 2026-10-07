package xyz.buckspay.prover

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ConstraintsTest {
  private val vk = "ab".repeat(32)

  private fun request(
    mode: String,
    expedite: Boolean = true,
  ) = ProveWorker.request("xyz.buckspay", "n1", vk, intArrayOf(1, 2), mode, expedite)

  @Test
  fun chargingModeRequiresChargerAndBatteryNotLow() {
    val c = request("charging").workSpec.constraints
    assertTrue(c.requiresCharging())
    assertTrue(c.requiresBatteryNotLow())
  }

  @Test
  fun deadlineModeDropsTheChargerConstraint() {
    val c = request("deadline").workSpec.constraints
    assertFalse(c.requiresCharging())
    assertTrue(c.requiresBatteryNotLow())
  }

  @Test
  fun nowModeIsExpeditedAndUnconstrained() {
    val r = request("now")
    assertTrue(r.workSpec.expedited)
    assertFalse(r.workSpec.constraints.requiresCharging())
    assertFalse(request("now", expedite = false).workSpec.expedited)
  }

  @Test
  fun onlyNowIsEverExpedited() {
    assertFalse(request("charging").workSpec.expedited)
    assertFalse(request("deadline").workSpec.expedited)
  }

  @Test
  fun anUnknownModeIsRefused() {
    assertThrows(IllegalArgumentException::class.java) { request("always") }
  }

  @Test
  fun onlyARunTheUserAskedForReplacesTheQueuedOne() {
    assertEquals(androidx.work.ExistingWorkPolicy.REPLACE, ProveWorker.policy("now"))
    assertEquals(androidx.work.ExistingWorkPolicy.KEEP, ProveWorker.policy("charging"))
    assertEquals(androidx.work.ExistingWorkPolicy.KEEP, ProveWorker.policy("deadline"))
  }

  @Test
  fun oneUniqueWorkPerNote() {
    assertEquals("prove-n1", ProveWorker.uniqueName("n1"))
    assertThrows(IllegalArgumentException::class.java) { ProveWorker.uniqueName("n1/../x") }
  }

  @Test
  fun theKeyDownloadWaitsForWifiAndTheChargerUnlessTheUserAsked() {
    val spec = KeySpec(vk, "https://k/pk", vk, "https://k/ccs", vk, vk)
    val quiet = KeyWorker.request("xyz.buckspay", spec, unmeteredOnly = true).workSpec.constraints
    assertTrue(quiet.requiresCharging())
    assertEquals(androidx.work.NetworkType.UNMETERED, quiet.requiredNetworkType)
    val now = KeyWorker.request("xyz.buckspay", spec, unmeteredOnly = false).workSpec.constraints
    assertFalse(now.requiresCharging())
    assertEquals(androidx.work.NetworkType.CONNECTED, now.requiredNetworkType)
  }

  @Test
  fun theWorkerIsBoundToTheProverProcessService() {
    val data = request("charging").workSpec.input
    assertEquals(
      "androidx.work.multiprocess.RemoteWorkerService",
      data.getString(androidx.work.multiprocess.RemoteListenableWorker.ARGUMENT_CLASS_NAME),
    )
    assertEquals("xyz.buckspay", data.getString(androidx.work.multiprocess.RemoteListenableWorker.ARGUMENT_PACKAGE_NAME))
  }
}
