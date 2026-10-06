package xyz.buckspay.copresence

import android.os.SystemClock
import java.util.concurrent.atomic.AtomicLong

private const val OWN_SOUND_TAIL_MS = 200L

/**
 * Takes the microphone's frames one at a time: decodes them into payloads, except while this phone plays and
 * for a moment after (the speaker is next to the microphone), and says when the microphone only gives zeros.
 */
internal class Listener(
  band: Band,
  private val onPayload: (ByteArray) -> Unit,
  private val onSilenced: (Boolean) -> Unit,
  private val now: () -> Long = SystemClock::elapsedRealtime,
) : AutoCloseable {
  private val decoder = Decoder(band.protocol)
  private val deafUntil = AtomicLong(0)
  private var silentFrames = 0
  private var silenced = false

  fun deaf(playing: Boolean) = deafUntil.set(if (playing) Long.MAX_VALUE else now() + OWN_SOUND_TAIL_MS)

  /** `frame` is exactly [FRAME_SAMPLES] samples. */
  fun process(frame: ShortArray) {
    silentFrames = if (isSilentFrame(frame)) silentFrames + 1 else 0
    val nowSilenced = silentFrames >= SILENT_FRAMES
    if (nowSilenced != silenced) {
      silenced = nowSilenced
      onSilenced(nowSilenced)
    }
    if (now() < deafUntil.get()) return
    decoder.feed(frame)?.let(onPayload)
  }

  override fun close() = decoder.close()
}
