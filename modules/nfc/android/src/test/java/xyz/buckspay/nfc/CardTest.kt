package xyz.buckspay.nfc

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CancellationException

class WireTest {
  @Test
  fun selectCommandIsTheIso7816SelectByName() {
    assertArrayEquals(
      Wire.hex("00A404000AF04255434B535041590100"),
      Wire.selectCommand(),
    )
  }

  @Test
  fun theAidIsAProprietaryApplicationIdentifier() {
    assertEquals(10, Wire.AID.size)
    assertEquals(0xF0, Wire.AID[0].toInt() and 0xF0)
  }

  @Test
  fun streamIsHeaderThenPayloadAndTheCheckCoversKindAndLength() {
    val payload = bytes(387, 2)
    val stream = Wire.stream(1, payload)
    assertEquals(8 + 387, stream.size)
    val header = Header.parse(stream)!!
    assertEquals(1, header.kind)
    assertEquals(387, header.length)
    assertArrayEquals(Wire.check(1, payload), header.check)
    assertFalse(Wire.check(1, payload).contentEquals(Wire.check(2, payload)))
    assertFalse(Wire.check(1, payload).contentEquals(Wire.check(1, payload + 0)))
  }

  @Test
  fun headerParserRefusesAnotherVersionAKindAbove7AndALengthAboveTheMaximum() {
    val good = Wire.stream(0, bytes(10, 1))
    assertNotNull(Header.parse(good))
    assertNull(Header.parse(good.copyOf().also { it[0] = 2 }))
    assertNull(Header.parse(good.copyOf().also { it[1] = 8 }))
    assertNull(
      Header.parse(
        good.copyOf().also {
          it[2] = 0x01
          it[3] = 0x20
        },
      ),
    )
    assertNull(Header.parse(good.copyOf(7)))
  }

  @Test
  fun infoRoundTripsInThirteenBytes() {
    val info = Info(200, 0x1234, 2, 395, byteArrayOf(1, 2, 3, 4), 0x06)
    val bytes = info.encode()
    assertEquals(13, bytes.size)
    val back = Info.parse(bytes)!!
    assertEquals(listOf(200, 0x1234, 2, 395, 6), listOf(back.chunk, back.outSeq, back.outKind, back.outLength, back.accept))
    assertArrayEquals(byteArrayOf(1, 2, 3, 4), back.outCheck)
    assertNull(Info.parse(bytes.copyOf(12)))
  }
}

class CardTest {
  private fun status(response: ByteArray) = Wire.statusOf(response)

  @Test
  fun anInactiveCardAnswersFileNotFoundToEverything() {
    val card = CardEndpoint()
    assertEquals(Wire.NOT_FOUND, status(card.handle(Wire.selectCommand())))
    assertEquals(Wire.NOT_FOUND, status(card.handle(cmd(Wire.INS_INFO, 0, 0))))
  }

  @Test
  fun selectOfAnotherAidIsFileNotFound() {
    val card = readyCard()
    val other = byteArrayOf(0x00, 0xA4.toByte(), 0x04, 0x00, 0x05, 1, 2, 3, 4, 5, 0x00)
    assertEquals(Wire.NOT_FOUND, status(card.handle(other)))
  }

  @Test
  fun selectOfOursReturnsAnEmptyInfo() {
    val card = readyCard()
    val response = card.handle(Wire.selectCommand())
    assertEquals(Wire.OK, status(response))
    val info = Info.parse(Wire.dataOf(response))!!
    assertEquals(Wire.DEFAULT_CHUNK, info.chunk)
    assertFalse(info.hasMessage)
    assertEquals(0, info.accept)
  }

  @Test
  fun unknownClassAndInstructionAreRefused() {
    val card = readyCard()
    assertEquals(Wire.CLA_UNSUPPORTED, status(card.handle(byteArrayOf(0x90.toByte(), 0x10, 0, 0, 0))))
    assertEquals(Wire.INS_UNSUPPORTED, status(card.handle(cmd(0x7E, 0, 0))))
    assertEquals(Wire.WRONG_LENGTH, status(card.handle(byteArrayOf(0x80.toByte(), 0x10))))
    assertEquals(Wire.WRONG_LENGTH, status(card.handle(byteArrayOf(0x80.toByte(), 0x10, 0, 0, 5))))
  }

