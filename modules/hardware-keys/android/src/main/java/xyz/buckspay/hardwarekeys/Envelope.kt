package xyz.buckspay.hardwarekeys

import expo.modules.kotlin.exception.CodedException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicReference

internal class UnknownClusterException : CodedException("Unknown cluster")

internal class AlreadyConfiguredException : CodedException("Already configured for another cluster or program")

internal object Envelope {
  val PURPOSES = setOf("note", "device", "witness", "reclaim", "payword", "iou", "voice", "claim", "revoke")

  /** The purposes this device signs; the others are signed once their messages are defined. */
  val SIGNED = setOf("note", "witness", "payword", "iou")
  private val TAG = "BUCKSPAY:v1:".toByteArray(Charsets.US_ASCII)
  private const val VERSION: Byte = 1
  private const val DEVICE_BINDING: Byte = 0x50
  private const val RECLAIM: Byte = 0x60
  private const val TAB_STATE: Byte = 0x30
  private const val NETTING_JOIN: Byte = 0x31
  private const val TAB_STATE_LEN = 213
  private const val JOIN_LEN = 99
  private val SIGNED_CAUSES = setOf(1, 2, 4)
  private val IOU_TAG = "IOUS".toByteArray(Charsets.US_ASCII)
  private val JOIN_TAG = "NETJ".toByteArray(Charsets.US_ASCII)
  private const val UINT_MAX = 0xffff_ffffL
  private val SPKI_P256_PREFIX = hex("3059301306072a8648ce3d020106082a8648ce3d030107034200")

  /** Genesis hashes of the clusters the app signs for, pinned here and never read from a node. */
  val GENESIS_HASHES =
    mapOf(
      "devnet" to hex("ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab"),
      "mainnet" to hex("45296998a6f8e2a784db5d9f95e18fc23f70441a1039446801089879b08c7ef0"),
    )

  fun domain(
    purpose: String,
    genesisHash: ByteArray,
    programId: ByteArray,
  ): ByteArray {
    require(purpose in PURPOSES) { "unknown purpose" }
    require(genesisHash.size == 32 && programId.size == 32) { "genesis hash and program id are 32 bytes" }
    return MessageDigest.getInstance("SHA-256").run {
      update(TAG)
      update(purpose.toByteArray(Charsets.US_ASCII))
      update(genesisHash)
      update(programId)
      digest()
    }
  }

  fun build(
    domain: ByteArray,
    slot: ByteArray,
    content: ByteArray,
  ): ByteArray {
    require(domain.size == 32 && slot.size == 32 && content.size == 32) { "envelope parts are 32 bytes" }
    return domain + slot + content
  }

  /**
   * `DOMAIN(device) ‖ wallet ‖ SHA-256(ver ‖ 0x50 ‖ wallet ‖ key)`: the device key `key`, SEC1
   * compressed, consents to being bound to `wallet`.
   */
  fun deviceBinding(
    deviceDomain: ByteArray,
    wallet: ByteArray,
    key: ByteArray,
  ): ByteArray {
    require(wallet.size == 32) { "a wallet is 32 bytes" }
    require(key.size == 33 && (key[0] == 0x02.toByte() || key[0] == 0x03.toByte())) { "a device key is a compressed point" }
    val body = byteArrayOf(VERSION, DEVICE_BINDING) + wallet + key
    return build(deviceDomain, wallet, MessageDigest.getInstance("SHA-256").digest(body))
  }

  /**
   * `DOMAIN(reclaim) ‖ output ‖ SHA-256(ver ‖ 0x60 ‖ deadline:u32 LE)`: the owner of `output` takes it
   * back, with a signature that may be used until `deadline`. The message names no destination.
   */
  fun reclaim(
    reclaimDomain: ByteArray,
    output: ByteArray,
    deadline: Long,
  ): ByteArray {
    require(output.size == 32) { "an output id is 32 bytes" }
    require(deadline in 0..UINT_MAX) { "a deadline is a u32" }
    val body =
      ByteBuffer
        .allocate(6)
        .order(ByteOrder.LITTLE_ENDIAN)
        .put(VERSION)
        .put(RECLAIM)
        .putInt(deadline.toInt())
    return build(reclaimDomain, output, MessageDigest.getInstance("SHA-256").digest(body.array()))
  }

