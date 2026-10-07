package xyz.buckspay.prover

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ClaimRunTest {
  @get:Rule val tmp = TemporaryFolder()

  private val files by lazy { ProverFiles(tmp.newFolder("zk")) }
  private val vk = "b".repeat(64)
  private val request = ByteArray(821) { 5 }

  private fun run(prover: Prover): ProveOutcome {
    files.putClaimRequest("c1", request)
    return ClaimRun(prover, files).run("c1", vk)
  }

  @Test
  fun aProvedClaimIsOnDiskAndItsSecretsAreGone() {
    val prover = FakeProver()
    assertEquals(ProveOutcome.Done, run(prover))
    val stored = files.claimProof("c1", vk)!!
    assertEquals(Native.CLAIM_PROOF_AND_PUBLIC, stored.size)
    assertFalse(files.claimRequest("c1").exists())
    assertArrayEquals(request, prover.claimed.single())
    assertEquals(1, prover.releases)
  }

  @Test
  fun aRefusedRequestIsDeletedAndReportedInvalid() {
    val prover = FakeProver(claimFailure = Native.FAILED)
    assertEquals(ProveOutcome.Failed("invalid"), run(prover))
    assertFalse(files.claimRequest("c1").exists())
    assertNull(files.claimProof("c1", vk))
    assertEquals(1, prover.releases)
  }

  @Test
  fun aMissingKeyKeepsTheRequestForTheNextRun() {
    assertEquals(ProveOutcome.Failed("no-key"), run(FakeProver(loadCode = Native.NO_KEY)))
    assertTrue(files.claimRequest("c1").exists())
    assertEquals(ProveOutcome.Failed("no-key"), run(FakeProver(claimFailure = Native.NO_KEY)))
    assertTrue(files.claimRequest("c1").exists())
  }

  @Test
  fun aRunWithoutARequestSaysSo() {
    assertEquals(ProveOutcome.Failed("no-request"), ClaimRun(FakeProver(), files).run("c1", vk))
  }

  @Test
  fun aClaimThatIsAlreadyProvedIsNotProvedAgain() {
    files.putClaimProof("c1", vk, ByteArray(Native.CLAIM_PROOF_AND_PUBLIC))
    val prover = FakeProver()
    assertEquals(ProveOutcome.Done, run(prover))
    assertTrue(prover.claimed.isEmpty())
    assertFalse(files.claimRequest("c1").exists())
  }

  @Test
  fun forgetClaimRemovesTheRequestAndEveryProof() {
    files.putClaimRequest("c1", request)
    files.putClaimProof("c1", vk, ByteArray(Native.CLAIM_PROOF_AND_PUBLIC))
    files.putClaimProof("c1", "c".repeat(64), ByteArray(Native.CLAIM_PROOF_AND_PUBLIC))
    files.putClaimProof("c2", vk, ByteArray(Native.CLAIM_PROOF_AND_PUBLIC))
    files.forgetClaim("c1")
    assertFalse(files.claimRequest("c1").exists())
    assertNull(files.claimProof("c1", vk))
    assertNull(files.claimProof("c1", "c".repeat(64)))
    assertTrue(files.claimProof("c2", vk) != null)
  }

  @Test
  fun aProofOfTheWrongSizeAndAnUnsafeIdAreRefused() {
    assertThrows(IllegalArgumentException::class.java) { files.putClaimProof("c1", vk, ByteArray(10)) }
    assertThrows(IllegalArgumentException::class.java) { files.claimRequest("../x") }
  }
}