  @Test
  fun offerShowsTheMessageInInfoAndANewOfferReplacesItAndCancelsTheOldOne() {
    val card = readyCard()
    val first = card.offer(0, bytes(136, 1))
    val info1 = Info.parse(Wire.dataOf(card.handle(cmd(Wire.INS_INFO, 0, 0))))!!
    assertEquals(listOf(1, 0, 8 + 136), listOf(info1.outSeq, info1.outKind, info1.outLength))
    val second = card.offer(2, bytes(35, 2))
    val info2 = Info.parse(Wire.dataOf(card.handle(cmd(Wire.INS_INFO, 0, 0))))!!
    assertEquals(listOf(2, 2, 8 + 35), listOf(info2.outSeq, info2.outKind, info2.outLength))
    assertThrows(CancellationException::class.java) { first.get() }
    assertFalse(second.isDone)
  }

  @Test
  fun getReturnsTheStreamInChunksTheLastOneShorter() {
    val card = readyCard(100)
    val payload = bytes(387, 2)
    card.offer(1, payload)
    val parts = (0..3).map { Wire.dataOf(card.handle(cmd(Wire.INS_GET, 1, it))) }
    assertEquals(listOf(100, 100, 100, 95), parts.map { it.size })
    assertArrayEquals(Wire.stream(1, payload), parts.reduce { a, b -> a + b })
  }

  @Test
  fun getRefusesAStaleSequenceAnIndexPastTheEndAndAnEmptyOutbox() {
    val card = readyCard()
    assertEquals(Wire.REF_NOT_FOUND, status(card.handle(cmd(Wire.INS_GET, 1, 0))))
    card.offer(1, bytes(10, 1))
    assertEquals(Wire.REF_NOT_FOUND, status(card.handle(cmd(Wire.INS_GET, 2, 0))))
    assertEquals(Wire.WRONG_P1P2, status(card.handle(cmd(Wire.INS_GET, 1, 1))))
    assertEquals(Wire.OK, status(card.handle(cmd(Wire.INS_GET, 1, 0))))
  }

  @Test
  fun doneCompletesTheOfferAndIsIdempotentAndTheMessageKeepsBeingServed() {
    val card = readyCard()
    val sent = card.offer(0, bytes(20, 3))
    assertFalse(sent.isDone)
    assertEquals(Wire.REF_NOT_FOUND, status(card.handle(cmd(Wire.INS_DONE, 9, 0))))
    assertFalse(sent.isDone)
    assertEquals(Wire.OK, status(card.handle(cmd(Wire.INS_DONE, 1, 0))))
    assertTrue(sent.isDone && !sent.isCompletedExceptionally)
    assertEquals(Wire.OK, status(card.handle(cmd(Wire.INS_DONE, 1, 0))))
    assertEquals(Wire.OK, status(card.handle(cmd(Wire.INS_GET, 1, 0))))
  }

  @Test
  fun withdrawClearsTheOutboxAndCancelsTheOffer() {
    val card = readyCard()
    val sent = card.offer(0, bytes(20, 3))
    card.withdraw()
    assertTrue(sent.isCompletedExceptionally)
    assertFalse(Info.parse(Wire.dataOf(card.handle(cmd(Wire.INS_INFO, 0, 0))))!!.hasMessage)
  }

  private fun putAll(
    card: CardEndpoint,
    kind: Int,
    payload: ByteArray,
    chunk: Int = Wire.DEFAULT_CHUNK,
    from: Int = 0,
    to: Int = Int.MAX_VALUE,
  ): List<ByteArray> {
    val stream = Wire.stream(kind, payload)
    val tag = stream[4].toInt() and 0xFF
    val count = (stream.size + chunk - 1) / chunk
    return (from until minOf(count, to)).map {
      card.handle(cmd(Wire.INS_PUT, tag, it, stream.copyOfRange(it * chunk, minOf(stream.size, (it + 1) * chunk))))
    }
  }

