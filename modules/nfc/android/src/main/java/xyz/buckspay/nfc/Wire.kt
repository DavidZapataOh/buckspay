package xyz.buckspay.nfc

import java.io.IOException
import java.security.MessageDigest

internal object Wire {
  val AID = hex("F04255434B5350415901")

  const val CLA = 0x80
  const val INS_INFO = 0x10
  const val INS_GET = 0x20
  const val INS_DONE = 0x22
  const val INS_PUT = 0x30

  const val VERSION = 1
  const val HEADER = 8
  const val MAX_PAYLOAD = 8192
  const val DEFAULT_CHUNK = 200
  const val INFO_SIZE = 13

  const val OK = 0x9000
  const val WRONG_LENGTH = 0x6700
  const val NOT_ALLOWED = 0x6985
  const val WRONG_DATA = 0x6A80
  const val NOT_FOUND = 0x6A82
  const val REF_NOT_FOUND = 0x6A88
  const val WRONG_P1P2 = 0x6B00
  const val INS_UNSUPPORTED = 0x6D00
  const val CLA_UNSUPPORTED = 0x6E00

  const val PUT_MORE = 0
  const val PUT_DONE = 1
  const val PUT_DROPPED = 2

  fun hex(text: String) = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

  fun selectCommand() = byteArrayOf(0x00, 0xA4.toByte(), 0x04, 0x00, AID.size.toByte()) + AID + 0x00

  fun command(
    ins: Int,
    p1: Int,
    p2: Int,
    data: ByteArray? = null,
  ): ByteArray {
    val head = byteArrayOf(CLA.toByte(), ins.toByte(), p1.toByte(), p2.toByte())
    return if (data == null) head + 0x00 else head + data.size.toByte() + data
  }

  fun response(
    sw: Int,
    data: ByteArray = ByteArray(0),
  ) = data + byteArrayOf((sw shr 8).toByte(), sw.toByte())

  fun statusOf(response: ByteArray) =
    ((response[response.size - 2].toInt() and 0xFF) shl 8) or (response[response.size - 1].toInt() and 0xFF)

  fun dataOf(response: ByteArray) = response.copyOf(response.size - 2)

  fun check(
    kind: Int,
    payload: ByteArray,
  ): ByteArray {
    val digest = MessageDigest.getInstance("SHA-256")
    digest.update(byteArrayOf(kind.toByte(), payload.size.toByte(), (payload.size shr 8).toByte()))
    return digest.digest(payload).copyOf(4)
  }

  fun stream(
    kind: Int,
    payload: ByteArray,
  ) = byteArrayOf(VERSION.toByte(), kind.toByte(), payload.size.toByte(), (payload.size shr 8).toByte()) + check(kind, payload) + payload
}

internal class Header(
  val kind: Int,
  val length: Int,
  val check: ByteArray,
) {
  val total get() = Wire.HEADER + length

  fun sameAs(other: Header) = kind == other.kind && length == other.length && check.contentEquals(other.check)

  companion object {
    fun parse(bytes: ByteArray): Header? {
      if (bytes.size < Wire.HEADER || bytes[0].toInt() != Wire.VERSION) return null
      val kind = bytes[1].toInt() and 0xFF
      val length = (bytes[2].toInt() and 0xFF) or ((bytes[3].toInt() and 0xFF) shl 8)
      if (kind > 7 || length > Wire.MAX_PAYLOAD) return null
      return Header(kind, length, bytes.copyOfRange(4, 8))
    }
  }
}

internal class Info(
  val chunk: Int,
  val outSeq: Int,
  val outKind: Int,
  val outLength: Int,
  val outCheck: ByteArray,
  val accept: Int,
) {
  val hasMessage get() = outSeq != 0

  fun encode() =
    byteArrayOf(
      Wire.VERSION.toByte(),
      0,
      chunk.toByte(),
      outSeq.toByte(),
      (outSeq shr 8).toByte(),
      outKind.toByte(),
      outLength.toByte(),
      (outLength shr 8).toByte(),
    ) + outCheck + accept.toByte()

  companion object {
    fun parse(bytes: ByteArray): Info? {
      if (bytes.size != Wire.INFO_SIZE || bytes[0].toInt() != Wire.VERSION) return null

      fun u8(i: Int) = bytes[i].toInt() and 0xFF
      return Info(u8(2), u8(3) or (u8(4) shl 8), u8(5), u8(6) or (u8(7) shl 8), bytes.copyOfRange(8, 12), u8(12))
    }
  }
}

internal class LinkLost(
  message: String = "link lost",
) : IOException(message)

internal class Interrupted : IOException("the link broke while a message was moving")

internal class Malformed(
  message: String,
) : IOException(message)
