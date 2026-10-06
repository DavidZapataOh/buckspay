package xyz.buckspay.copresence

const val SAMPLE_RATE = 48_000
const val FRAME_SAMPLES = 1024
const val MAX_PAYLOAD = 140

/** The ggwave protocols this module uses, as the library numbers them. */
object Protocol {
  const val AUDIBLE_FASTEST = 2
  const val ULTRASOUND_NORMAL = 3
  const val ULTRASOUND_FASTEST = 5
}

enum class Band(
  val protocol: Int,
) {
  ULTRASOUND(Protocol.ULTRASOUND_FASTEST),
  AUDIBLE(Protocol.AUDIBLE_FASTEST),
  ;

  companion object {
    fun parse(name: String): Band =
      when (name) {
        "ultrasound" -> ULTRASOUND
        "audible" -> AUDIBLE
        else -> throw IllegalArgumentException("Unknown band: $name")
      }
  }
}

internal object Ggwave {
  init {
    System.loadLibrary("copresence")
  }

  external fun nativeCreate(
    protocol: Int,
    rx: Boolean,
  ): Int

  external fun nativeEncode(
    instance: Int,
    payload: ByteArray,
    protocol: Int,
    volume: Int,
  ): ShortArray

  external fun nativeDecode(
    instance: Int,
    frame: ShortArray,
  ): ByteArray?

  external fun nativeFree(instance: Int)
}

/** Turns decoded frames into payloads. The library holds four instances in all; this holds one. */
internal class Decoder(
  protocol: Int,
) : AutoCloseable {
  private var instance = Ggwave.nativeCreate(protocol, true)

  init {
    check(instance >= 0) { "The decoder could not be created" }
  }

  /** `frame` must be exactly [FRAME_SAMPLES] samples: the library decodes nothing from any other size. */
  fun feed(frame: ShortArray): ByteArray? = Ggwave.nativeDecode(instance, frame)

  override fun close() {
    if (instance >= 0) Ggwave.nativeFree(instance)
    instance = -1
  }
}

/** Turns a payload into the samples of its sound. */
internal class Encoder(
  private val protocol: Int,
  private val volume: Int = VOLUME,
) : AutoCloseable {
  private var instance = Ggwave.nativeCreate(protocol, false)

  init {
    check(instance >= 0) { "The encoder could not be created" }
  }

  fun encode(payload: ByteArray): ShortArray {
    require(payload.size in 1..MAX_PAYLOAD) { "A payload is 1 to $MAX_PAYLOAD bytes" }
    return Ggwave.nativeEncode(instance, payload, protocol, volume)
  }

  override fun close() {
    if (instance >= 0) Ggwave.nativeFree(instance)
    instance = -1
  }

  private companion object {
    const val VOLUME = 50
  }
}
