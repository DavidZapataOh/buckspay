package xyz.buckspay.prover

import android.content.Context
import android.os.Build
import androidx.work.WorkInfo
import androidx.work.WorkManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class KeyRecord : Record {
  @Field var vkSha256: String = ""

  @Field var pkUrl: String = ""

  @Field var pkSha256: String = ""

  @Field var ccsUrl: String = ""

  @Field var ccsSha256: String = ""

  @Field var dumpSha256: String = ""
}

class ProverModule : Module() {
  private val context: Context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private val files get() = proverFiles(context)
  private val work get() = WorkManager.getInstance(context)
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  override fun definition() =
    ModuleDefinition {
      Name("Prover")

      Events("onProgress")

      OnCreate {
        scope.launch {
          work.getWorkInfosByTagFlow(ProveWorker.TAG).distinctUntilChanged().collect { infos ->
            infos.forEach { info -> progressOf(info)?.let { sendEvent("onProgress", it) } }
          }
        }
      }

      OnDestroy { scope.cancel() }

      AsyncFunction("keyStatus") { vkSha256: String ->
        val ready = files.keyReady(vkSha256)
        val info = work.getWorkInfosForUniqueWork(KeyWorker.uniqueName(vkSha256)).get().firstOrNull()
        val running = info?.state == WorkInfo.State.RUNNING
        mapOf(
          "vkSha256" to vkSha256,
          "state" to
            if (ready) {
              "ready"
            } else if (running) {
              info?.progress?.getString(KeyWorker.STATE) ?: "downloading"
            } else {
              "missing"
            },
          "progress" to if (ready) 1.0 else info?.progress?.getDouble(KeyWorker.FRACTION, 0.0) ?: 0.0,
          "sizeBytes" to files.keySize(vkSha256).toDouble(),
        )
      }

      AsyncFunction("ensureKey") { key: KeyRecord, unmeteredOnly: Boolean ->
        val spec = KeySpec(key.vkSha256, key.pkUrl, key.pkSha256, key.ccsUrl, key.ccsSha256, key.dumpSha256)
        if (!files.keyReady(spec.vkSha256)) {
          work.enqueueUniqueWork(
            KeyWorker.uniqueName(spec.vkSha256),
            KeyWorker.POLICY,
            KeyWorker.request(context.packageName, spec, unmeteredOnly),
          )
        }
      }

      AsyncFunction("dropKey") { vkSha256: String ->
        work.cancelUniqueWork(KeyWorker.uniqueName(vkSha256))
        files.dropKey(vkSha256)
      }

      AsyncFunction("enqueue") { noteId: String, chain: ByteArray, missing: IntArray, vkSha256: String, mode: String ->
        files.putChain(noteId, chain)
        val request =
          ProveWorker.request(
            context.packageName,
            noteId,
            vkSha256,
            missing,
            mode,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S,
          )
        work.enqueueUniqueWork(ProveWorker.uniqueName(noteId), ProveWorker.policy(mode), request)
      }

      AsyncFunction("cancel") { noteId: String ->
        work.cancelUniqueWork(ProveWorker.uniqueName(noteId))
        files.forget(noteId)
      }

      AsyncFunction("collect") { noteId: String, vkSha256: String ->
        files.readProofs(noteId, vkSha256).map { (index, bytes) ->
          mapOf("index" to index, "proof" to bytes.copyOfRange(0, PROOF), "publicInputs" to bytes.copyOfRange(PROOF, bytes.size))
        }
      }

      AsyncFunction("enqueueClaim") { claimId: String, request: ByteArray, vkSha256: String ->
        files.putClaimRequest(claimId, request)
        work.enqueueUniqueWork(
          ClaimWorker.uniqueName(claimId),
          ClaimWorker.POLICY,
          ClaimWorker.request(context.packageName, claimId, vkSha256),
        )
      }

      AsyncFunction("collectClaim") { claimId: String, vkSha256: String ->
        files.claimProof(claimId, vkSha256)?.let {
          mapOf("proof" to it.copyOfRange(0, CLAIM_PROOF), "publicInputs" to it.copyOfRange(CLAIM_PROOF, it.size))
        }
      }

      AsyncFunction("claimState") { claimId: String ->
        val info = work.getWorkInfosForUniqueWork(ClaimWorker.uniqueName(claimId)).get().firstOrNull()
        mapOf(
          "state" to (info?.state?.name?.lowercase() ?: "unknown"),
          "reason" to (info?.outputData?.getString(ProveWorker.REASON) ?: ""),
        )
      }

      AsyncFunction("forgetClaim") { claimId: String ->
        work.cancelUniqueWork(ClaimWorker.uniqueName(claimId))
        files.forgetClaim(claimId)
      }

      AsyncFunction("enqueueNetting") { sessionId: String, witness: ByteArray, vkSha256: String ->
        files.putNettingWitness(sessionId, witness)
        work.enqueueUniqueWork(
          NettingWorker.uniqueName(sessionId),
          NettingWorker.POLICY,
          NettingWorker.request(context.packageName, sessionId, vkSha256, Build.VERSION.SDK_INT >= Build.VERSION_CODES.S),
        )
      }

      AsyncFunction("collectNetting") { sessionId: String, vkSha256: String ->
        files.nettingProof(sessionId, vkSha256)
      }

      AsyncFunction("nettingState") { sessionId: String ->
        val info = work.getWorkInfosForUniqueWork(NettingWorker.uniqueName(sessionId)).get().firstOrNull()
        mapOf(
          "state" to (info?.state?.name?.lowercase() ?: "unknown"),
          "reason" to (info?.outputData?.getString(ProveWorker.REASON) ?: ""),
        )
      }

      AsyncFunction("forgetNetting") { sessionId: String ->
        work.cancelUniqueWork(NettingWorker.uniqueName(sessionId))
        files.forgetNetting(sessionId)
      }

      AsyncFunction("verifyNetting") Coroutine { proof: ByteArray, publicInputs: ByteArray, vkSha256: String ->
        val request =
          NettingVerifyWorker.request(
            context.packageName,
            proof,
            publicInputs,
            vkSha256,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S,
          )
        work.enqueue(request)
        val done = work.getWorkInfoByIdFlow(request.id).filterNotNull().first { it.state.isFinished }
        if (done.state != WorkInfo.State.SUCCEEDED) {
          throw IllegalStateException(done.outputData.getString(ProveWorker.REASON) ?: done.state.name.lowercase())
        }
        done.outputData.getBoolean(NettingVerifyWorker.VERIFIED, false)
      }

      AsyncFunction("acknowledge") { noteId: String, vkSha256: String, indices: IntArray ->
        files.dropProofs(noteId, vkSha256, indices.toList())
      }
    }

  private fun progressOf(info: WorkInfo): Map<String, Any>? {
    val noteId = info.tags.firstOrNull { it.startsWith("note:") }?.removePrefix("note:") ?: return null
    return mapOf(
      "noteId" to noteId,
      "done" to info.progress.getInt(ProveWorker.DONE, 0),
      "total" to info.progress.getInt(ProveWorker.TOTAL, 0),
      "state" to info.state.name.lowercase(),
      "reason" to (info.outputData.getString(ProveWorker.REASON) ?: ""),
    )
  }

  private companion object {
    const val PROOF = 192
    const val CLAIM_PROOF = 128
  }
}
