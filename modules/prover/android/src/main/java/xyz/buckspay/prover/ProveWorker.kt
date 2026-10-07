package xyz.buckspay.prover

import android.content.Context
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkerParameters
import androidx.work.multiprocess.RemoteCoroutineWorker
import androidx.work.multiprocess.RemoteListenableWorker
import androidx.work.multiprocess.RemoteWorkerService
import java.io.File

internal const val PROVER_DIR = "zk"

internal fun proverFiles(context: Context) = ProverFiles(File(context.noBackupFilesDir, PROVER_DIR))

internal fun remoteData(
  packageName: String,
  builder: Data.Builder = Data.Builder(),
): Data.Builder =
  builder
    .putString(RemoteListenableWorker.ARGUMENT_PACKAGE_NAME, packageName)
    .putString(RemoteListenableWorker.ARGUMENT_CLASS_NAME, RemoteWorkerService::class.java.name)

/**
 * Proves the missing messages of one note in the `:prover` process, so the Go heap of about a gigabyte
 * never shares a process with the user interface and a low-memory kill of the prover leaves the app alone.
 */
class ProveWorker(
  context: Context,
  params: WorkerParameters,
) : RemoteCoroutineWorker(context, params) {
  override suspend fun doRemoteWork(): Result {
    val noteId = inputData.getString(NOTE_ID) ?: return Result.failure()
    val vkSha256 = inputData.getString(VK_SHA256) ?: return Result.failure()
    val requested = inputData.getIntArray(MISSING)?.toList() ?: return Result.failure()
    val files = proverFiles(applicationContext)
    val outcome =
      ProveRun(NativeProver, files).run(noteId, vkSha256, requested) { done, total ->
        setProgress(
          Data
            .Builder()
            .putString(NOTE_ID, noteId)
            .putInt(DONE, done)
            .putInt(TOTAL, total)
            .build(),
        )
      }
    return when (outcome) {
      ProveOutcome.Done -> Result.success()
      is ProveOutcome.Failed -> Result.failure(Data.Builder().putString(REASON, outcome.reason).build())
    }
  }

  companion object {
    const val TAG = "buckspay-prove"
    const val NOTE_ID = "noteId"
    const val VK_SHA256 = "vkSha256"
    const val MISSING = "missing"
    const val DONE = "done"
    const val TOTAL = "total"
    const val REASON = "reason"

    const val MODE_CHARGING = "charging"
    const val MODE_DEADLINE = "deadline"
    const val MODE_NOW = "now"

    fun uniqueName(noteId: String) = "prove-${checkNoteId(noteId)}"

    fun noteTag(noteId: String) = "note:${checkNoteId(noteId)}"

    /**
     * Charging: only on the charger with the battery not low. Deadline: off the charger, because the note
     * would otherwise expire unproved. Now: the user asked, so it starts at once and is expedited where the
     * platform allows it (Android 12 and later).
     */
    fun request(
      packageName: String,
      noteId: String,
      vkSha256: String,
      missing: IntArray,
      mode: String,
      expedite: Boolean,
    ): OneTimeWorkRequest {
      val constraints =
        when (mode) {
          MODE_CHARGING -> {
            Constraints
              .Builder()
              .setRequiresCharging(true)
              .setRequiresBatteryNotLow(true)
              .build()
          }

          MODE_DEADLINE -> {
            Constraints.Builder().setRequiresBatteryNotLow(true).build()
          }

          MODE_NOW -> {
            Constraints.NONE
          }

          else -> {
            throw IllegalArgumentException("unknown mode $mode")
          }
        }
      val data =
        remoteData(packageName)
          .putString(NOTE_ID, checkNoteId(noteId))
          .putString(VK_SHA256, checkHash(vkSha256))
          .putIntArray(MISSING, missing)
          .build()
      val builder =
        OneTimeWorkRequestBuilder<ProveWorker>()
          .setConstraints(
            constraints,
          ).setInputData(data)
          .addTag(TAG)
          .addTag(noteTag(noteId))
      if (mode == MODE_NOW && expedite) builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
      return builder.build()
    }

    /** A run the user asked for replaces the queued one; a waiting run is left alone, so the work it did is not repeated. */
    fun policy(mode: String) = if (mode == MODE_NOW) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP
  }
}
