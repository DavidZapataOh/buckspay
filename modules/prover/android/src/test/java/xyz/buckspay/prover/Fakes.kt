package xyz.buckspay.prover

import java.io.ByteArrayInputStream

/** Test double: proves by echoing the index, can fail on chosen indices and records what was loaded. */
internal class FakeProver(
  private val failAt: Map<Int, Int> = emptyMap(),
  private val loadCode: Int = Native.OK,
  private val expandCode: Int = Native.OK,
  private val onProve: (Int) -> Unit = {},
  private val claimFailure: Int? = null,
  private val nettingFailure: Int? = null,
  private val nettingVerifies: Boolean = true,
) : Prover {
  val proved = mutableListOf<Int>()
  val claimed = mutableListOf<ByteArray>()
  val netted = mutableListOf<ByteArray>()
  var loads = 0
  var releases = 0

  override fun load(dir: String): Int {
    loads++
    return loadCode
  }

  override fun prove(
    chain: ByteArray,
    index: Int,
  ): ByteArray {
    failAt[index]?.let { throw ProverException(it) }
    onProve(index)
    proved += index
    return ByteArray(Native.PROOF_AND_PUBLIC) { index.toByte() }
  }

  override fun loadClaim(dir: String): Int {
    loads++
    return loadCode
  }

  override fun proveClaim(request: ByteArray): ByteArray {
    claimFailure?.let { throw ProverException(it) }
    claimed += request.copyOf()
    return ByteArray(Native.CLAIM_PROOF_AND_PUBLIC) { 9 }
  }

  override fun proveNetting(
    witness: ByteArray,
    keyDir: String,
  ): ByteArray {
    nettingFailure?.let { throw ProverException(it) }
    netted += witness.copyOf()
    return ByteArray(Native.NETTING_PROOF) { 5 }
  }

  override fun verifyNetting(
    proof: ByteArray,
    publicInputs: ByteArray,
    vkPath: String,
  ) = nettingVerifies

  override fun expand(
    pkBin: String,
    pkDump: String,
  ): Int {
    if (expandCode == Native.OK) java.io.File(pkDump).writeBytes(DUMP)
    return expandCode
  }

  override fun release() {
    releases++
  }

  companion object {
    val DUMP = ByteArray(64) { 7 }
  }
}

internal class FakeFetch(
  private val bodies: Map<String, ByteArray>,
) : Fetch {
  val opened = mutableListOf<String>()

  override fun open(url: String): Download {
    opened += url
    val body = bodies[url] ?: throw java.io.IOException("404")
    return Download(ByteArrayInputStream(body), body.size.toLong())
  }
}
