package xyz.buckspay.nfc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class EdgesTest {
  private val any = 0xFF

  private fun put(
    card: CardEndpoint,
    stream: ByteArray,
    index: Int,
    from: Int,
    to: Int,
  ) = card.handle(cmd(Wire.INS_PUT, stream[4].toInt() and 0xFF, index, stream.copyOfRange(from, to)))

  @Test
  fun aFirstChunkOfTheWrongSizeIsRefused() {
    val card = readyCard(100)
    card.openReceive(any, Inbox())
    val stream = Wire.stream(1, bytes(387, 2))
    assertEquals(Wire.WRONG_DATA, Wire.statusOf(put(card, stream, 0, 0, 60)))
  }

  @Test
  fun aLaterChunkOfTheWrongSizeIsRefusedAndTheMessageIsDiscarded() {
    val card = readyCard(100)
    card.openReceive(any, Inbox())
    val stream = Wire.stream(1, bytes(387, 2))
    put(card, stream, 0, 0, 100)
    assertEquals(Wire.WRONG_DATA, Wire.statusOf(put(card, stream, 1, 100, 140)))
    assertEquals(listOf(Wire.PUT_MORE, 0), Wire.dataOf(put(card, stream, 1, 100, 200)).map { it.toInt() })
  }

  @Test
  fun theRetryAfterATearStartsWhereTheCardIs() {
    val card = readyCard(100)
    card.openReceive(any, Inbox())
    val payload = bytes(387, 2)
    val second = DirectLink(card)
    val drv = driver(QueueSource(DirectLink(card, budget = 3), second))
    assertThrows(Interrupted::class.java) { drv.send(1, payload, ::never) }
    drv.send(1, payload, ::never)
    assertEquals(2, second.commands(Wire.INS_PUT))
  }

  @Test
  fun theReaderJumpsToWhereTheCardAlreadyIs() {
    val card = readyCard(100)
    val inbox = Inbox()
    card.openReceive(any, inbox)
    val payload = bytes(387, 2)
    val stream = Wire.stream(1, payload)
    (0..2).forEach { put(card, stream, it, it * 100, (it + 1) * 100) }
    val link = DirectLink(card)
    driver(QueueSource(link)).send(1, payload, ::never)
    assertEquals(2, link.commands(Wire.INS_PUT))
    assertEquals(1, inbox.messages.size)
  }

  @Test
  fun aCardWhoseInfoDisagreesWithItsHeaderIsMalformed() {
    val card = readyCard(100)
    card.offer(1, bytes(387, 2))
    val link =
      ApduLink { command ->
        val response = card.handle(command)
        if ((command[1].toInt() and 0xFF) == 0xA4) response.also { it[5] = 0 } else response
      }
    assertThrows(Malformed::class.java) { driver(QueueSource(link)).receive(any, mutableListOf(), ::never) }
  }
}
