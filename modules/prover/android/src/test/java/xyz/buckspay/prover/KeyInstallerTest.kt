package xyz.buckspay.prover

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.security.MessageDigest

class KeyInstallerTest {
  @get:Rule val tmp = TemporaryFolder()

  private val files by lazy { ProverFiles(tmp.newFolder("zk")) }
  private val ccs = ByteArray(40) { 1 }
  private val pk = ByteArray(80) { 2 }

  private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  private val spec =
    KeySpec("cd".repeat(32), "https://k/pk", hash(pk), "https://k/ccs", hash(ccs), hash(FakeProver.DUMP))
  private val bodies = mapOf("https://k/pk" to pk, "https://k/ccs" to ccs)

  @Test
  fun aVerifiedKeyIsExpandedAndMarkedReady() {
    val states = mutableListOf<String>()
    KeyInstaller(files, FakeFetch(bodies), FakeProver()).install(spec) { state, _ -> states += state }
    assertTrue(files.keyReady(spec.vkSha256))
    assertTrue(states.containsAll(listOf("downloading", "expanding")))
    val dir = files.keyDir(spec.vkSha256)
    assertTrue(dir.resolve("pk.dump").exists() && dir.resolve("ccs.bin").exists())
    assertFalse("the compressed key is not kept", dir.resolve("pk.bin").exists())
  }

  @Test
  fun aFileThatDoesNotMatchItsHashIsRefusedAndNothingIsKept() {
    val tampered = bodies + ("https://k/pk" to ByteArray(80) { 9 })
    val error = assertThrows(KeyException::class.java) { KeyInstaller(files, FakeFetch(tampered), FakeProver()).install(spec) { _, _ -> } }
    assertEquals("hash", error.reason)
    assertFalse(files.keyDir(spec.vkSha256).exists())
  }

  @Test
  fun aDumpThatDoesNotMatchItsHashIsRefused() {
    val wrong = spec.copy(dumpSha256 = "00".repeat(32))
    val error = assertThrows(KeyException::class.java) { KeyInstaller(files, FakeFetch(bodies), FakeProver()).install(wrong) { _, _ -> } }
    assertEquals("hash", error.reason)
    assertFalse(files.keyReady(spec.vkSha256))
  }

  @Test
  fun aFailedExpansionLeavesNoKey() {
    assertThrows(KeyException::class.java) {
      KeyInstaller(files, FakeFetch(bodies), FakeProver(expandCode = Native.BAD_ARGS)).install(spec) { _, _ -> }
    }
    assertFalse(files.keyDir(spec.vkSha256).exists())
  }

  @Test
  fun aNetworkFailureIsReportedAsRetryable() {
    val error =
      assertThrows(KeyException::class.java) { KeyInstaller(files, FakeFetch(emptyMap()), FakeProver()).install(spec) { _, _ -> } }
    assertEquals("network", error.reason)
  }

  @Test
  fun aReadyKeyIsNotDownloadedAgain() {
    val fetch = FakeFetch(bodies)
    val installer = KeyInstaller(files, fetch, FakeProver())
    installer.install(spec) { _, _ -> }
    fetch.opened.clear()
    installer.install(spec) { _, _ -> }
    assertTrue(fetch.opened.isEmpty())
  }

  @Test
  fun onlyHttpsIsFetched() {
    assertThrows(IllegalArgumentException::class.java) { HttpsFetch.open("http://k/pk") }
  }
}
