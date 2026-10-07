package xyz.buckspay.prover

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ProveRunTest {
  @get:Rule val tmp = TemporaryFolder()

  private val files by lazy { ProverFiles(tmp.newFolder("zk")) }
  private val vk = "a".repeat(64)

  private fun run(
    prover: Prover,
    requested: List<Int>,
    progress: MutableList<Pair<Int, Int>> = mutableListOf(),
  ) = runBlocking {
    files.putChain("n1", byteArrayOf(1))
    ProveRun(prover, files).run("n1", vk, requested) { done, total -> progress += done to total }
  }

  @Test
  fun planKeepsOnlyTheMessagesWithoutAProof() {
    assertEquals(listOf(3, 4), ProveRun.plan(listOf(0, 1, 2, 3, 4), setOf(0, 1, 2)))
    assertEquals(emptyList<Int>(), ProveRun.plan(listOf(0, 1), setOf(0, 1, 5)))
  }

  @Test
  fun everyProofIsOnDiskAsSoonAsItExistsAndProgressCountsThem() {
    val seen = mutableListOf<Int>()
    val progress = mutableListOf<Pair<Int, Int>>()
    val prover = FakeProver(onProve = { seen += files.proved("n1", vk).size })
    assertEquals(ProveOutcome.Done, run(prover, listOf(0, 1, 2), progress))
    assertEquals(listOf(0, 1, 2), seen)
    assertEquals(setOf(0, 1, 2), files.proved("n1", vk))
    assertEquals(listOf(0 to 3, 1 to 3, 2 to 3, 3 to 3), progress)
    assertEquals(1, prover.loads)
    assertEquals(1, prover.releases)
  }

  @Test
  fun aRestartProvesOnlyWhatIsMissing() {
    val first = FakeProver(failAt = mapOf(2 to Native.BAD_ARGS))
    assertEquals(ProveOutcome.Failed("invalid"), run(first, listOf(0, 1, 2, 3)))
    assertEquals(setOf(0, 1), files.proved("n1", vk))
    val second = FakeProver()
    assertEquals(ProveOutcome.Done, run(second, listOf(0, 1, 2, 3)))
    assertEquals(listOf(2, 3), second.proved)
  }

  @Test
  fun aMissingKeyOrChainFailsWithoutProving() {
    val prover = FakeProver(loadCode = Native.NO_KEY)
    assertEquals(ProveOutcome.Failed("no-key"), run(prover, listOf(0)))
    assertTrue(prover.proved.isEmpty())
    assertEquals(ProveOutcome.Failed("no-chain"), runBlocking { ProveRun(prover, files).run("n2", vk, listOf(0)) { _, _ -> } })
  }

  @Test
  fun theKeyIsReleasedWhenTheRunIsCancelled() {
    val prover = FakeProver()
    val job =
      Thread {
        runBlocking {
          files.putChain("n1", byteArrayOf(1))
          try {
            ProveRun(prover, files).run("n1", vk, listOf(0, 1)) { done, _ -> if (done == 1) throw CancellationException() }
          } catch (_: CancellationException) {
          }
        }
      }
    job.start()
    job.join()
    assertEquals(1, prover.releases)
    assertEquals(setOf(0), files.proved("n1", vk))
  }
}
