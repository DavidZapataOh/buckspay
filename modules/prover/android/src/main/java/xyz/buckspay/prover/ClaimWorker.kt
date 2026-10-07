package xyz.buckspay.prover

import android.content.Context
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkerParameters
import androidx.work.multiprocess.RemoteCoroutineWorker

/** Proves one blind claim in the `:prover` process, like [ProveWorker] does for a note. */
class ClaimWorker(
  context: Context,
  params: WorkerParameters,
) : RemoteCoroutineWorker(context, params) {
  override suspend fun doRemoteWork(): Result {
    val claimId = inputData.getString(CLAIM_ID) ?: return Result.failure()
    val vkSha256 = inputData.getString(ProveWorker.VK_SHA256) ?: return Result.failure()
    return when (val outcome = ClaimRun(NativeProver, proverFiles(applicationContext)).run(claimId, vkSha256)) {
      ProveOutcome.Done -> Result.success()
      is ProveOutcome.Failed -> Result.failure(Data.Builder().putString(ProveWorker.REASON, outcome.reason).build())
    }
  }

  companion object {
    const val CLAIM_ID = "claimId"

    fun uniqueName(claimId: String) = "claim-${checkNoteId(claimId)}"

    /** A claim waits for a battery that is not low and nothing else: its delay was chosen by the app. */
    fun request(
      packageName: String,
      claimId: String,
      vkSha256: String,
    ): OneTimeWorkRequest =
      OneTimeWorkRequestBuilder<ClaimWorker>()
        .setConstraints(Constraints.Builder().setRequiresBatteryNotLow(true).build())
        .setInputData(
          remoteData(packageName)
            .putString(CLAIM_ID, checkNoteId(claimId))
            .putString(ProveWorker.VK_SHA256, checkHash(vkSha256))
            .build(),
        ).addTag(ProveWorker.TAG)
        .addTag(ProveWorker.noteTag(claimId))
        .build()

    val POLICY = ExistingWorkPolicy.KEEP
  }
}
