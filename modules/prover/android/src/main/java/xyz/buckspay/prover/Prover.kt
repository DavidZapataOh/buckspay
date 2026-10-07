package xyz.buckspay.prover

class ProverException(
  val code: Int,
) : Exception("prover failed with code $code")

/** What the workers need from the proving library, so their logic runs without it. */
internal interface Prover {
  fun load(dir: String): Int

  /** The compressed proof (192 bytes) followed by the ten public inputs (320 bytes). */
  fun prove(
    chain: ByteArray,
    index: Int,
  ): ByteArray

  fun loadClaim(dir: String): Int

  /** The compressed claim proof (128 bytes) followed by the seven public inputs (224 bytes). */
  fun proveClaim(request: ByteArray): ByteArray

  fun expand(
    pkBin: String,
    pkDump: String,
  ): Int

  fun release()
}

internal object NativeProver : Prover {
  override fun load(dir: String) = Native.load(dir)

  override fun prove(
    chain: ByteArray,
    index: Int,
  ): ByteArray {
    val out = ByteArray(Native.PROOF_AND_PUBLIC)
    val code = Native.proveInto(chain, index, out)
    if (code != Native.OK) throw ProverException(code)
    return out
  }

  override fun loadClaim(dir: String) = Native.loadClaim(dir)

  override fun proveClaim(request: ByteArray): ByteArray {
    val out = ByteArray(Native.CLAIM_PROOF_AND_PUBLIC)
    val code = Native.proveClaimInto(request, out)
    if (code != Native.OK) throw ProverException(code)
    return out
  }

  override fun expand(
    pkBin: String,
    pkDump: String,
  ) = Native.expand(pkBin, pkDump)

  override fun release() = Native.release()
}
