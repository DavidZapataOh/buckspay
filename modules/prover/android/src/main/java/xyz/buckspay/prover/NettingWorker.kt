package xyz.buckspay.prover

import android.content.Context
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkerParameters
import androidx.work.multiprocess.RemoteCoroutineWorker

/** Proves one netting in the `:prover` process, like [ClaimWorker] does for a claim. */
class NettingWorker(
  context: Context,
  params: WorkerParameters,
) : RemoteCoroutineWorker(context, params) {
  override suspend fun doRemoteWork(): Result {
    val sessionId = inputData.getString(SESSION_ID) ?: return Result.failure()
    val vkSha256 = inputData.getString(ProveWorker.VK_SHA256) ?: return Result.failure()
    return when (val outcome = NettingRun(NativeProver, proverFiles(applicationContext)).run(sessionId, vkSha256)) {
      ProveOutcome.Done -> Result.success()
      is ProveOutcome.Failed -> Result.failure(Data.Builder().putString(ProveWorker.REASON, outcome.reason).build())
    }
  }

  companion object {
    const val SESSION_ID = "sessionId"

    fun uniqueName(sessionId: String) = "netting-${checkNoteId(sessionId)}"

    /** The members wait for the proof, so it starts at once and is expedited where the platform allows it. */
    fun request(
      packageName: String,
      sessionId: String,
      vkSha256: String,
      expedite: Boolean,
    ): OneTimeWorkRequest {
      val builder =
        OneTimeWorkRequestBuilder<NettingWorker>()
          .setInputData(
            remoteData(packageName)
              .putString(SESSION_ID, checkNoteId(sessionId))
              .putString(ProveWorker.VK_SHA256, checkHash(vkSha256))
              .build(),
          ).addTag(ProveWorker.TAG)
      if (expedite) builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
      return builder.build()
    }

    val POLICY = ExistingWorkPolicy.KEEP
  }
}
