package xyz.buckspay.prover

/**
 * Proves one netting from the witness the app left on disk, then deletes and zero-fills the witness: it holds every
 * salt and debt of the session. A witness the prover refuses is deleted too, as it can never succeed; a missing key
 * keeps it for the next run.
 */
internal class NettingRun(
  private val prover: Prover,
  private val files: ProverFiles,
) {
  fun run(
    sessionId: String,
    vkSha256: String,
  ): ProveOutcome {
    if (files.nettingProof(sessionId, vkSha256) != null) {
      files.dropNettingWitness(sessionId)
      return ProveOutcome.Done
    }
    val witness = files.nettingWitness(sessionId).takeIf { it.exists() }?.readBytes() ?: return ProveOutcome.Failed("no-witness")
    try {
      val proof =
        try {
          prover.proveNetting(witness, files.keyDir(vkSha256).path)
        } catch (e: ProverException) {
          if (e.code == Native.NO_KEY) return ProveOutcome.Failed("no-key")
          files.dropNettingWitness(sessionId)
          return ProveOutcome.Failed("invalid")
        }
      files.putNettingProof(sessionId, vkSha256, proof)
      files.dropNettingWitness(sessionId)
      return ProveOutcome.Done
    } finally {
      witness.fill(0)
      prover.release()
    }
  }
}
