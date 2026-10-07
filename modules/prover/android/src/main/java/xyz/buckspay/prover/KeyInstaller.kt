package xyz.buckspay.prover

import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/** The hashes and addresses of one key. The app decides whether it trusts them; this module only checks the files against them. */
internal data class KeySpec(
  val vkSha256: String,
  val pkUrl: String,
  val pkSha256: String,
  val ccsUrl: String,
  val ccsSha256: String,
  val dumpSha256: String,
)

internal class Download(
  val stream: InputStream,
  val length: Long,
)

internal fun interface Fetch {
  fun open(url: String): Download
}

internal object HttpsFetch : Fetch {
  override fun open(url: String): Download {
    require(url.startsWith("https://")) { "keys are fetched over https only" }
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.connectTimeout = TIMEOUT_MS
    connection.readTimeout = TIMEOUT_MS
    check(connection.responseCode == HttpURLConnection.HTTP_OK) { "HTTP ${connection.responseCode}" }
    return Download(connection.inputStream, connection.contentLengthLong)
  }

  private const val TIMEOUT_MS = 30_000
}

internal class KeyException(
  val reason: String,
) : Exception(reason)

/** Downloads a key, checks every file against its hash, expands the compressed key and marks the directory ready. */
internal class KeyInstaller(
  private val files: ProverFiles,
  private val fetch: Fetch,
  private val prover: Prover,
) {
  fun install(
    spec: KeySpec,
    progress: (state: String, fraction: Double) -> Unit,
  ) {
    val vk = checkHash(spec.vkSha256)
    if (files.keyReady(vk)) return
    if (files.usableSpace() < NEEDED_BYTES) throw KeyException("no-space")
    val dir = files.keyDir(vk).apply { mkdirs() }
    val ccs = File(dir, "ccs.bin")
    val pk = File(dir, "pk.bin")
    val dump = File(dir, "pk.dump")
    try {
      download(spec.ccsUrl, ccs, checkHash(spec.ccsSha256)) { progress("downloading", it * CCS_SHARE) }
      download(spec.pkUrl, pk, checkHash(spec.pkSha256)) { progress("downloading", CCS_SHARE + it * (1 - CCS_SHARE)) }
      progress("expanding", 0.0)
      if (prover.expand(pk.path, dump.path) != Native.OK) throw KeyException("expand")
      if (dump.sha256() != checkHash(spec.dumpSha256)) throw KeyException("hash")
      pk.delete()
      files.markKeyReady(vk)
    } catch (e: Exception) {
      files.dropKey(vk)
      throw e
    }
  }

  private fun download(
    url: String,
    target: File,
    expected: String,
    progress: (Double) -> Unit,
  ) {
    val part = File(target.path + ".part")
    val source =
      try {
        fetch.open(url)
      } catch (e: Exception) {
        throw KeyException("network")
      }
    source.stream.use { input ->
      part.outputStream().use { output ->
        val buffer = ByteArray(1 shl 16)
        var copied = 0L
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          output.write(buffer, 0, read)
          copied += read
          if (source.length > 0) progress(copied.toDouble() / source.length)
        }
      }
    }
    if (part.sha256() != expected) {
      part.delete()
      throw KeyException("hash")
    }
    check(part.renameTo(target)) { "could not move ${part.name}" }
  }

  private companion object {
    /** 123 MB compressed key and 245 MB dump coexist during expansion, plus the 37 MB constraint system. */
    const val NEEDED_BYTES = 450L * 1024 * 1024
    const val CCS_SHARE = 0.23
  }
}
