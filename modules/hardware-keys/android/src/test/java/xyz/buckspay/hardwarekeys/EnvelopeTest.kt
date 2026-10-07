package xyz.buckspay.hardwarekeys

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.HexFormat

class EnvelopeTest {
  private companion object {
    /** The production grace period: seven days. */
    const val GRACE = 604_800L
  }

  private val vectors = Json.parseToJsonElement(File("../../../anchor/crates/protocol/tests/vectors/v1.json").readText()).jsonObject
  private val domains = vectors.getValue("domain").jsonObject
  private val clusters = vectors.getValue("clusters").jsonObject
  private val genesisHash = domains.bytes("genesis_hash")
  private val programId = domains.bytes("program_id")

  @Test
  fun purposesAreTheProtocolPurposesExceptTicket() {
    val expected = setOf("note", "device", "witness", "reclaim", "payword", "iou", "voice", "claim", "revoke")
    assertEquals(expected, Envelope.PURPOSES)
    assertEquals(expected, domains.keys - setOf("genesis_hash", "program_id", "ticket"))
  }

  @Test
  fun signsNotesWitnessesAndChannelCommitmentsOnly() {
    assertEquals(setOf("note", "witness", "payword"), Envelope.SIGNED)
    assertTrue(Envelope.PURPOSES.containsAll(Envelope.SIGNED))
  }

  @Test
  fun domainsMatchTheProtocolVectors() {
    for (purpose in Envelope.PURPOSES) {
      assertArrayEquals(purpose, domains.bytes(purpose), Envelope.domain(purpose, genesisHash, programId))
      assertArrayEquals(purpose, domains.bytes(purpose), Domains(genesisHash, programId).of(purpose))
    }
  }

  @Test
  fun genesisHashesAreTheProtocolClusters() {
    assertEquals(clusters.keys, Envelope.GENESIS_HASHES.keys)
    for ((cluster, hash) in Envelope.GENESIS_HASHES) assertArrayEquals(cluster, clusters.bytes(cluster), hash)
    assertArrayEquals(genesisHash, Envelope.GENESIS_HASHES.getValue("devnet"))
  }

  @Test
  fun domainsDependOnTheCluster() {
    assertFalse(Domains(clusters.bytes("mainnet"), programId).of("note").contentEquals(domains.bytes("note")))
  }

  @Test
  fun buildConcatenatesThreeParts() {
    val slot = ByteArray(32) { 1 }
    val content = ByteArray(32) { 2 }
    val domain = Domains(genesisHash, programId).of("note")
    val envelope = Envelope.build(domain, slot, content)
    assertEquals(96, envelope.size)
    assertArrayEquals(domain + slot + content, envelope)
  }

  @Test
  fun buildRejectsPartsThatAreNot32Bytes() {
    val part = ByteArray(32)
    for (bad in listOf(ByteArray(31), ByteArray(33), ByteArray(0))) {
      assertThrows(IllegalArgumentException::class.java) { Envelope.build(bad, part, part) }
      assertThrows(IllegalArgumentException::class.java) { Envelope.build(part, bad, part) }
      assertThrows(IllegalArgumentException::class.java) { Envelope.build(part, part, bad) }
    }
  }

  @Test
  fun rejectsUnknownPurposesAndWrongSizes() {
    val domains = Domains(genesisHash, programId)
    assertThrows(IllegalArgumentException::class.java) { domains.of("ticket") }
    assertThrows(IllegalArgumentException::class.java) { domains.of("x") }
    assertThrows(IllegalArgumentException::class.java) { Envelope.domain("ticket", genesisHash, programId) }
    assertThrows(IllegalArgumentException::class.java) { Domains(ByteArray(31), programId) }
    assertThrows(IllegalArgumentException::class.java) { Domains(genesisHash, ByteArray(33)) }
  }

  @Test
  fun configuresOnceWithThePinnedGenesisHash() {
    val configuration = Configuration()
    assertNull(configuration.domains)
    configuration.configure("devnet", programId, GRACE)
    assertArrayEquals(domains.bytes("note"), configuration.domains?.of("note"))
    assertEquals(GRACE, configuration.grace)
    configuration.configure("devnet", programId.copyOf(), GRACE)
    assertArrayEquals(domains.bytes("note"), configuration.domains?.of("note"))
  }

