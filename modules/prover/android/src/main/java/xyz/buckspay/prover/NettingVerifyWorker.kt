package xyz.buckspay.prover

import android.content.Context
import androidx.work.Data
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkerParameters
import androidx.work.multiprocess.RemoteCoroutineWorker

/** Checks one netting proof in the `:prover` process, so the Go library never loads into the app process. */
class NettingVerifyWorker(
  context: Context,
  params: WorkerParameters,
) : RemoteCoroutineWorker(context, params) {
  override suspend fun doRemoteWork(): Result {
    val proof = inputData.getByteArray(PROOF) ?: return Result.failure()
    val publics = inputData.getByteArray(PUBLIC) ?: return Result.failure()
    val vkSha256 = inputData.getString(ProveWorker.VK_SHA256) ?: return Result.failure()
    val vkPath = proverFiles(applicationContext).verifyingKey(vkSha256).path
    return try {
      Result.success(Data.Builder().putBoolean(VERIFIED, NativeProver.verifyNetting(proof, publics, vkPath)).build())
    } catch (e: ProverException) {
      Result.failure(Data.Builder().putString(ProveWorker.REASON, if (e.code == Native.NO_KEY) "no-key" else "invalid").build())
    }
  }

  companion object {
    const val PROOF = "proof"
    const val PUBLIC = "public"
    const val VERIFIED = "verified"

    fun request(
      packageName: String,
      proof: ByteArray,
      publics: ByteArray,
      vkSha256: String,
      expedite: Boolean,
    ): OneTimeWorkRequest {
      val builder =
        OneTimeWorkRequestBuilder<NettingVerifyWorker>().setInputData(
          remoteData(packageName)
            .putByteArray(PROOF, proof)
            .putByteArray(PUBLIC, publics)
            .putString(ProveWorker.VK_SHA256, checkHash(vkSha256))
            .build(),
        )
      if (expedite) builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
      return builder.build()
    }
  }
}
