package xyz.buckspay.copresence

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.pow
import kotlin.math.sqrt
import kotlin.random.Random

private const val BAND_SHARE = 4500.0 / 24000.0

/** Plays `samples` into `listener` after a leading silence and a trailing one, in whole frames, as a microphone would. */
private fun pipe(
  samples: ShortArray,
  listener: Listener,
  random: Random,
  noiseDb: Double? = null,
) {
  val lead = SAMPLE_RATE / 2 + random.nextInt(SAMPLE_RATE * 3 / 2)
  val total = (lead + samples.size + SAMPLE_RATE + FRAME_SAMPLES) / FRAME_SAMPLES * FRAME_SAMPLES
  val signal = ShortArray(total)
  samples.copyInto(signal, lead)
  if (noiseDb != null) {
    val power = samples.sumOf { it.toDouble().pow(2) } / samples.size
    val sigma = sqrt(power * BAND_SHARE.pow(-1) / 10.0.pow(noiseDb / 10))
    for (i in signal.indices) {
      val gaussian = sqrt(-2 * kotlin.math.ln(1 - random.nextDouble())) * kotlin.math.cos(2 * Math.PI * random.nextDouble())
      signal[i] = (signal[i] + sigma * gaussian).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
    }
  }
  for (start in 0 until total step FRAME_SAMPLES) listener.process(signal.copyOfRange(start, start + FRAME_SAMPLES))
}

class ModemLoopbackTest {
  private fun payload(
    random: Random,
    size: Int,
  ) = ByteArray(size).also(random::nextBytes)

  private fun heard(
    protocol: Int,
    payload: ByteArray,
    random: Random,
    noiseDb: Double? = null,
  ): List<ByteArray> {
    val received = mutableListOf<ByteArray>()
    val listener = Listener(Band.ULTRASOUND, received::add, {})
    listener.use { pipe(Encoder(protocol).use { it.encode(payload) }, it, random, noiseDb) }
    return received
  }

  @Test
  fun roundTripsAChallengeAndAnAnswer() {
    val random = Random(1)
    for (size in listOf(17, 65)) {
      val sent = payload(random, size)
      val received = heard(Protocol.ULTRASOUND_FASTEST, sent, random)
      assertEquals(1, received.size)
      assertArrayEquals(sent, received.single())
    }
  }

  @Test
  fun decodesWhatItDidNotPlay() {
    var decoded = 0
    repeat(20) { trial ->
      val random = Random(100 + trial)
      val sent = payload(random, 17)
      val received = heard(Protocol.ULTRASOUND_FASTEST, sent, random, noiseDb = 12.0)
      if (received.size == 1 && received.single().contentEquals(sent)) decoded++
    }
    assertEquals(20, decoded)
  }

  @Test
  fun refusesAFrameThatIsNotWhole() {
    Decoder(Protocol.ULTRASOUND_FASTEST).use { decoder ->
      assertThrows(IllegalArgumentException::class.java) { decoder.feed(ShortArray(1000)) }
    }
  }

  @Test
  fun ignoresItsOwnPlayback() {
    val random = Random(2)
    val sent = payload(random, 17)
    val samples = Encoder(Protocol.ULTRASOUND_FASTEST).use { it.encode(sent) }
    var clock = 0L
    val received = mutableListOf<ByteArray>()
    Listener(Band.ULTRASOUND, received::add, {}, { clock }).use { listener ->
      listener.deaf(true)
      pipe(samples, listener, random)
      assertTrue(received.isEmpty())
      listener.deaf(false)
      pipe(samples, listener, random)
      assertTrue(received.isEmpty())
      clock += 201
      pipe(samples, listener, random)
      assertEquals(1, received.size)
    }
  }

  @Test
  fun anotherProtocolIsNotDecoded() {
    val random = Random(3)
    assertTrue(heard(Protocol.ULTRASOUND_NORMAL, payload(random, 17), random).isEmpty())
  }

  @Test
  fun refusesAPayloadLongerThanTheMaximum() {
    Encoder(Protocol.ULTRASOUND_FASTEST).use { encoder ->
      assertThrows(IllegalArgumentException::class.java) { encoder.encode(ByteArray(MAX_PAYLOAD + 1)) }
      assertEquals(true, encoder.encode(ByteArray(MAX_PAYLOAD)).isNotEmpty())
    }
  }

  @Test
  fun freesItsInstances() {
    repeat(10) {
      Decoder(Protocol.ULTRASOUND_FASTEST).use { }
      Encoder(Protocol.ULTRASOUND_FASTEST).use { }
    }
    Decoder(Protocol.AUDIBLE_FASTEST).use { decoder -> assertEquals(null, decoder.feed(ShortArray(FRAME_SAMPLES))) }
  }
}
