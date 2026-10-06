package xyz.buckspay.copresence

import android.media.AudioDeviceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class VolumeTest {
  @Test
  fun isLowBelowSixtyPercentOfTheMaximum() {
    assertTrue(volumeLow(8, 15))
    assertFalse(volumeLow(9, 15))
    assertTrue(volumeLow(0, 15))
    assertFalse(volumeLow(15, 15))
  }

  @Test
  fun isLowWhenTheMaximumIsUnknown() {
    assertTrue(volumeLow(5, 0))
  }
}

class SourceTest {
  @Test
  fun prefersUnprocessedOnlyWhenTheDeviceSaysItHasIt() {
    assertTrue(useUnprocessed("true"))
    assertFalse(useUnprocessed("false"))
    assertFalse(useUnprocessed(null))
  }
}

class SilenceTest {
  @Test
  fun aFrameOfZerosIsSilentAndAnyOtherSampleIsNot() {
    assertTrue(isSilentFrame(ShortArray(FRAME_SAMPLES)))
    assertFalse(isSilentFrame(ShortArray(FRAME_SAMPLES).also { it[FRAME_SAMPLES - 1] = 1 }))
  }

  @Test
  fun aSecondOfFramesIsWhatMakesAMicrophoneSilenced() {
    assertEquals(46, SILENT_FRAMES)
  }
}

class RouteTest {
  @Test
  fun readsTheSpeakerOnlyWhenNoHeadsetIsConnected() {
    assertEquals("speaker", routeOf(listOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)))
    assertEquals("headset", routeOf(listOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_WIRED_HEADSET)))
    assertEquals("bluetooth", routeOf(listOf(AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP)))
  }
}

class BandTest {
  @Test
  fun parsesTheTwoBandsAndNothingElse() {
    assertEquals(Band.ULTRASOUND, Band.parse("ultrasound"))
    assertEquals(Band.AUDIBLE, Band.parse("audible"))
    assertThrows(IllegalArgumentException::class.java) { Band.parse("infrasound") }
  }
}
