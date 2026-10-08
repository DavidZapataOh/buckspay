package xyz.buckspay.prover

/** The Go proving library, registered by `JNI_OnLoad`. Only the `:prover` process touches it. */
internal object Native {
  const val OK = 0
  const val NO_KEY = -1
  const val BAD_ARGS = -2
  const val FAILED = -3
  const val PROOF_AND_PUBLIC = 512
  const val CLAIM_PROOF_AND_PUBLIC = 352
  const val NETTING_PROOF = 256
  const val NETTING_PUBLIC = 128

  init {
    System.loadLibrary("buckspay_prover")
  }

  external fun load(dir: String): Int

  external fun proveInto(
    chain: ByteArray,
    index: Int,
    out: ByteArray,
  ): Int

  external fun loadClaim(dir: String): Int

  external fun proveClaimInto(
    request: ByteArray,
    out: ByteArray,
  ): Int

  external fun proveNettingInto(
    witness: ByteArray,
    keyDir: String,
    out: ByteArray,
  ): Int

  /** 1 when the proof verifies, 0 when a well-formed proof does not, a negative code otherwise. */
  external fun verifyNetting(
    proof: ByteArray,
    publicInputs: ByteArray,
    vkPath: String,
  ): Int

  fun proveNetting(
    witness: ByteArray,
    keyDir: String,
  ): ByteArray {
    val out = ByteArray(NETTING_PROOF)
    val code = proveNettingInto(witness, keyDir, out)
    if (code != OK) throw ProverException(code)
    return out
  }

  external fun expand(
    pkBin: String,
    pkDump: String,
  ): Int

  external fun release()
}
