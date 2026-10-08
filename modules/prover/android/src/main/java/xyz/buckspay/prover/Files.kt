package xyz.buckspay.prover

import java.io.File
import java.io.InputStream
import java.security.MessageDigest

private val NOTE_ID = Regex("[A-Za-z0-9_-]{1,128}")
private val HASH = Regex("[0-9a-f]{64}")

internal fun checkNoteId(noteId: String): String {
  require(NOTE_ID.matches(noteId)) { "invalid note id" }
  return noteId
}

internal fun checkHash(hash: String): String {
  require(HASH.matches(hash)) { "invalid hash" }
  return hash
}

internal fun sha256(stream: InputStream): String {
  val digest = MessageDigest.getInstance("SHA-256")
  val buffer = ByteArray(1 shl 16)
  while (true) {
    val read = stream.read(buffer)
    if (read < 0) break
    digest.update(buffer, 0, read)
  }
  return digest.digest().joinToString("") { "%02x".format(it) }
}

internal fun File.sha256() = inputStream().use { sha256(it) }

/**
 * Everything the prover keeps on disk, under one private root: the chains it was asked to prove, the
 * proofs made so far (one file each, written as soon as it exists so a killed process loses none), and
 * the keys, one directory per verifying key hash.
 */
internal class ProverFiles(
  private val root: File,
) {
  private fun chains() = File(root, "chains").apply { mkdirs() }

  private fun proofs(noteId: String) = File(File(root, "proofs"), checkNoteId(noteId))

  private fun proofs(
    noteId: String,
    vkSha256: String,
  ) = File(proofs(noteId), checkHash(vkSha256))

  fun chain(noteId: String) = File(chains(), checkNoteId(noteId))

  fun putChain(
    noteId: String,
    chain: ByteArray,
  ) = atomicWrite(chain(noteId), chain)

  fun proved(
    noteId: String,
    vkSha256: String,
  ): Set<Int> = proofs(noteId, vkSha256).list()?.mapNotNull { it.toIntOrNull() }?.toSet() ?: emptySet()

  fun putProof(
    noteId: String,
    vkSha256: String,
    index: Int,
    bytes: ByteArray,
  ) {
    require(bytes.size == Native.PROOF_AND_PUBLIC && index in 0 until MAX_MESSAGES) { "invalid proof" }
    val dir = proofs(noteId, vkSha256).apply { mkdirs() }
    atomicWrite(File(dir, index.toString()), bytes)
  }

  /** The proofs of a note under one key as `(index, bytes)`, in index order. */
  fun readProofs(
    noteId: String,
    vkSha256: String,
  ): List<Pair<Int, ByteArray>> = proved(noteId, vkSha256).sorted().map { it to File(proofs(noteId, vkSha256), it.toString()).readBytes() }

  /** Forgets the proofs of the given indices once the app has stored them. */
  fun dropProofs(
    noteId: String,
    vkSha256: String,
    indices: Collection<Int>,
  ) {
    indices.forEach { File(proofs(noteId, vkSha256), it.toString()).delete() }
  }

  fun forget(noteId: String) {
    proofs(noteId).deleteRecursively()
    chain(noteId).delete()
  }

  fun claimRequest(claimId: String) = File(File(root, "claim-requests"), checkNoteId(claimId))

  fun putClaimRequest(
    claimId: String,
    request: ByteArray,
  ) = atomicWrite(claimRequest(claimId), request)

  fun dropClaimRequest(claimId: String) {
    claimRequest(claimId).delete()
  }

  private fun claimProofFile(
    claimId: String,
    vkSha256: String,
  ) = File(File(File(root, "claim-proofs"), checkHash(vkSha256)), checkNoteId(claimId))

  fun claimProof(
    claimId: String,
    vkSha256: String,
  ): ByteArray? = claimProofFile(claimId, vkSha256).takeIf { it.exists() }?.readBytes()

  fun putClaimProof(
    claimId: String,
    vkSha256: String,
    bytes: ByteArray,
  ) {
    require(bytes.size == Native.CLAIM_PROOF_AND_PUBLIC) { "invalid claim proof" }
    atomicWrite(claimProofFile(claimId, vkSha256), bytes)
  }

  /** Forgets a claim's request and its proofs under every key once the app has stored the proof or given up. */
  fun forgetClaim(claimId: String) {
    dropClaimRequest(claimId)
    File(root, "claim-proofs").listFiles()?.forEach { File(it, checkNoteId(claimId)).delete() }
  }

  fun nettingWitness(sessionId: String) = File(File(root, "netting-witnesses"), checkNoteId(sessionId))

  fun putNettingWitness(
    sessionId: String,
    witness: ByteArray,
  ) = atomicWrite(nettingWitness(sessionId), witness)

  /** Overwrites the witness with zeros before deleting it, with any half-written copy. */
  fun dropNettingWitness(sessionId: String) {
    val file = nettingWitness(sessionId)
    listOf(file, File(file.path + ".part")).filter { it.exists() }.forEach {
      it.writeBytes(ByteArray(it.length().toInt()))
      it.delete()
    }
  }

  private fun nettingProofFile(
    sessionId: String,
    vkSha256: String,
  ) = File(File(File(root, "netting-proofs"), checkHash(vkSha256)), checkNoteId(sessionId))

  fun nettingProof(
    sessionId: String,
    vkSha256: String,
  ): ByteArray? = nettingProofFile(sessionId, vkSha256).takeIf { it.exists() }?.readBytes()

  fun putNettingProof(
    sessionId: String,
    vkSha256: String,
    bytes: ByteArray,
  ) {
    require(bytes.size == Native.NETTING_PROOF) { "invalid netting proof" }
    atomicWrite(nettingProofFile(sessionId, vkSha256), bytes)
  }

  /** Forgets a netting's witness and its proofs under every key. */
  fun forgetNetting(sessionId: String) {
    dropNettingWitness(sessionId)
    File(root, "netting-proofs").listFiles()?.forEach { File(it, checkNoteId(sessionId)).delete() }
  }

  /** The verifying key of a netting key, beside its proving files. */
  fun verifyingKey(vkSha256: String) = File(keyDir(vkSha256), "vk.bin")

  fun keyDir(vkSha256: String) = File(File(root, "keys"), checkHash(vkSha256))

  fun keyReady(vkSha256: String) = File(keyDir(vkSha256), READY).exists()

  fun markKeyReady(vkSha256: String) = File(keyDir(vkSha256), READY).writeText("")

  fun dropKey(vkSha256: String) {
    keyDir(vkSha256).deleteRecursively()
  }

  fun keySize(vkSha256: String): Long = keyDir(vkSha256).listFiles()?.filter { it.name != READY }?.sumOf { it.length() } ?: 0L

  fun usableSpace(): Long = root.apply { mkdirs() }.usableSpace

  private fun atomicWrite(
    target: File,
    bytes: ByteArray,
  ) {
    target.parentFile?.mkdirs()
    val part = File(target.path + ".part")
    part.writeBytes(bytes)
    check(part.renameTo(target)) { "could not move ${part.name}" }
  }

  companion object {
    const val MAX_MESSAGES = 17
    const val READY = "ready"
  }
}
