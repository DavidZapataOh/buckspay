package xyz.buckspay.nfc

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class ExchangeTest {
  private val any = 0xFF

  @Test
  fun readerReceivesAMessageByteForByteAndConfirmsItSoTheCardsSendCompletes() {
    val card = readyCard()
    val payload = bytes(136, 1)
    val sent = card.offer(0, payload)
    val link = DirectLink(card)
    val received = driver(QueueSource(link)).receive(any, mutableListOf(), ::never)
    assertEquals(0, received.kind)
    assertArrayEquals(payload, received.payload)
    assertTrue(sent.isDone && !sent.isCompletedExceptionally)
    assertEquals(1, link.commands(Wire.INS_DONE))
  }

  @Test
  fun aFirstPaymentTakesOneSelectAndTwoPuts() {
    val card = readyCard()
    val inbox = Inbox()
    card.openReceive(any, inbox)
    val link = DirectLink(card)
    driver(QueueSource(link)).send(1, bytes(387, 2), ::never)
    assertArrayEquals(bytes(387, 2), inbox.messages.single().second)
    assertEquals(3, link.count)
    assertEquals(2, link.commands(Wire.INS_PUT))
  }

  @Test
  fun aTenHopChainMovesInTwentyOnePuts() {
    val card = readyCard()
    val inbox = Inbox()
    card.openReceive(any, inbox)
    val link = DirectLink(card)
    driver(QueueSource(link)).send(1, bytes(4144, 4), ::never)
    assertArrayEquals(bytes(4144, 4), inbox.messages.single().second)
    assertEquals(21, link.commands(Wire.INS_PUT))
  }

  @Test
  fun theMaximumMessageMovesBothWays() {
    val card = readyCard()
    val up = Inbox()
    card.openReceive(any, up)
    driver(QueueSource(DirectLink(card))).send(1, bytes(Wire.MAX_PAYLOAD, 5), ::never)
    assertArrayEquals(bytes(Wire.MAX_PAYLOAD, 5), up.messages.single().second)
    card.closeReceive()
    card.offer(1, bytes(Wire.MAX_PAYLOAD, 6))
    val down = driver(QueueSource(DirectLink(card))).receive(any, mutableListOf(), ::never)
    assertArrayEquals(bytes(Wire.MAX_PAYLOAD, 6), down.payload)
  }

  @Test
  fun anEmptyPayloadMovesBothWays() {
    val card = readyCard()
    val inbox = Inbox()
    card.openReceive(any, inbox)
    driver(QueueSource(DirectLink(card))).send(2, ByteArray(0), ::never)
    assertEquals(
      0,
      inbox.messages
        .single()
        .second.size,
    )
    card.offer(2, ByteArray(0))
    assertEquals(0, driver(QueueSource(DirectLink(card))).receive(any, mutableListOf(), ::never).payload.size)
  }

  @Test
  fun theChunkSizeTheCardAnnouncesDecidesBothDirections() {
    val card = readyCard(100)
    val inbox = Inbox()
    card.openReceive(any, inbox)
    val link = DirectLink(card)
    driver(QueueSource(link)).send(1, bytes(387, 2), ::never)
    assertEquals(4, link.commands(Wire.INS_PUT))
    card.closeReceive()
    card.offer(1, bytes(387, 3))
    val down = DirectLink(card)
    driver(QueueSource(down)).receive(any, mutableListOf(), ::never)
    assertEquals(4, down.commands(Wire.INS_GET))
  }

  @Test
  fun receiveConfirmsAndDropsAKindNobodyAskedForThenTakesTheNextOne() {
    val card = readyCard()
    val unwanted = card.offer(0, bytes(136, 1))
    val link = DirectLink(card)
    val result = arrayOfNulls<Received>(1)
    val t = thread { result[0] = driver(QueueSource(link)).receive(1 shl 2, mutableListOf(), ::never) }
    unwanted.get(2, TimeUnit.SECONDS)
    assertEquals(null, result[0])
    assertEquals(1, link.commands(Wire.INS_GET))
    card.offer(2, bytes(35, 2))
    t.join(2000)
    assertEquals(2, result[0]!!.kind)
    assertEquals(2, link.commands(Wire.INS_GET))
  }

  @Test
  fun receiveDoesNotTakeAMessageItAlreadyConsumed() {
    val card = readyCard()
    card.offer(0, bytes(136, 1))
    val consumed = mutableListOf<ByteArray>()
    val link = DirectLink(card)
    val first = driver(QueueSource(link)).receive(any, consumed, ::never)
    val cancel = AtomicBoolean(false)
    val second = arrayOfNulls<Received>(1)
    val t = thread { runCatching { second[0] = driver(QueueSource(link)).receive(any, consumed, cancel::get) } }
    Thread.sleep(50)
    assertEquals(null, second[0])
    card.offer(0, bytes(136, 9))
    t.join(2000)
    assertFalse(first.payload.contentEquals(second[0]!!.payload))
  }

  @Test
  fun sendWaitsWhileTheCardHasNoReceiveOpenAndThenDelivers() {
    val card = readyCard()
    val inbox = Inbox()
    val done = AtomicBoolean(false)
    val t =
      thread {
        driver(QueueSource(DirectLink(card))).send(1, bytes(387, 2), ::never)
        done.set(true)
      }
    Thread.sleep(60)
    assertFalse(done.get())
    card.openReceive(any, inbox)
    t.join(2000)
    assertTrue(done.get())
    assertArrayEquals(bytes(387, 2), inbox.messages.single().second)
  }

  @Test
  fun sendToACardThatDropsTheKindStillCompletes() {
    val card = readyCard()
    val inbox = Inbox()
    card.openReceive(1 shl 2, inbox)
    driver(QueueSource(DirectLink(card))).send(0, bytes(136, 1), ::never)
    assertTrue(inbox.messages.isEmpty())
  }

  @Test
  fun aTearMidSendIsInterruptedAndTheRetryResumesInsteadOfStartingOver() {
    val card = readyCard(100)
    val inbox = Inbox()
    card.openReceive(any, inbox)
    val payload = bytes(387, 2)
    val drv = driver(QueueSource(DirectLink(card, budget = 3), DirectLink(card)))
    assertThrows(Interrupted::class.java) { drv.send(1, payload, ::never) }
    assertTrue(inbox.messages.isEmpty())
    drv.send(1, payload, ::never)
    assertArrayEquals(payload, inbox.messages.single().second)
  }

  @Test
  fun aTearWhoseResponseWasLostStillResumesWithoutDuplicatingTheMessage() {
    val card = readyCard(100)
    val inbox = Inbox()
    card.openReceive(any, inbox)
    val payload = bytes(387, 2)
    val source = QueueSource(DirectLink(card, dropResponseAt = 3))
    val drv = driver(source)
    assertThrows(Interrupted::class.java) { drv.send(1, payload, ::never) }
    val second = DirectLink(card)
    source.add(second)
    drv.send(1, payload, ::never)
    assertEquals(1, inbox.messages.size)
    assertArrayEquals(payload, inbox.messages.single().second)
    assertEquals(3, second.commands(Wire.INS_PUT))
  }

  @Test
  fun aTearBeforeAnyByteMovedIsNotAnErrorAndTheNextTapCompletes() {
    val card = readyCard()
    val inbox = Inbox()
    card.openReceive(any, inbox)
    val source = QueueSource(DirectLink(card, budget = 0), DirectLink(card))
    driver(source).send(1, bytes(387, 2), ::never)
    assertEquals(1, inbox.messages.size)
  }

  @Test
  fun aTearMidReceiveIsInterruptedDeliversNothingAndLeavesTheOfferPending() {
    val card = readyCard(100)
    val sent = card.offer(1, bytes(387, 2))
    val drv = driver(QueueSource(DirectLink(card, budget = 3)))
    assertThrows(Interrupted::class.java) { drv.receive(any, mutableListOf(), ::never) }
    assertFalse(sent.isDone)
    val received = driver(QueueSource(DirectLink(card))).receive(any, mutableListOf(), ::never)
    assertArrayEquals(bytes(387, 2), received.payload)
    assertTrue(sent.isDone)
  }

  @Test
  fun aTearBeforeReceiveFetchesAnythingWaitsForTheNextTap() {
    val card = readyCard()
    card.offer(1, bytes(387, 2))
    val received = driver(QueueSource(DirectLink(card, budget = 1), DirectLink(card))).receive(any, mutableListOf(), ::never)
    assertEquals(387, received.payload.size)
  }

  @Test
  fun aTearAfterADroppedMessageIsNotInterrupted() {
    val card = readyCard()
    val unwanted = card.offer(0, bytes(20, 1))
    val source = QueueSource(DirectLink(card, budget = 3), DirectLink(card))
    val result = arrayOfNulls<Received>(1)
    val t = thread { result[0] = driver(source).receive(1 shl 2, mutableListOf(), ::never) }
    unwanted.get(2, TimeUnit.SECONDS)
    card.offer(2, bytes(35, 2))
    t.join(2000)
    assertEquals(2, result[0]!!.kind)
  }

  @Test
  fun aMessageReplacedWhileItIsBeingReadIsFetchedAgainFromTheNewOne() {
    val card = readyCard(100)
    card.offer(1, bytes(387, 2))
    val link =
      object : ApduLink {
        private val inner = DirectLink(card)
        private var gets = 0

        override fun transceive(command: ByteArray): ByteArray {
          if (command[1].toInt() == Wire.INS_GET && ++gets == 2) card.offer(1, bytes(300, 8))
          return inner.transceive(command)
        }
      }
    val received = driver(QueueSource(link)).receive(any, mutableListOf(), ::never)
    assertArrayEquals(bytes(300, 8), received.payload)
  }

  @Test
  fun cancelEndsAWaitingReceiveAndAWaitingSend() {
    val card = readyCard()
    val cancel = AtomicBoolean(false)
    val link = DirectLink(card)
    val outcome = arrayOfNulls<Throwable>(2)
    val a = thread { outcome[0] = runCatching { driver(QueueSource(link)).receive(any, mutableListOf(), cancel::get) }.exceptionOrNull() }
    val b = thread { outcome[1] = runCatching { driver(QueueSource(link)).send(1, bytes(5, 1), cancel::get) }.exceptionOrNull() }
    Thread.sleep(50)
    cancel.set(true)
    a.join(2000)
    b.join(2000)
    assertTrue(outcome[0] is Cancelled)
    assertTrue(outcome[1] is Cancelled)
  }

  @Test
  fun aCardThatBreaksTheFormatIsMalformed() {
    val liar =
      ApduLink { command ->
        when {
          command[1].toInt() == 0xA4 || command[1].toInt() == Wire.INS_INFO -> {
            Wire.response(Wire.OK, Info(200, 1, 1, 395, ByteArray(4), 0).encode())
          }

          else -> {
            Wire.response(Wire.OK, ByteArray(10))
          }
        }
      }
    assertThrows(Malformed::class.java) { driver(QueueSource(liar)).receive(any, mutableListOf(), ::never) }
  }

  @Test
  fun aCardThatAnnouncesMoreThanTheMaximumIsMalformed() {
    val liar = ApduLink { Wire.response(Wire.OK, Info(200, 1, 1, 60000, ByteArray(4), 0).encode()) }
    assertThrows(Malformed::class.java) { driver(QueueSource(liar)).receive(any, mutableListOf(), ::never) }
  }

  @Test
  fun aCardWithAChunkCorruptedInTheAirIsMalformedNotDelivered() {
    val card = readyCard(100)
    card.offer(1, bytes(387, 2))
    val link =
      ApduLink { command ->
        val response = card.handle(command)
        if (command[1].toInt() == Wire.INS_GET &&
          command[3].toInt() == 2
        ) {
          response.also { it[5] = (it[5].toInt() xor 0x40).toByte() }
        } else {
          response
        }
      }
    assertThrows(Malformed::class.java) { driver(QueueSource(link)).receive(any, mutableListOf(), ::never) }
  }

  @Test
  fun aCardThatServesAShortChunkIsMalformedAtOnceNotAtTheEnd() {
    val card = readyCard(100)
    card.offer(1, bytes(387, 2))
    var gets = 0
    val link =
      ApduLink { command ->
        val response = card.handle(command)
        if (command[1].toInt() == Wire.INS_GET) gets++
        if (command[1].toInt() == Wire.INS_GET &&
          command[3].toInt() == 0
        ) {
          Wire.response(Wire.OK, Wire.dataOf(response).copyOf(60))
        } else {
          response
        }
      }
    assertThrows(Malformed::class.java) { driver(QueueSource(link)).receive(any, mutableListOf(), ::never) }
    assertEquals(1, gets)
  }

  @Test
  fun aLengthAboveTheMaximumIsRefusedBeforeAnyChunkIsRequested() {
    var gets = 0
    val liar =
      ApduLink { command ->
        if (command[1].toInt() == Wire.INS_GET) gets++
        Wire.response(Wire.OK, Info(200, 1, 1, 60000, ByteArray(4), 0).encode())
      }
    assertThrows(Malformed::class.java) { driver(QueueSource(liar)).receive(any, mutableListOf(), ::never) }
    assertEquals(0, gets)
  }

  @Test
  fun sendTransmitsNothingWhileTheCardReportsNoReceiveOpen() {
    val card = readyCard()
    val link = DirectLink(card)
    val cancel = AtomicBoolean(false)
    val t = thread { runCatching { driver(QueueSource(link)).send(1, bytes(387, 2), cancel::get) } }
    Thread.sleep(60)
    cancel.set(true)
    t.join(2000)
    assertEquals(0, link.commands(Wire.INS_PUT))
  }

  @Test
  fun progressReportsBytesUpToTheTotal() {
    val card = readyCard(100)
    card.offer(1, bytes(387, 2))
    val seen = mutableListOf<Pair<Int, Int>>()
    driver(QueueSource(DirectLink(card))).receive(any, mutableListOf(), ::never) { d, t -> seen.add(d to t) }
    assertEquals(listOf(100 to 395, 200 to 395, 300 to 395, 395 to 395), seen)
  }

  @Test
  fun twoPhonesBackAndForthLikeARequestAPaymentAndAReceipt() {
    val shop = readyCard()
    val payer = driver(QueueSource(DirectLink(shop), DirectLink(shop), DirectLink(shop)))
    val request = bytes(136, 1)
    val sentRequest = shop.offer(0, request)
    val gotRequest = payer.receive(any, mutableListOf(), ::never)
    assertArrayEquals(request, gotRequest.payload)
    assertTrue(sentRequest.isDone)

    val inbox = Inbox()
    shop.openReceive(1 shl 1, inbox)
    payer.send(1, bytes(387, 2), ::never)
    assertEquals(1, inbox.messages.size)
    shop.closeReceive()

    shop.offer(2, bytes(35, 3))
    val receipt = payer.receive(1 shl 2, mutableListOf(), ::never)
    assertArrayEquals(bytes(35, 3), receipt.payload)
    assertNotNull(receipt)
    assertTrue(TimeUnit.SECONDS.toMillis(1) > 0)
  }
}