  @Test
  fun putIsNotAllowedWhileNoReceiveIsOpen() {
    val card = readyCard()
    assertEquals(Wire.NOT_ALLOWED, status(putAll(card, 1, bytes(387, 2)).first()))
  }

  @Test
  fun putDeliversAFirstPaymentOfTwoChunksExactlyOnce() {
    val card = readyCard()
    val inbox = Inbox()
    card.openReceive(0xFF, inbox)
    val payload = bytes(387, 2)
    val replies = putAll(card, 1, payload)
    assertEquals(2, replies.size)
    assertEquals(listOf(Wire.PUT_MORE, 1), Wire.dataOf(replies[0]).map { it.toInt() })
    assertEquals(listOf(Wire.PUT_DONE, 0), Wire.dataOf(replies[1]).map { it.toInt() })
    assertEquals(1, inbox.messages.size)
    assertEquals(1, inbox.messages[0].first)
    assertArrayEquals(payload, inbox.messages[0].second)
  }

  @Test
  fun putOfAMessageThatFitsOneChunkNeedsOneCommand() {
    val card = readyCard()
    val inbox = Inbox()
    card.openReceive(0xFF, inbox)
    val replies = putAll(card, 2, bytes(35, 5))
    assertEquals(1, replies.size)
    assertEquals(Wire.PUT_DONE, Wire.dataOf(replies[0])[0].toInt())
    assertEquals(1, inbox.messages.size)
  }

  @Test
  fun putWithAWrongCheckIsRefusedAndNothingIsDelivered() {
    val card = readyCard()
    val inbox = Inbox()
    card.openReceive(0xFF, inbox)
    val stream = Wire.stream(1, bytes(387, 2)).also { it[300] = (it[300].toInt() xor 1).toByte() }
    val tag = stream[4].toInt() and 0xFF
    card.handle(cmd(Wire.INS_PUT, tag, 0, stream.copyOfRange(0, 200)))
    val last = card.handle(cmd(Wire.INS_PUT, tag, 1, stream.copyOfRange(200, stream.size)))
    assertEquals(Wire.WRONG_DATA, status(last))
    assertTrue(inbox.messages.isEmpty())
  }

  @Test
  fun putOfAKindNobodyAcceptsIsAcknowledgedAsDroppedAfterTheFirstChunk() {
    val card = readyCard()
    val inbox = Inbox()
    card.openReceive(1 shl 1, inbox)
    val reply = putAll(card, 0, bytes(387, 2), to = 1).single()
    assertEquals(listOf(Wire.PUT_DROPPED, 0), Wire.dataOf(reply).map { it.toInt() })
    assertTrue(inbox.messages.isEmpty())
  }

  @Test
  fun putRefusesAHeaderWithTheWrongVersionOrAnOversizeLength() {
    val card = readyCard()
    card.openReceive(0xFF, Inbox())
    val bad = Wire.stream(1, bytes(20, 1)).also { it[0] = 9 }
    assertEquals(Wire.WRONG_DATA, status(card.handle(cmd(Wire.INS_PUT, bad[4].toInt() and 0xFF, 0, bad))))
    val big =
      Wire.stream(1, bytes(20, 1)).also {
        it[2] = 0x01
        it[3] = 0x20
      }
    assertEquals(Wire.WRONG_DATA, status(card.handle(cmd(Wire.INS_PUT, big[4].toInt() and 0xFF, 0, big.copyOf(200)))))
  }

  @Test
  fun aSecondMessageOfTheMaximumSizeIsAccepted() {
    val card = readyCard()
    val inbox = Inbox()
    card.openReceive(0xFF, inbox)
    val payload = bytes(Wire.MAX_PAYLOAD, 7)
    val replies = putAll(card, 1, payload)
    assertEquals(41, replies.size)
    assertArrayEquals(payload, inbox.messages.single().second)
  }

