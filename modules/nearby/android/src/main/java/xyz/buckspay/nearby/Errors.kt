package xyz.buckspay.nearby

import com.google.android.gms.common.api.ApiException
import expo.modules.kotlin.exception.CodedException

/** A failure JavaScript maps to `NearbyError`; the code is one of its `NearbyErrorCode` values. */
internal class NearbyException(
  code: String,
) : CodedException(code, code, null)

internal fun failureCode(statusCode: Int): String =
  when (statusCode) {
    8007, 8025 -> "RadioOff"
    in 8029..8039 -> "PermissionMissing"
    17 -> "Unsupported"
    8001, 8002, 8050 -> "AlreadyActive"
    else -> "Failed"
  }

internal fun failure(error: Throwable): NearbyException =
  NearbyException(if (error is ApiException) failureCode(error.statusCode) else "Failed")
