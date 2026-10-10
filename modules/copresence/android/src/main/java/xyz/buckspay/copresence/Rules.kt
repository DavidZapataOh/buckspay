package xyz.buckspay.copresence

import android.media.AudioDeviceInfo

private const val LOW_VOLUME_PERCENT = 20

/** The media volume is below what a short high-pitched sound needs to carry. */
fun volumeLow(
  volume: Int,
  max: Int,
): Boolean = max <= 0 || volume * 100 < max * LOW_VOLUME_PERCENT

/** `UNPROCESSED` is the one source the platform requires to have no speech processing, when the device says it has it. */
fun useUnprocessed(property: String?): Boolean = property == "true"

/** A microphone that gives only zeros for this many consecutive frames is silenced, not quiet. */
const val SILENT_FRAMES = SAMPLE_RATE / FRAME_SAMPLES

fun isSilentFrame(frame: ShortArray): Boolean = frame.all { it == 0.toShort() }

/** Where the sound would come out: only the built-in speaker carries the whole band. */
fun routeOf(outputTypes: List<Int>): String =
  when {
    outputTypes.any { it in BLUETOOTH } -> "bluetooth"
    outputTypes.any { it in WIRED } -> "headset"
    else -> "speaker"
  }

private val BLUETOOTH =
  setOf(
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_BLE_HEADSET,
    AudioDeviceInfo.TYPE_BLE_SPEAKER,
    AudioDeviceInfo.TYPE_BLE_BROADCAST,
  )
private val WIRED =
  setOf(
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_USB_DEVICE,
    AudioDeviceInfo.TYPE_USB_HEADSET,
    AudioDeviceInfo.TYPE_HDMI,
  )
