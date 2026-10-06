package xyz.buckspay.copresence

import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process

private const val BUFFER_FRAMES = 4

/**
 * Reads the microphone in whole frames and hands every decoded payload to [onPayload]. Nothing is
 * written anywhere: the samples live in one frame buffer and are overwritten by the next read.
 */
internal class Recorder(
  private val audio: AudioManager,
  band: Band,
  onPayload: (ByteArray) -> Unit,
  private val onSilenced: (Boolean) -> Unit,
) {
  private var record: AudioRecord? = null
  private var thread: Thread? = null
  private val effects = mutableListOf<android.media.audiofx.AudioEffect>()
  private val listener = Listener(band, onPayload, onSilenced)

  @Volatile private var running = false

  private val recordings =
    object : AudioManager.AudioRecordingCallback() {
      override fun onRecordingConfigChanged(configs: List<AudioRecordingConfiguration>) {
        val session = record?.audioSessionId ?: return
        val mine = configs.firstOrNull { it.clientAudioSessionId == session } ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) onSilenced(mine.isClientSilenced)
      }
    }

  fun start() {
    check(record == null) { "Already listening" }
    try {
      open()
    } catch (error: RuntimeException) {
      listener.close()
      throw error
    }
  }

  private fun open() {
    val unprocessed = useUnprocessed(audio.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED))
    val source = if (unprocessed) MediaRecorder.AudioSource.UNPROCESSED else MediaRecorder.AudioSource.MIC
    val format =
      AudioFormat
        .Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(SAMPLE_RATE)
        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
        .build()
    val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    check(minimum > 0) { "Unsupported" }
    val created =
      AudioRecord
        .Builder()
        .setAudioSource(source)
        .setAudioFormat(format)
        .setBufferSizeInBytes(maxOf(minimum, FRAME_SAMPLES * 2) * BUFFER_FRAMES)
        .build()
    check(created.state == AudioRecord.STATE_INITIALIZED) { "Unsupported" }
    if (!unprocessed) switchOffProcessing(created.audioSessionId)
    record = created
    audio.registerAudioRecordingCallback(recordings, Handler(Looper.getMainLooper()))
    running = true
    created.startRecording()
    thread = Thread({ loop(created) }, "copresence-recorder").also { it.start() }
  }

  fun deaf(playing: Boolean) = listener.deaf(playing)

  fun stop() {
    running = false
    audio.unregisterAudioRecordingCallback(recordings)
    thread?.join()
    thread = null
    effects.forEach { it.release() }
    effects.clear()
    record?.release()
    record = null
    listener.close()
  }

  private fun switchOffProcessing(session: Int) {
    if (AutomaticGainControl.isAvailable()) {
      AutomaticGainControl.create(session)?.also {
        it.enabled = false
        effects += it
      }
    }
    if (NoiseSuppressor.isAvailable()) {
      NoiseSuppressor.create(session)?.also {
        it.enabled = false
        effects += it
      }
    }
    if (AcousticEchoCanceler.isAvailable()) {
      AcousticEchoCanceler.create(session)?.also {
        it.enabled = false
        effects += it
      }
    }
  }

  private fun loop(input: AudioRecord) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    val frame = ShortArray(FRAME_SAMPLES)
    while (running) {
      var filled = 0
      while (running && filled < FRAME_SAMPLES) {
        val read = input.read(frame, filled, FRAME_SAMPLES - filled)
        if (read < 0) return
        filled += read
      }
      if (filled == FRAME_SAMPLES) listener.process(frame)
    }
  }
}