  @Test
  fun refusesAnotherClusterOrProgramOnceConfigured() {
    val configuration = Configuration()
    configuration.configure("devnet", programId, GRACE)
    assertThrows(AlreadyConfiguredException::class.java) { configuration.configure("mainnet", programId, GRACE) }
    assertThrows(AlreadyConfiguredException::class.java) { configuration.configure("devnet", ByteArray(32), GRACE) }
    assertThrows(AlreadyConfiguredException::class.java) { configuration.configure("devnet", programId, GRACE + 1) }
    assertArrayEquals(domains.bytes("note"), configuration.domains?.of("note"))
    assertEquals("ERR_ALREADY_CONFIGURED", AlreadyConfiguredException().code)
  }

  @Test
  fun reclaimsMatchTheProtocolVectors() {
    val reclaimDomain = domains.bytes("reclaim")
    val reclaims = vectors.getValue("reclaims").jsonObject
    val cases = reclaims.getValue("cases").jsonArray.map { it.jsonObject }
    assertTrue(cases.isNotEmpty())
    for (vector in cases) {
      val deadline =
        vector
          .getValue("deadline")
          .jsonPrimitive.content
          .toLong()
      assertArrayEquals(vector.bytes("envelope"), Envelope.reclaim(reclaimDomain, vector.bytes("output"), deadline))
    }
  }

  @Test
  fun refusesAReclaimOfAnOutputOrADeadlineThatDoesNotFit() {
    val reclaimDomain = domains.bytes("reclaim")
    assertThrows(IllegalArgumentException::class.java) { Envelope.reclaim(reclaimDomain, ByteArray(31), 1) }
    assertThrows(IllegalArgumentException::class.java) { Envelope.reclaim(reclaimDomain, ByteArray(32), -1) }
    assertThrows(IllegalArgumentException::class.java) { Envelope.reclaim(reclaimDomain, ByteArray(32), 0x1_0000_0000L) }
    assertEquals(32 * 3, Envelope.reclaim(reclaimDomain, ByteArray(32), 0xffff_ffffL).size)
  }

  @Test
  fun refusesAnUnknownClusterOrAMalformedProgramId() {
    val configuration = Configuration()
    for (cluster in listOf("testnet", "localnet", "", "Devnet")) {
      assertThrows(UnknownClusterException::class.java) { configuration.configure(cluster, programId, GRACE) }
    }
    assertThrows(IllegalArgumentException::class.java) { configuration.configure("devnet", ByteArray(31), GRACE) }
    assertNull(configuration.domains)
    assertEquals("ERR_UNKNOWN_CLUSTER", UnknownClusterException().code)
  }

  @Test
  fun deviceBindingsMatchTheProtocolVectors() {
    val deviceDomain = domains.bytes("device")
    for (vector in vectors.getValue("device_bindings").jsonArray.map { it.jsonObject }) {
      val name = vector.getValue("name").jsonPrimitive.content
      val error = vector.getValue("error").jsonPrimitive.content
      val build = { Envelope.deviceBinding(deviceDomain, vector.bytes("wallet"), vector.bytes("device")) }
      if (error.isEmpty()) {
        assertArrayEquals(name, vector.bytes("envelope"), build())
      } else {
        assertThrows(name, IllegalArgumentException::class.java) { build() }
      }
    }
    val wallet = ByteArray(32)
    val key = ByteArray(33) { 2 }
    assertThrows(IllegalArgumentException::class.java) { Envelope.deviceBinding(deviceDomain, ByteArray(31), key) }
    assertThrows(IllegalArgumentException::class.java) { Envelope.deviceBinding(deviceDomain, wallet, ByteArray(32) { 2 }) }
    assertThrows(IllegalArgumentException::class.java) { Envelope.deviceBinding(ByteArray(31), wallet, key) }
  }

  @Test
  fun compressesKeystorePublicKeys() {
    val fixture = Json.parseToJsonElement(File("../../../src/keys/fixtures/p256-der.json").readText()).jsonObject
    val cases = fixture.getValue("cases").jsonArray.map { it.jsonObject }
    for (case in cases) assertArrayEquals(case.bytes("sec1"), Envelope.compressed(case.bytes("spki")))
    val spki = cases.first().bytes("spki")
    assertThrows(IllegalArgumentException::class.java) { Envelope.compressed(spki.copyOf(90)) }
    assertThrows(IllegalArgumentException::class.java) { Envelope.compressed(spki.copyOf().also { it[0] = 0 }) }
  }

  private fun JsonObject.bytes(key: String) = HexFormat.of().parseHex(getValue(key).jsonPrimitive.content)
}
