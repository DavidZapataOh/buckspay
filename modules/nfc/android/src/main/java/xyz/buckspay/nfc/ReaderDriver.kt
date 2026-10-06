package xyz.buckspay.nfc

private const val CONSUMED_LIMIT = 32

/**
 * Runs sessions across links for one `send` or `receive` call. A tear before any byte of the message
 * moved is invisible to the caller; one in the middle is [Interrupted] and resumable. This is the only
 * place that decides between waiting for the next tap and failing.
 */
internal class ReaderDriver(
  private val source: LinkSource,
  private val pollMillis: Long = 150,
  private val sleep: (Long) -> Unit = { Thread.sleep(it) },
) {
  private val puts = HashMap<String, PutProgress>()

  /** `consumed` holds what this transport already took, so a message shown for a whole session is fetched once. */
  fun receive(
    accept: Int,
    consumed: MutableList<ByteArray>,
    cancelled: () -> Boolean,
    onProgress: (done: Int, total: Int) -> Unit = { _, _ -> },
  ): Received {
    while (true) {
      val link = source.awaitLink(cancelled) ?: throw Cancelled()
      var moving = false
      try {
        val session = ReaderSession(link)
        var info = session.select()
        while (true) {
          if (cancelled()) throw Cancelled()
          if (info != null && info.hasMessage && consumed.none { it.contentEquals(identity(info)) }) {
            val received =
              session.fetch(info) { done, total ->
                moving = true
                onProgress(done, total)
              }
            moving = received != null && moving
            if (received != null) {
              session.confirm(received)
              moving = false
              consumed.add(identity(info))
              if (consumed.size > CONSUMED_LIMIT) consumed.removeAt(0)
              if ((accept shr received.kind) and 1 == 1) return received
            }
          } else {
            sleep(pollMillis)
          }
          info = session.poll()
        }
      } catch (_: LinkLost) {
        if (moving) throw Interrupted()
      }
    }
  }

  fun send(
    kind: Int,
    payload: ByteArray,
    cancelled: () -> Boolean,
    onProgress: (done: Int, total: Int) -> Unit = { _, _ -> },
  ) {
    val key = Wire.check(kind, payload).joinToString("") { "%02x".format(it) } + payload.size
    val progress = puts.getOrPut(key) { PutProgress() }
    while (true) {
      val link = source.awaitLink(cancelled) ?: throw Cancelled()
      val sentBefore = progress.sent
      try {
        val session = ReaderSession(link)
        var info = session.select()
        while (true) {
          if (cancelled()) throw Cancelled()
          val outcome = info?.let { session.put(it, kind, payload, progress, onProgress) } ?: PutOutcome.NotReady
          if (outcome != PutOutcome.NotReady) {
            puts.remove(key)
            return
          }
          sleep(pollMillis)
          info = session.poll()
        }
      } catch (_: LinkLost) {
        if (progress.sent > sentBefore) throw Interrupted()
      }
    }
  }

  private fun identity(info: Info) = byteArrayOf(info.outSeq.toByte(), (info.outSeq shr 8).toByte()) + info.outCheck
}
