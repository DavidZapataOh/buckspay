package xyz.buckspay.prover

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class FilesTest {
  @get:Rule val tmp = TemporaryFolder()

  private val files by lazy { ProverFiles(tmp.newFolder("zk")) }
  private val proof = ByteArray(Native.PROOF_AND_PUBLIC) { 3 }
  private val vk = "ab".repeat(32)

  @Test
  fun aNoteIdCannotEscapeTheDirectory() {
    assertThrows(IllegalArgumentException::class.java) { files.chain("../x") }
    assertThrows(IllegalArgumentException::class.java) { files.proved("a/b", vk) }
    assertThrows(IllegalArgumentException::class.java) { files.chain("") }
  }

  @Test
  fun proofsAreStoredReadAndForgottenByIndexUnderTheirKey() {
    files.putProof("n1", vk, 2, proof)
    files.putProof("n1", vk, 0, proof)
    assertEquals(listOf(0, 2), files.readProofs("n1", vk).map { it.first })
    assertArrayEquals(proof, files.readProofs("n1", vk)[0].second)
    files.dropProofs("n1", vk, listOf(0))
    assertEquals(setOf(2), files.proved("n1", vk))
  }

  @Test
  fun aProofMadeUnderAnotherKeyIsNotSeen() {
    files.putProof("n1", vk, 0, proof)
    assertEquals(emptySet<Int>(), files.proved("n1", "cd".repeat(32)))
  }

  @Test
  fun forgettingANoteRemovesItsChainAndEveryProof() {
    files.putChain("n1", byteArrayOf(1, 2))
    files.putProof("n1", vk, 0, proof)
    files.forget("n1")
    assertFalse(files.chain("n1").exists())
    assertEquals(emptySet<Int>(), files.proved("n1", vk))
  }

  @Test
  fun aProofOfTheWrongSizeOrIndexIsRefused() {
    assertThrows(IllegalArgumentException::class.java) { files.putProof("n1", vk, 0, ByteArray(5)) }
    assertThrows(IllegalArgumentException::class.java) { files.putProof("n1", vk, 17, proof) }
    assertThrows(IllegalArgumentException::class.java) { files.putProof("n1", vk, -1, proof) }
  }

  @Test
  fun keysAreNamedByTheirHashAndReadyOnlyOnceMarked() {
    assertThrows(IllegalArgumentException::class.java) { files.keyDir("not-a-hash") }
    assertFalse(files.keyReady(vk))
    files.keyDir(vk).mkdirs()
    files.markKeyReady(vk)
    assertTrue(files.keyReady(vk))
    files.dropKey(vk)
    assertFalse(files.keyReady(vk))
  }
}
