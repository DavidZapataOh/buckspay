package xyz.buckspay.hardwarekeys

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertThrows
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyStore

/** Run phase 1, kill the test process, run phase 2: the guard must refuse across a real process restart. */
@RunWith(AndroidJUnit4::class)
class IouRestartTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext
  private val phase = InstrumentationRegistry.getArguments().getString("iouRestart")
  private val domains = Domains(ByteArray(32) { 7 }, ByteArray(32) { 0xb0.toByte() })
  private val peer = ByteArray(33) { 0x11 }.also { it[0] = 0x02 }

  private fun body(
    me: ByteArray,
    amount: Long,
  ): ByteArray =
    ByteBuffer.allocate(213).order(ByteOrder.LITTLE_ENDIAN).run {
      put(1.toByte())
        .put(0x30.toByte())
        .put(ByteArray(32) { 0x7a })
        .putInt(7)
        .put(me)
        .put(peer)
        .put(ByteArray(32) { 3 })
      putLong(amount)
        .putInt(0)
        .put(1.toByte())
        .put(ByteArray(32))
        .put(ByteArray(32))
      array()
    }

  @Test
  fun phase1SignsAndLeavesTheGuard() {
    assumeTrue(phase == "1")
    clean()
    DeviceKey(context, ALIAS).use { key ->
      val me = Envelope.compressed(key.create(domains, ByteArray(32)).publicKey)
      key.signIou(domains, body(me, 10))
    }
  }

  @Test
  fun phase2RefusesAnotherBodyInANewProcess() {
    assumeTrue(phase == "2")
    try {
      DeviceKey(context, ALIAS).use { key ->
        val me = Envelope.compressed(checkNotNull(key.get()).publicKey)
        assertThrows(EquivocationException::class.java) { key.signIou(domains, body(me, 11)) }
        key.signIou(domains, body(me, 10))
      }
    } finally {
      clean()
    }
  }

  private fun clean() {
    KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS)
    context.noBackupFilesDir.listFiles { file: File -> file.name.startsWith("$ALIAS.") }?.forEach(File::delete)
  }

  private companion object {
    const val ALIAS = "buckspay-iou-restart"
  }
}
