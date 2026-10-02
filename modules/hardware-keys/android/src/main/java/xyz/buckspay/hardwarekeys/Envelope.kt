package xyz.buckspay.hardwarekeys

import expo.modules.kotlin.exception.CodedException
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicReference

internal class UnknownClusterException : CodedException("Unknown cluster")

internal class AlreadyConfiguredException : CodedException("Already configured for another cluster or program")

internal object Envelope {
  val PURPOSES = setOf("note", "device", "witness", "reclaim", "payword", "iou", "voice", "claim")

  /** The purposes this device signs; the others are signed once their messages are defined. */
  val SIGNED = setOf("note", "witness")
  private val TAG = "BUCKSPAY:v1:".toByteArray(Charsets.US_ASCII)

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
    val domains: Domains,
  )

  private val target = AtomicReference<Target?>()

  val domains: Domains? get() = target.get()?.domains

  /** Sets the target; repeating the same one is a no-op, and any other one is refused. */
  fun configure(
    cluster: String,
    programId: ByteArray,
  ) {
    val genesisHash = Envelope.GENESIS_HASHES[cluster] ?: throw UnknownClusterException()
    val next = Target(cluster, programId.copyOf(), Domains(genesisHash, programId))
    if (target.compareAndSet(null, next)) return
    val current = checkNotNull(target.get())
    if (current.cluster != cluster || !current.programId.contentEquals(programId)) throw AlreadyConfiguredException()
  }
}
