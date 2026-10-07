package xyz.buckspay.prover

import android.content.Context
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkerParameters
import androidx.work.multiprocess.RemoteCoroutineWorker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.concurrent.atomic.AtomicReference

/** Downloads and expands a proving key in the `:prover` process, where the expansion's memory belongs. */
class KeyWorker(
  context: Context,
  params: WorkerParameters,
) : RemoteCoroutineWorker(context, params) {
  override suspend fun doRemoteWork(): Result {
    val spec =
      KeySpec(
        vkSha256 = inputData.getString(VK_SHA256) ?: return Result.failure(),
        pkUrl = inputData.getString(PK_URL) ?: return Result.failure(),
        pkSha256 = inputData.getString(PK_SHA256) ?: return Result.failure(),
        ccsUrl = inputData.getString(CCS_URL) ?: return Result.failure(),
        ccsSha256 = inputData.getString(CCS_SHA256) ?: return Result.failure(),
        dumpSha256 = inputData.getString(DUMP_SHA256) ?: return Result.failure(),
      )
    val installer = KeyInstaller(proverFiles(applicationContext), HttpsFetch, NativeProver)
    val latest = AtomicReference("downloading" to 0.0)
    return try {
      coroutineScope {
        val ticker =
          launch {
            while (true) {
              val (state, fraction) = latest.get()
              setProgress(
                Data
                  .Builder()
                  .putString(STATE, state)
                  .putDouble(FRACTION, fraction)
                  .build(),
              )
              delay(PROGRESS_MS)
            }
          }
        withContext(Dispatchers.IO) { installer.install(spec) { state, fraction -> latest.set(state to fraction) } }
        ticker.cancel()
      }
      Result.success()
    } catch (e: KeyException) {
      if (e.reason == "network" || e.reason == "no-space") {
        Result.retry()
      } else {
        Result.failure(Data.Builder().putString(PROVE_REASON, e.reason).build())
      }
    } catch (e: IOException) {
      Result.retry()
    }
  }

  companion object {
    const val VK_SHA256 = "vkSha256"
    const val PK_URL = "pkUrl"
    const val PK_SHA256 = "pkSha256"
    const val CCS_URL = "ccsUrl"
    const val CCS_SHA256 = "ccsSha256"
    const val DUMP_SHA256 = "dumpSha256"
    const val STATE = "state"
    const val FRACTION = "fraction"
    const val PROVE_REASON = "reason"
    private const val PROGRESS_MS = 1_000L

    fun uniqueName(vkSha256: String) = "key-${checkHash(vkSha256)}"

    /** On unmetered networks only while charging, or on any network when the user asked for it now. */
    internal fun request(
      packageName: String,
      spec: KeySpec,
      unmeteredOnly: Boolean,
    ): OneTimeWorkRequest {
      val constraints =
        Constraints
          .Builder()
          .setRequiredNetworkType(if (unmeteredOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
          .setRequiresStorageNotLow(true)
          .setRequiresCharging(unmeteredOnly)
          .build()
      val data =
        remoteData(packageName)
          .putString(VK_SHA256, checkHash(spec.vkSha256))
          .putString(PK_URL, spec.pkUrl)
          .putString(PK_SHA256, checkHash(spec.pkSha256))
          .putString(CCS_URL, spec.ccsUrl)
          .putString(CCS_SHA256, checkHash(spec.ccsSha256))
          .putString(DUMP_SHA256, checkHash(spec.dumpSha256))
          .build()
      return OneTimeWorkRequestBuilder<KeyWorker>().setConstraints(constraints).setInputData(data).build()
    }

    val POLICY = ExistingWorkPolicy.REPLACE
  }
}
