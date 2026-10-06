package xyz.buckspay.nfc

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

fun bytes(
  length: Int,
  seed: Int,
) = ByteArray(length) { ((it * 31 + seed) and 0xFF).toByte() }

internal fun cmd(
  ins: Int,
  p1: Int,
  p2: Int,
  data: ByteArray? = null,
) = Wire.command(ins, p1, p2, data)

internal fun readyCard(chunk: Int = Wire.DEFAULT_CHUNK) = CardEndpoint(chunk).also { it.active = true }

internal class Inbox : MessageSink {
  val messages = mutableListOf<Pair<Int, ByteArray>>()

  override fun onMessage(
    kind: Int,
    payload: ByteArray,
  ) {
    messages.add(kind to payload)
  }
}

/** A link straight into a card; `budget` commands succeed and the next throws [LinkLost]. */
internal class DirectLink(
  private val card: CardEndpoint,
  private val budget: Int = Int.MAX_VALUE,
  private val dropResponseAt: Int = -1,
) : ApduLink {
  var count = 0
  val log = mutableListOf<ByteArray>()

  override fun transceive(command: ByteArray): ByteArray {
    if (count >= budget) throw LinkLost()
    count++
    log.add(command)
    val response = card.handle(command)
    if (count == dropResponseAt) throw LinkLost("response lost")
    return response
  }

  fun commands(ins: Int) = log.count { (it[0].toInt() and 0xFF) == Wire.CLA && (it[1].toInt() and 0xFF) == ins }
}

internal class QueueSource(
  vararg links: ApduLink,
) : LinkSource {
  private val queue = LinkedBlockingQueue<ApduLink>(links.toList())

  fun add(link: ApduLink) = queue.add(link)

  override fun awaitLink(cancelled: () -> Boolean): ApduLink? {
    while (!cancelled()) {
      queue.poll(20, TimeUnit.MILLISECONDS)?.let { return it }
    }
    return null
  }
}

internal fun driver(source: LinkSource) = ReaderDriver(source, pollMillis = 1, sleep = { Thread.sleep(it) })

internal fun never() = false
