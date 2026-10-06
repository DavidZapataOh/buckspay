package xyz.buckspay.nfc

import android.nfc.cardemulation.HostApduService
import android.os.Bundle
import android.util.Log

/** Forwards to the card and does nothing else: the answer is built on the main thread and must be immediate. */
class BuckspayApduService : HostApduService() {
  override fun processCommandApdu(
    commandApdu: ByteArray,
    extras: Bundle?,
  ): ByteArray {
    val response = NfcRuntime.hardware.card.handle(commandApdu)
    Log.d(TAG, "command length ${commandApdu.size}, status ${"%04X".format(Wire.statusOf(response))}")
    return response
  }

  override fun onDeactivated(reason: Int) = NfcRuntime.hardware.card.onDeactivated()

  private companion object {
    const val TAG = "BuckspayNfc"
  }
}
