package xyz.buckspay.mesh

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream

class BeaconTest {
  @Test
  fun matchesTheBytesJavaScriptDecodes() {
    // The same vector as `beacon.test.ts`: version 1, online, tag 1 2 3 4, key 7, PSM 0x0081.
    val frame = beaconFrame(true, byteArrayOf(1, 2, 3, 4), 7, 0x0081)
    assertArrayEquals(byteArrayOf(1, 1, 1, 1, 2, 3, 4, 7, 0, 0x81.toByte()), frame)
    assertEquals(10, frame.size)
  }

  @Test
  fun clearsTheOnlineBitAndKeepsAHighPsmUnsigned() {
    val frame = beaconFrame(false, byteArrayOf(0, 0, 0, 0), 255, 0xFFFF)
    assertEquals(0, frame[2].toInt())
    assertEquals(0xFF, frame[8].toInt() and 0xFF)
    assertEquals(0xFF, frame[9].toInt() and 0xFF)
  }

  @Test
  fun refusesAClusterTagOfTheWrongLength() {
    assertThrows(IllegalArgumentException::class.java) { beaconFrame(true, byteArrayOf(1), 0, 0x81) }
  }
}

class ReadExactlyTest {
  private class Trickle(
    private val data: ByteArray,
  ) : InputStream() {
    private var at = 0

    override fun read(): Int = if (at < data.size) data[at++].toInt() and 0xFF else -1

    override fun read(
      buffer: ByteArray,
      offset: Int,
      length: Int,
    ): Int {
      if (at >= data.size) return -1
      buffer[offset] = data[at++]
      return 1
    }
  }

  @Test
  fun collectsABlobThatArrivesInPieces() {
    val data = ByteArray(300) { it.toByte() }
    assertArrayEquals(data.copyOf(200), readExactly(Trickle(data), 200))
  }

  @Test
  fun failsWhenThePeerClosesFirst() {
    assertThrows(IOException::class.java) { readExactly(ByteArrayInputStream(ByteArray(3)), 4) }
  }
}
