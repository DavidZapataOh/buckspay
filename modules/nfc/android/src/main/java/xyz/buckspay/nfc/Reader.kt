package xyz.buckspay.nfc

/** One NFC contact. `transceive` blocks and throws [LinkLost] when the link is gone. */
internal fun interface ApduLink {
  fun transceive(command: ByteArray): ByteArray
}

/** Hands out the next link; null once `cancelled` is true. */
internal fun interface LinkSource {
  fun awaitLink(cancelled: () -> Boolean): ApduLink?
}

internal class Cancelled : RuntimeException("cancelled")

internal class Received(
  val kind: Int,
  val payload: ByteArray,
  val seq: Int,
  val check: ByteArray,
)

internal class PutProgress {
  var next = 0
  var sent = 0
}

internal enum class PutOutcome { Delivered, Dropped, NotReady }

/** The reader's side of one link. */
internal class ReaderSession(
  private val link: ApduLink,
) {
  fun select(): Info? {
    val response = link.transceive(Wire.selectCommand())
    return if (Wire.statusOf(response) == Wire.OK) Info.parse(Wire.dataOf(response)) else null
  }

  fun poll(): Info? {
    val response = link.transceive(Wire.command(Wire.INS_INFO, 0, 0))
    return if (Wire.statusOf(response) == Wire.OK) Info.parse(Wire.dataOf(response)) else select()
  }

  /** The announced message, or null when the card replaced it meanwhile. */
  fun fetch(
    info: Info,
    onProgress: (done: Int, total: Int) -> Unit = { _, _ -> },
  ): Received? {
    val total = info.outLength
    if (total < Wire.HEADER || total > Wire.HEADER + Wire.MAX_PAYLOAD) throw Malformed("announced length")
    if (info.chunk == 0) throw Malformed("chunk size")
    val stream = ByteArray(total)
    var done = 0
    var index = 0
    while (done < total) {
      val response = link.transceive(Wire.command(Wire.INS_GET, info.outSeq and 0xFF, index))
      val status = Wire.statusOf(response)
      if (status == Wire.REF_NOT_FOUND) return null
      if (status != Wire.OK) throw Malformed("status %04X".format(status))
      val part = Wire.dataOf(response)
      if (part.size != minOf(info.chunk, total - done)) throw Malformed("chunk size")
      part.copyInto(stream, done)
      done += part.size
      index++
      onProgress(done, total)
    }
    val header = Header.parse(stream) ?: throw Malformed("header")
    if (header.total != total || header.kind != info.outKind || !header.check.contentEquals(info.outCheck)) throw Malformed("header")
    val payload = stream.copyOfRange(Wire.HEADER, total)
    if (!Wire.check(header.kind, payload).contentEquals(header.check)) throw Malformed("check")
    return Received(header.kind, payload, info.outSeq, header.check)
  }

  fun confirm(received: Received) {
    link.transceive(Wire.command(Wire.INS_DONE, received.seq and 0xFF, 0))
  }

  /** Pushes from where the card says it is; transmits nothing to a card with no receive open. */
  fun put(
    info: Info,
    kind: Int,
    payload: ByteArray,
    progress: PutProgress,
    onProgress: (done: Int, total: Int) -> Unit = { _, _ -> },
  ): PutOutcome {
    if (info.accept == 0 || info.chunk == 0) return PutOutcome.NotReady
    val stream = Wire.stream(kind, payload)
    val tag = stream[4].toInt() and 0xFF
    val count = (stream.size + info.chunk - 1) / info.chunk
    var index = if (progress.next in 0 until count) progress.next else 0
    repeat(2 * count + 2) {
      val from = index * info.chunk
      val part = stream.copyOfRange(from, minOf(stream.size, from + info.chunk))
      progress.sent++
      val response = link.transceive(Wire.command(Wire.INS_PUT, tag, index, part))
      when (val status = Wire.statusOf(response)) {
        Wire.OK -> Unit
        Wire.NOT_ALLOWED, Wire.NOT_FOUND -> return PutOutcome.NotReady
        else -> throw Malformed("status %04X".format(status))
      }
      val answer = Wire.dataOf(response)
      if (answer.size != 2) throw Malformed("answer")
      val next = answer[1].toInt() and 0xFF
      when (answer[0].toInt()) {
        Wire.PUT_DONE -> {
          return PutOutcome.Delivered
        }

        Wire.PUT_DROPPED -> {
          return PutOutcome.Dropped
        }

        Wire.PUT_MORE -> {
          if (next >= count) throw Malformed("next chunk")
          progress.next = next
          index = next
          onProgress(minOf(next * info.chunk, stream.size), stream.size)
        }

        else -> {
          throw Malformed("answer")
        }
      }
    }
    throw Malformed("no progress")
  }
}