  @Test
  fun putResumesAfterTheLinkEndsFromWhereTheCardStopped() {
    val card = readyCard(100)
    val inbox = Inbox()
    card.openReceive(0xFF, inbox)
    val payload = bytes(387, 2)
    putAll(card, 1, payload, chunk = 100, to = 2)
    card.onDeactivated()
    val rest = putAll(card, 1, payload, chunk = 100, from = 2)
    assertEquals(2, rest.size)
    assertEquals(Wire.PUT_DONE, Wire.dataOf(rest.last())[0].toInt())
    assertArrayEquals(payload, inbox.messages.single().second)
  }

  @Test
  fun aDuplicateOrSkippedChunkAnswersWhereTheCardIsAndChangesNothing() {
    val card = readyCard(100)
    val inbox = Inbox()
    card.openReceive(0xFF, inbox)
    val payload = bytes(387, 2)
    putAll(card, 1, payload, chunk = 100, to = 2)
    val stream = Wire.stream(1, payload)
    val tag = stream[4].toInt() and 0xFF
    val duplicate = card.handle(cmd(Wire.INS_PUT, tag, 1, stream.copyOfRange(100, 200)))
    assertEquals(listOf(Wire.PUT_MORE, 2), Wire.dataOf(duplicate).map { it.toInt() })
    val skipped = card.handle(cmd(Wire.INS_PUT, tag, 3, stream.copyOfRange(300, 395)))
    assertEquals(listOf(Wire.PUT_MORE, 2), Wire.dataOf(skipped).map { it.toInt() })
    val firstAgain = card.handle(cmd(Wire.INS_PUT, tag, 0, stream.copyOfRange(0, 100)))
    assertEquals(listOf(Wire.PUT_MORE, 2), Wire.dataOf(firstAgain).map { it.toInt() })
    assertTrue(inbox.messages.isEmpty())
    val rest = putAll(card, 1, payload, chunk = 100, from = 2)
    assertEquals(Wire.PUT_DONE, Wire.dataOf(rest.last())[0].toInt())
    assertEquals(1, inbox.messages.size)
  }

  @Test
  fun aDifferentMessageStartingWhileOneIsPartialReplacesIt() {
    val card = readyCard(100)
    val inbox = Inbox()
    card.openReceive(0xFF, inbox)
    putAll(card, 1, bytes(387, 2), chunk = 100, to = 2)
    val other = bytes(250, 9)
    putAll(card, 1, other, chunk = 100)
    assertArrayEquals(other, inbox.messages.single().second)
  }

  @Test
  fun theSameMessageAfterItsDeliveryIsAcknowledgedWithoutDeliveringAgain() {
    val card = readyCard()
    val inbox = Inbox()
    card.openReceive(0xFF, inbox)
    val payload = bytes(387, 2)
    putAll(card, 1, payload)
    val again = putAll(card, 1, payload, to = 1).single()
    assertEquals(listOf(Wire.PUT_DONE, 0), Wire.dataOf(again).map { it.toInt() })
    assertEquals(1, inbox.messages.size)
  }

  @Test
  fun aSecondOpenReceiveIsBusyUntilTheFirstCloses() {
    val card = readyCard()
    card.openReceive(0xFF, Inbox())
    assertThrows(BusyException::class.java) { card.openReceive(0xFF, Inbox()) }
    card.closeReceive()
    card.openReceive(0x01, Inbox())
  }

  @Test
  fun infoAdvertisesWhichKindsAreAccepted() {
    val card = readyCard()
    card.openReceive((1 shl 1) or (1 shl 2), Inbox())
    assertEquals(6, Info.parse(Wire.dataOf(card.handle(cmd(Wire.INS_INFO, 0, 0))))!!.accept)
    card.closeReceive()
    assertEquals(0, Info.parse(Wire.dataOf(card.handle(cmd(Wire.INS_INFO, 0, 0))))!!.accept)
  }
}
