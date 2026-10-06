package xyz.buckspay.copresence

import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import kotlinx.coroutines.CompletableDeferred

/**
 * Plays one message and finishes when its last sample has been played, or when [cancel] is called. The
 * volume is never changed: a phone that is too quiet is reported, not turned up.
 */
internal class Player(
  private val audio: AudioManager,
  private val samples: ShortArray,
) {
  private val done = CompletableDeferred<Unit>()
  private var track: AudioTrack? = null

  private val attributes =
    AudioAttributes
      .Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
      .build()
  private val focus =
    AudioFocusRequest
      .Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
      .setAudioAttributes(attributes)
      .build()

  suspend fun play() {
    audio.requestAudioFocus(focus)
    val created =
      AudioTrack
        .Builder()
        .setAudioAttributes(attributes)
        .setAudioFormat(
          AudioFormat
            .Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build(),
        ).setBufferSizeInBytes(samples.size * Short.SIZE_BYTES)
        .setTransferMode(AudioTrack.MODE_STATIC)
        .build()
    track = created
    try {
      audio
        .getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
        ?.let(created::setPreferredDevice)
      created.write(samples, 0, samples.size)
      created.setNotificationMarkerPosition(samples.size)
      created.setPlaybackPositionUpdateListener(
        object : AudioTrack.OnPlaybackPositionUpdateListener {
          override fun onMarkerReached(track: AudioTrack) {
            done.complete(Unit)
          }

          override fun onPeriodicNotification(track: AudioTrack) = Unit
        },
      )
      created.play()
      done.await()
    } finally {
      created.release()
      track = null
      audio.abandonAudioFocusRequest(focus)
    }
  }

  fun cancel() {
    track?.stop()
    done.complete(Unit)
  }
}