  /**
   * The guard slot of a tab state (0x30, `SHA-256("IOUS" ‖ tab ‖ seq)`) or a netting join (0x31,
   * `SHA-256("NETJ" ‖ session)`); `IllegalArgumentException` for any other body, a state with
   * `seq = 0`, and a cause other than Open, Repay or Outside (a netting is never signed as a state).
   */
  fun iouSlot(body: ByteArray): ByteArray =
    MessageDigest.getInstance("SHA-256").run {
      when {
        isTabState(body) -> {
          update(IOU_TAG)
          update(body, 2, 36)
        }

        isJoin(body) -> {
          update(JOIN_TAG)
          update(body, 2, 32)
        }

        else -> {
          throw IllegalArgumentException("not a tab state or a netting join")
        }
      }
      digest()
    }

  /** The keys allowed to sign `body`, SEC1 compressed: `[debtor, creditor]` of a tab state or `[key]` of a join. */
  fun iouSigners(body: ByteArray): List<ByteArray> {
    val keys =
      when {
        isTabState(body) -> listOf(body.copyOfRange(38, 71), body.copyOfRange(71, 104))
        isJoin(body) -> listOf(body.copyOfRange(66, 99))
        else -> throw IllegalArgumentException("not a tab state or a netting join")
      }
    require(keys.all { it[0] == 0x02.toByte() || it[0] == 0x03.toByte() }) { "a signer is a compressed point" }
    return keys
  }

  private fun isTabState(body: ByteArray) =
    body.size == TAB_STATE_LEN &&
      body[0] == VERSION &&
      body[1] == TAB_STATE &&
      ByteBuffer.wrap(body).order(ByteOrder.LITTLE_ENDIAN).getInt(34) != 0 &&
      body[148].toInt() in SIGNED_CAUSES

  private fun isJoin(body: ByteArray) = body.size == JOIN_LEN && body[0] == VERSION && body[1] == NETTING_JOIN

  /** The SEC1 compressed point of a P-256 X.509 public key in the encoding Keystore returns. */
  fun compressed(spki: ByteArray): ByteArray {
    require(spki.size == 91 && spki.copyOf(SPKI_P256_PREFIX.size).contentEquals(SPKI_P256_PREFIX)) { "not a P-256 X.509 key" }
    val parity: Byte = if (spki[90].toInt() and 1 == 0) 0x02 else 0x03
    return byteArrayOf(parity) + spki.copyOfRange(27, 59)
  }

  private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}

internal class Domains(
  genesisHash: ByteArray,
  programId: ByteArray,
) {
  private val domains = Envelope.PURPOSES.associateWith { Envelope.domain(it, genesisHash, programId) }

  fun of(purpose: String): ByteArray = requireNotNull(domains[purpose]) { "unknown purpose" }
}

/** The cluster and program every signature is bound to, set once per process. */
internal class Configuration {
  private class Target(
    val cluster: String,
    val programId: ByteArray,
    val grace: Long,
    val domains: Domains,
  )

  private val target = AtomicReference<Target?>()

  val domains: Domains? get() = target.get()?.domains

  /** The seconds after an output's expiry during which its payee can still settle it. */
  val grace: Long? get() = target.get()?.grace

  /** Sets the target; repeating the same one is a no-op, and any other one is refused. */
  fun configure(
    cluster: String,
    programId: ByteArray,
    grace: Long,
  ) {
    val genesisHash = Envelope.GENESIS_HASHES[cluster] ?: throw UnknownClusterException()
    val next = Target(cluster, programId.copyOf(), grace, Domains(genesisHash, programId))
    if (target.compareAndSet(null, next)) return
    val current = checkNotNull(target.get())
    if (current.cluster != cluster || !current.programId.contentEquals(programId) || current.grace != grace) {
      throw AlreadyConfiguredException()
    }
  }
}
