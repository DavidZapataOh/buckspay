package xyz.buckspay.prover

import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext

internal sealed interface ProveOutcome {
  data object Done : ProveOutcome

  data class Failed(
    val reason: String,
  ) : ProveOutcome
}

/** Proves the messages of one note that have no proof yet, writing each proof as soon as it exists. */
internal class ProveRun(
  private val prover: Prover,
  private val files: ProverFiles,
) {
  suspend fun run(
    noteId: String,
    vkSha256: String,
    requested: List<Int>,
    progress: suspend (done: Int, total: Int) -> Unit,
  ): ProveOutcome {
    val total = requested.size
    val todo = plan(requested, files.proved(noteId, vkSha256))
    if (todo.isEmpty()) return ProveOutcome.Done
    val chain = files.chain(noteId).takeIf { it.exists() }?.readBytes() ?: return ProveOutcome.Failed("no-chain")
    if (prover.load(files.keyDir(vkSha256).path) != Native.OK) return ProveOutcome.Failed("no-key")
    try {
      progress(total - todo.size, total)
      todo.forEachIndexed { position, index ->
        coroutineContext.ensureActive()
        val out =
          try {
            prover.prove(chain, index)
          } catch (e: ProverException) {
            return ProveOutcome.Failed(if (e.code == Native.NO_KEY) "no-key" else "invalid")
          }
        files.putProof(noteId, vkSha256, index, out)
        progress(total - todo.size + position + 1, total)
      }
    } finally {
      prover.release()
    }
    return ProveOutcome.Done
  }

  companion object {
    /** The requested messages that still lack a proof, in request order. */
    fun plan(
      requested: List<Int>,
      proved: Set<Int>,
    ): List<Int> = requested.filter { it !in proved }
  }
}
