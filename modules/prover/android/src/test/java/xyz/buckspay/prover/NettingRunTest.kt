package xyz.buckspay.prover

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class NettingRunTest {
  @get:Rule val tmp = TemporaryFolder()

  private val files by lazy { ProverFiles(tmp.newFolder("zk")) }
  private val vk = "e".repeat(64)
  private val witness = ByteArray(2_775) { 9 }

  private fun run(prover: Prover): ProveOutcome {
    files.putNettingWitness("s1", witness)
    return NettingRun(prover, files).run("s1", vk)
  }

  @Test
  fun aProvedNettingIsOnDiskAndItsWitnessIsGone() {
    val prover = FakeProver()
    assertEquals(ProveOutcome.Done, run(prover))
    assertEquals(Native.NETTING_PROOF, files.nettingProof("s1", vk)!!.size)
    assertFalse(files.nettingWitness("s1").exists())
    assertArrayEquals(witness, prover.netted.single())
    assertEquals(1, prover.releases)
  }

  @Test
  fun aRefusedWitnessIsDeletedAndReportedInvalid() {
    assertEquals(ProveOutcome.Failed("invalid"), run(FakeProver(nettingFailure = Native.FAILED)))
    assertFalse(files.nettingWitness("s1").exists())
    assertNull(files.nettingProof("s1", vk))
  }

  @Test
  fun aMissingKeyKeepsTheWitnessForTheNextRun() {
    assertEquals(ProveOutcome.Failed("no-key"), run(FakeProver(nettingFailure = Native.NO_KEY)))
    assertTrue(files.nettingWitness("s1").exists())
  }

  @Test
  fun forgetNettingRemovesTheWitnessAndEveryProof() {
    files.putNettingWitness("s1", witness)
    files.putNettingProof("s1", vk, ByteArray(Native.NETTING_PROOF))
    files.putNettingProof("s2", vk, ByteArray(Native.NETTING_PROOF))
    files.forgetNetting("s1")
    assertFalse(files.nettingWitness("s1").exists())
    assertNull(files.nettingProof("s1", vk))
    assertTrue(files.nettingProof("s2", vk) != null)
  }
}
