package xyz.buckspay.prover

/**
 * Proves one blind claim from the request the app left on disk, then deletes the request: it holds the leaf
 * secrets, which must not outlive the proof. A request the prover refuses is deleted too, as it can never succeed;
 * a missing key keeps it for the next run.
 */
internal class ClaimRun(
  private val prover: Prover,
  private val files: ProverFiles,
) {
  fun run(
    claimId: String,
    vkSha256: String,
  ): ProveOutcome {
    if (files.claimProof(claimId, vkSha256) != null) {
      files.dropClaimRequest(claimId)
      return ProveOutcome.Done
    }
    val request = files.claimRequest(claimId).takeIf { it.exists() }?.readBytes() ?: return ProveOutcome.Failed("no-request")
    try {
      if (prover.loadClaim(files.keyDir(vkSha256).path) != Native.OK) return ProveOutcome.Failed("no-key")
      val out =
        try {
          prover.proveClaim(request)
        } catch (e: ProverException) {
          if (e.code == Native.NO_KEY) return ProveOutcome.Failed("no-key")
          files.dropClaimRequest(claimId)
          return ProveOutcome.Failed("invalid")
        }
      files.putClaimProof(claimId, vkSha256, out)
      files.dropClaimRequest(claimId)
      return ProveOutcome.Done
    } finally {
      request.fill(0)
      prover.release()
    }
  }
}
