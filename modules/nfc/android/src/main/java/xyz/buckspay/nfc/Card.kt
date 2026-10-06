package xyz.buckspay.nfc

import java.util.concurrent.CompletableFuture

internal fun interface MessageSink {
  fun onMessage(
    kind: Int,
    payload: ByteArray,
  )
}

internal class BusyException : IllegalStateException("another receive is pending")

private class Outbox(
  val seq: Int,
  val header: Header,
  val stream: ByteArray,
  val sent: CompletableFuture<Unit>,
)

private class Partial(
  val header: Header,
  val stream: ByteArray,
  var received: Int,
  var next: Int,
)

private class Receive(
  val mask: Int,
  val sink: MessageSink,
)

private class Delivery(
  val kind: Int,
  val payload: ByteArray,
  val sink: MessageSink,
)

/**
 * The card side of the protocol: a function from a command APDU to a response over a few bytes of state.
 * It never blocks and never throws for hostile input, so it can answer on the main thread.
 */
internal class CardEndpoint(
  private val chunk: Int = Wire.DEFAULT_CHUNK,
) {
  private val lock = Any()
  private var seq = 0
  private var outbox: Outbox? = null
  private var receive: Receive? = null
  private var partial: Partial? = null
  private var delivered: Header? = null

  @Volatile
  var active = false

  init {
    require(chunk in 1..255)
  }

  /** Shows a message; the future completes on `DONE` and is cancelled when replaced or withdrawn. */
  fun offer(
    kind: Int,
    payload: ByteArray,
  ): CompletableFuture<Unit> {
    require(payload.size <= Wire.MAX_PAYLOAD && kind in 0..7)
    val stream = Wire.stream(kind, payload)
    val sent = CompletableFuture<Unit>()
    synchronized(lock) {
      outbox?.sent?.cancel(false)
      seq = if (seq == 0xFFFF) 1 else seq + 1
      outbox = Outbox(seq, Header.parse(stream)!!, stream, sent)
    }
    return sent
  }

  /** Clears the outbox and cancels its offer; with `only`, does nothing unless that offer is still shown. */
  fun withdraw(only: CompletableFuture<Unit>? = null) {
    synchronized(lock) {
      if (only != null && outbox?.sent !== only) return
      outbox?.sent?.cancel(false)
      outbox = null
    }
  }

  fun openReceive(
    acceptMask: Int,
    to: MessageSink,
  ) {
    synchronized(lock) {
      if (receive != null) throw BusyException()
      receive = Receive(acceptMask, to)
      partial = null
      delivered = null
    }
  }

  fun closeReceive() {
    synchronized(lock) {
      receive = null
      partial = null
    }
  }

  /** The NFC link ended; a partial message is kept so the next tap resumes it. */
  fun onDeactivated() = Unit

  fun handle(apdu: ByteArray): ByteArray {
    if (!active) return Wire.response(Wire.NOT_FOUND)
    var delivery: Delivery? = null
    val response =
      try {
        synchronized(lock) { dispatch(apdu) { delivery = it } }
      } catch (_: RuntimeException) {
        Wire.response(Wire.WRONG_DATA)
      }
    delivery?.let { it.sink.onMessage(it.kind, it.payload) }
    return response
  }

  private fun info(): ByteArray {
    val shown = outbox
    return Info(
      chunk,
      shown?.seq ?: 0,
      shown?.header?.kind ?: 0,
      shown?.stream?.size ?: 0,
      shown?.header?.check ?: ByteArray(4),
      receive?.mask ?: 0,
    ).encode()
  }

  private fun dispatch(
    apdu: ByteArray,
    deliver: (Delivery) -> Unit,
  ): ByteArray {
    if (apdu.isEmpty()) return Wire.response(Wire.WRONG_LENGTH)
    val cla = apdu[0].toInt() and 0xFF
    if (cla != 0x00 && cla != Wire.CLA) return Wire.response(Wire.CLA_UNSUPPORTED)
    if (apdu.size < 5) return Wire.response(Wire.WRONG_LENGTH)
    val ins = apdu[1].toInt() and 0xFF
    val p1 = apdu[2].toInt() and 0xFF
    val p2 = apdu[3].toInt() and 0xFF
    val lc = apdu[4].toInt() and 0xFF
    val wellFormed = if (apdu.size == 5) lc == 0 else apdu.size == 5 + lc || apdu.size == 6 + lc
    if (!wellFormed) return Wire.response(Wire.WRONG_LENGTH)
    val data = if (apdu.size == 5) ByteArray(0) else apdu.copyOfRange(5, 5 + lc)
    if (cla == 0x00) {
      if (ins != 0xA4) return Wire.response(Wire.CLA_UNSUPPORTED)
      val selectsUs = p1 == 0x04 && data.contentEquals(Wire.AID)
      return if (selectsUs) Wire.response(Wire.OK, info()) else Wire.response(Wire.NOT_FOUND)
    }
    return when (ins) {
      Wire.INS_INFO -> Wire.response(Wire.OK, info())
      Wire.INS_GET -> get(p1, p2)
      Wire.INS_DONE -> done(p1)
      Wire.INS_PUT -> put(p1, p2, data, deliver)
      else -> Wire.response(Wire.INS_UNSUPPORTED)
    }
  }

  private fun get(
    p1: Int,
    index: Int,
  ): ByteArray {
    val shown = outbox
    if (shown == null || shown.seq and 0xFF != p1) return Wire.response(Wire.REF_NOT_FOUND)
    val from = index * chunk
    if (from >= shown.stream.size) return Wire.response(Wire.WRONG_P1P2)
    return Wire.response(Wire.OK, shown.stream.copyOfRange(from, minOf(shown.stream.size, from + chunk)))
  }

  private fun done(p1: Int): ByteArray {
    val shown = outbox
    if (shown == null || shown.seq and 0xFF != p1) return Wire.response(Wire.REF_NOT_FOUND)
    shown.sent.complete(Unit)
    return Wire.response(Wire.OK)
  }

  private fun reply(
    status: Int,
    next: Int = 0,
  ) = Wire.response(Wire.OK, byteArrayOf(status.toByte(), next.toByte()))

  private fun put(
    tag: Int,
    index: Int,
    data: ByteArray,
    deliver: (Delivery) -> Unit,
  ): ByteArray {
    val open = receive ?: return Wire.response(Wire.NOT_ALLOWED)
    if (index == 0) return start(open, tag, data, deliver)
    val current = partial
    if (current == null || current.header.check[0].toInt() and 0xFF != tag) return reply(Wire.PUT_MORE, 0)
    if (index != current.next) return reply(Wire.PUT_MORE, current.next)
    if (data.size != minOf(chunk, current.header.total - current.received)) return discard()
    data.copyInto(current.stream, current.received)
    current.received += data.size
    current.next++
    if (current.received < current.header.total) return reply(Wire.PUT_MORE, current.next)
    partial = null
    return complete(open, current.header, current.stream, deliver)
  }

  private fun start(
    open: Receive,
    tag: Int,
    data: ByteArray,
    deliver: (Delivery) -> Unit,
  ): ByteArray {
    val header = Header.parse(data) ?: return discard()
    if (data.size != minOf(chunk, header.total) || header.check[0].toInt() and 0xFF != tag) return discard()
    if ((open.mask shr header.kind) and 1 == 0) return reply(Wire.PUT_DROPPED)
    if (delivered?.sameAs(header) == true) return reply(Wire.PUT_DONE)
    partial?.let { if (it.header.sameAs(header)) return reply(Wire.PUT_MORE, it.next) }
    val stream = ByteArray(header.total)
    data.copyInto(stream)
    if (data.size < header.total) {
      partial = Partial(header, stream, data.size, 1)
      return reply(Wire.PUT_MORE, 1)
    }
    partial = null
    return complete(open, header, stream, deliver)
  }

  private fun complete(
    open: Receive,
    header: Header,
    stream: ByteArray,
    deliver: (Delivery) -> Unit,
  ): ByteArray {
    val payload = stream.copyOfRange(Wire.HEADER, header.total)
    if (!Wire.check(header.kind, payload).contentEquals(header.check)) return Wire.response(Wire.WRONG_DATA)
    delivered = header
    deliver(Delivery(header.kind, payload, open.sink))
    return reply(Wire.PUT_DONE)
  }

  private fun discard(): ByteArray {
    partial = null
    return Wire.response(Wire.WRONG_DATA)
  }
}
