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

  private val iou = vectors.getValue("iou").jsonObject
  private val iouStates = iou.getValue("states").jsonArray.map { it.jsonObject }
  private val joins =
    vectors
      .getValue("nettingJoin")
      .jsonObject
      .getValue("joins")
      .jsonArray
      .map { it.jsonObject }
  private val statements =
    vectors
      .getValue("netting")
      .jsonObject
      .getValue("statements")
      .jsonArray
      .map { it.jsonObject }
  private val iouDomain = iou.getValue("domain").jsonObject.bytes("devnet")

  private fun sha256(vararg parts: ByteArray) =
    java.security.MessageDigest.getInstance("SHA-256").run {
      parts.forEach(::update)
      digest()
    }

  @Test
  fun signsNotesWitnessesChannelCommitmentsAndIous() {
    assertEquals(setOf("note", "witness", "payword", "iou"), Envelope.SIGNED)
    assertTrue(Envelope.PURPOSES.containsAll(Envelope.SIGNED))
    assertFalse("netting is signed with ephemeral Ed25519 keys, never by the device", "netting" in Envelope.PURPOSES)
  }

  @Test
  fun iouEnvelopeMatchesVectors() {
    assertArrayEquals(Domains(genesisHash, programId).of("iou"), iouDomain)
    for (state in iouStates) {
      val body = state.bytes("body")
      val envelope = Envelope.build(iouDomain, Envelope.iouSlot(body), sha256(body))
      assertArrayEquals(state.getValue("name").jsonPrimitive.content, state.getValue("envelope").jsonObject.bytes("devnet"), envelope)
    }
    for (join in joins) {
      val body = join.bytes("body")
      assertArrayEquals(join.bytes("envelope"), Envelope.build(iouDomain, Envelope.iouSlot(body), sha256(body)))
    }
  }

  @Test
  fun slotDerivedFromBody() {
    for (state in iouStates) assertArrayEquals(state.bytes("slot"), Envelope.iouSlot(state.bytes("body")))
    for (join in joins) assertArrayEquals(join.bytes("slot"), Envelope.iouSlot(join.bytes("body")))
    val body = iouStates.first().bytes("body")
    assertArrayEquals(sha256("IOUS".toByteArray(), body.copyOfRange(2, 38)), Envelope.iouSlot(body))
    val nextSeq = body.copyOf().also { it[34] = (it[34] + 1).toByte() }
    assertFalse(Envelope.iouSlot(nextSeq).contentEquals(Envelope.iouSlot(body)))
    val otherAmount = body.copyOf().also { it[136] = (it[136] + 1).toByte() }
    assertArrayEquals("the slot ignores the amount; the content does not", Envelope.iouSlot(body), Envelope.iouSlot(otherAmount))
    assertArrayEquals("one join slot per session", Envelope.iouSlot(joins[0].bytes("body")), Envelope.iouSlot(joins[1].bytes("body")))
  }

  @Test
  fun refusesUnknownKindAndBadLength() {
    val body = iouStates.first().bytes("body")
    val join = joins.first().bytes("body")
    val bad =
      listOf(
        body.copyOf(212),
        body.copyOf(214),
        body.copyOf().also { it[0] = 2 },
        body.copyOf().also { it[1] = 0x40 },
        body.copyOf().also { it[1] = 0x31 },
        body.copyOf().also { for (i in 34 until 38) it[i] = 0 },
        body.copyOf().also { it[148] = 3 },
        body.copyOf().also { it[148] = 0 },
        body.copyOf().also { it[148] = 5 },
        join.copyOf(98),
        join.copyOf().also { it[1] = 0x30 },
        ByteArray(0),
      ) + statements.map { it.bytes("body") }
    for ((i, b) in bad.withIndex()) {
      assertThrows("case $i", IllegalArgumentException::class.java) { Envelope.iouSlot(b) }
    }
  }

  @Test
  fun signersAreThePartiesOfTheBody() {
    val keys = iou.getValue("keys").jsonObject
    val open = iouStates.first { it.getValue("name").jsonPrimitive.content == "open" }.bytes("body")
    val signers = Envelope.iouSigners(open)
    assertEquals(2, signers.size)
    assertArrayEquals(keys.bytes("debtor"), signers[0])
    assertArrayEquals(keys.bytes("creditor"), signers[1])
    val join = joins.first().bytes("body")
    assertArrayEquals(join.copyOfRange(66, 99), Envelope.iouSigners(join).single())
    val uncompressed = open.copyOf().also { it[38] = 0x04 }
    assertThrows(IllegalArgumentException::class.java) { Envelope.iouSigners(uncompressed) }
  }

  @Test
  fun purposesAreTheProtocolPurposesExceptTicket() {
    val expected = setOf("note", "device", "witness", "reclaim", "payword", "iou", "voice", "claim", "revoke")
    assertEquals(expected, Envelope.PURPOSES)
    assertEquals(expected, domains.keys - setOf("genesis_hash", "program_id", "ticket"))
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
