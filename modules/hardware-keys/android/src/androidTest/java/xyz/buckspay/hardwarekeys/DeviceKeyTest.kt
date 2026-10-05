package xyz.buckspay.hardwarekeys

import android.app.KeyguardManager
import android.database.sqlite.SQLiteDatabase
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.GeneralSecurityException
import java.security.Key
import java.security.KeyFactory
import java.security.KeyStore
import java.security.KeyStoreSpi
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.UnrecoverableKeyException
import java.security.cert.Certificate
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Date
import java.util.Enumeration
import javax.crypto.KeyGenerator

@RunWith(AndroidJUnit4::class)
class DeviceKeyTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context = instrumentation.targetContext
  private val keyguard = context.getSystemService(KeyguardManager::class.java)
  private val key = DeviceKey(context, ALIAS)
  private val domains = Domains(ByteArray(32) { 7 }, ByteArray(32) { 0xb0.toByte() })
  private val challenge = ByteArray(32) { it.toByte() }
  private val slot = ByteArray(32) { 1 }
  private val content = ByteArray(32) { 2 }

  @Before
  @After
  fun deleteKey() {
    key.close()
    keyStore().deleteEntry(ALIAS)
    context.noBackupFilesDir.listFiles { file -> file.name.startsWith("$ALIAS.") }?.forEach(File::delete)
  }

  @Test
  fun createsAnX509KeyThatVerifiesItsSignatures() {
    assertNull(key.get())
    val started = System.nanoTime()
    val record = key.create(domains, challenge)
    Log.i(TAG, "key generation: ${(System.nanoTime() - started) / 1_000_000} ms, ${record.securityLevel.value}")
    assertEquals(91, record.publicKey.size)
    val signature = key.signNote(domains, slot, content)
    assertTrue(verifies(record.publicKey, Envelope.build(domains.of("note"), slot, content), signature))
  }

  @Test
  fun signsAReclaimOnlyOfARecordedOutputOnceItsSettlementWindowIsOver() {
    val record = key.create(domains, challenge)
    val output = ByteArray(32) { 3 }
    val expiry = 1_900_000_000L
    val reclaim = { now: Long, deadline: Long -> key.signReclaim(domains, output, deadline, GRACE, now) }
    assertThrows(UnknownOutputException::class.java) { reclaim(expiry + GRACE + 1, expiry + GRACE + 100) }
    key.recordOutput(domains, output, expiry)
    assertThrows(ReclaimTooEarlyException::class.java) { reclaim(expiry + GRACE, expiry + GRACE + 100) }
    val now = expiry + GRACE + 1
    val signature = reclaim(now, now + 3_600)
    assertTrue(verifies(record.publicKey, Envelope.reclaim(domains.of("reclaim"), output, now + 3_600), signature))
    assertFalse(verifies(record.publicKey, Envelope.reclaim(domains.of("reclaim"), output, now + 3_601), signature))
    assertThrows(InvalidDeadlineException::class.java) { reclaim(now, now + 86_401) }
    assertThrows(InvalidDeadlineException::class.java) { reclaim(now, now - 1) }
    reclaim(now, now + 86_400)
  }

  @Test
  fun signsAReclaimOfAnOutputItSignedASpendOf() {
    val record = key.create(domains, challenge)
    val output = slot
    key.recordOutput(domains, output, 1_000)
    key.signNote(domains, output, content)
    val signature = key.signReclaim(domains, output, 1_000 + GRACE + 10, GRACE, 1_000 + GRACE + 1)
    assertTrue(verifies(record.publicKey, Envelope.reclaim(domains.of("reclaim"), output, 1_000 + GRACE + 10), signature))
  }

  @Test
  fun neverReplacesAnExistingKey() {
    val first = key.create(domains, challenge)
    val second = key.create(domains, ByteArray(16))
    assertArrayEquals(first.publicKey, second.publicKey)
    assertArrayEquals(first.publicKey, key.get()?.publicKey)
    assertEquals(first.attestationChain.size, second.attestationChain.size)
    first.attestationChain.zip(second.attestationChain).forEach { (a, b) -> assertArrayEquals(a, b) }
  }

  @Test
  fun neverReplacesAKeyKeystoreFailsToRead() {
    val publicKey = key.create(domains, challenge).publicKey
    val keyStore = FlakyKeyStore()
    val flaky = DeviceKey(context, ALIAS, keyStore)
    keyStore.failing = true
    assertThrows(KeyUnavailableException::class.java) { flaky.get() }
    assertThrows(KeyUnavailableException::class.java) { flaky.create(domains, challenge) }
    assertThrows(KeyUnavailableException::class.java) { flaky.sign(domains, "witness", slot, content) }
    keyStore.failing = false
    assertArrayEquals(publicKey, flaky.get()?.publicKey)
    assertEquals(0, keyStore.deletes)
  }

  @Test
  fun neverRecreatesAKeyThatDisappeared() {
    key.create(domains, challenge)
    keyStore().deleteEntry(ALIAS)
    assertThrows(KeyUnavailableException::class.java) { key.get() }
    assertThrows(KeyUnavailableException::class.java) { key.create(domains, challenge) }
    assertThrows(KeyUnavailableException::class.java) { key.sign(domains, "witness", slot, content) }
    assertNull(keyStore().getKey(ALIAS, null))
  }

  @Test
  fun fallsBackWhenStrongBoxIsUnavailable() {
    val record = key.create(domains, challenge, strongBox = true)
    Log.i(TAG, "StrongBox available: ${key.isStrongBoxAvailable()}, forced StrongBox gave ${record.securityLevel.value}")
    if (key.isStrongBoxAvailable()) {
      assertEquals(SecurityLevel.STRONGBOX, record.securityLevel)
    } else {
      assertNotEquals(SecurityLevel.STRONGBOX, record.securityLevel)
    }
  }

  @Test
  fun recordsAnAttestationChainForTheChallenge() {
    val chain = key.create(domains, challenge).attestationChain.map(::certificate)
    assertTrue(chain.isNotEmpty())
    val extension = chain.first().getExtensionValue(ATTESTATION_OID)
    assertNotNull(extension)
    assertTrue(extension.asList().windowed(challenge.size).any { it == challenge.asList() })
    Log.i(TAG, "attestation chain: ${chain.size} certificates, root ${chain.last().subjectX500Principal}")
  }

  @Test
  fun generatesWithoutAttestationWhenAttestationFails() {
    key.generate(ByteArray(129), strongBox = false)
    val record = key.create(domains, challenge)
    assertTrue(record.attestationChain.isEmpty())
    val envelope = Envelope.build(domains.of("witness"), slot, content)
    assertTrue(verifies(record.publicKey, envelope, key.sign(domains, "witness", slot, content)))
  }

  @Test
  fun deletesOnlyWhatAFailedAttemptProvablyCreated() {
    val keyStore = FlakyKeyStore().apply { failing = true }
    DeviceKey(context, ALIAS, keyStore).generate(ByteArray(129), strongBox = false)
    assertEquals(0, keyStore.deletes)
    assertTrue(keyStore().getKey(ALIAS, null) is PrivateKey)
  }

  @Test
  fun rejectsChallengesLongerThan128Bytes() {
    assertThrows(InvalidChallengeException::class.java) { key.create(domains, ByteArray(129)) }
    assertNull(key.get())
  }

  @Test
  fun throwsInsteadOfReplacingAnEntryItCannotRead() {
    KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT).build())
      generateKey()
    }
    assertThrows(KeyUnavailableException::class.java) { key.get() }
    assertThrows(KeyUnavailableException::class.java) { key.create(domains, challenge) }
    assertTrue(keyStore().getEntry(ALIAS, null) is KeyStore.SecretKeyEntry)
  }

  @Test
  fun signsOnlyUnderItsOwnPurpose() {
    val publicKey = key.create(domains, challenge).publicKey
    for (purpose in Envelope.SIGNED) {
      val signature = if (purpose == "note") key.signNote(domains, slot, content) else key.sign(domains, purpose, slot, content)
      for (other in Envelope.PURPOSES) {
        val envelope = Envelope.build(domains.of(other), slot, content)
        assertEquals("$purpose over $other", purpose == other, verifies(publicKey, envelope, signature))
      }
    }
  }

  @Test
  fun signsTheBindingOfItsOwnKeyAndNoOtherDeviceMessage() {
    val publicKey = key.create(domains, challenge).publicKey
    val wallet = ByteArray(32) { 9 }
    val binding = Envelope.deviceBinding(domains.of("device"), wallet, compressed(publicKey))
    assertTrue(verifies(publicKey, binding, key.signDeviceBinding(domains, wallet)))
    val other = Envelope.deviceBinding(domains.of("device"), ByteArray(32) { 8 }, compressed(publicKey))
    assertFalse(verifies(publicKey, other, key.signDeviceBinding(domains, wallet)))
    assertThrows(InvalidEnvelopeException::class.java) { key.signDeviceBinding(domains, ByteArray(31)) }
    assertThrows(InvalidEnvelopeException::class.java) { key.sign(domains, "device", wallet, binding.copyOfRange(64, 96)) }
  }

  @Test
  fun rejectsInvalidEnvelopesAndMissingKeys() {
    assertThrows(KeyNotFoundException::class.java) { key.signNote(domains, slot, content) }
    assertThrows(KeyNotFoundException::class.java) { key.sign(domains, "witness", slot, content) }
    key.create(domains, challenge)
    for (purpose in listOf("note", "device", "reclaim", "payword", "iou", "voice", "claim", "ticket", "x")) {
      assertThrows(purpose, InvalidEnvelopeException::class.java) { key.sign(domains, purpose, slot, content) }
    }
    assertThrows(InvalidEnvelopeException::class.java) { key.sign(domains, "witness", ByteArray(31), content) }
    assertThrows(InvalidEnvelopeException::class.java) { key.signNote(domains, slot, ByteArray(33)) }
    assertThrows(InvalidEnvelopeException::class.java) { key.signNote(domains, issue(1, 10, 10), content) }
  }

  @Test
  fun signsANoteSlotWithOneContentOnly() {
    val publicKey = key.create(domains, challenge).publicKey
    key.signNote(domains, slot, content)
    val again = key.signNote(domains, slot, content)
    assertTrue(verifies(publicKey, Envelope.build(domains.of("note"), slot, content), again))
    assertThrows(EquivocationException::class.java) { key.signNote(domains, slot, ByteArray(32) { 3 }) }
    key.sign(domains, "witness", slot, ByteArray(32) { 3 })
  }

  @Test
  fun neverSignsOverlappingIssuesOnOneLock() {
    key.create(domains, challenge)
    key.signNote(domains, issue(4, 0, 100), content)
    assertThrows(OverIssuanceException::class.java) { key.signNote(domains, issue(4, 99, 200), content) }
    key.signNote(domains, issue(4, 100, 200), content)
    key.signNote(domains, issue(5, 0, 100), content)
  }

  @Test
  fun remembersSignedNotesAcrossRestarts() {
    key.create(domains, challenge)
    key.signNote(domains, slot, content)
    key.signNote(domains, issue(4, 0, 100), content)
    key.close()
    DeviceKey(context, ALIAS).use { restarted ->
      restarted.signNote(domains, slot, content)
      assertThrows(EquivocationException::class.java) { restarted.signNote(domains, slot, ByteArray(32) { 3 }) }
      assertThrows(OverIssuanceException::class.java) { restarted.signNote(domains, issue(4, 50, 150), content) }
    }
  }

  @Test
  fun signsNotesOnlyWithTheGuardItsCreationMade() {
    val publicKey = key.create(domains, challenge).publicKey
    key.signNote(domains, slot, content)
    key.close()
    val guard = guardFiles().single()
    assertEquals(guardFile(publicKey), guard)
    assertTrue(guard.delete())
    assertThrows(NoteGuardUnavailableException::class.java) { key.signNote(domains, slot, ByteArray(32) { 3 }) }
    guard.writeBytes(ByteArray(32))
    assertThrows(NoteGuardUnavailableException::class.java) { key.signNote(domains, slot, ByteArray(32) { 3 }) }
    val otherCluster = Domains(ByteArray(32) { 8 }, ByteArray(32) { 0xb0.toByte() })
    assertThrows(NoteGuardUnavailableException::class.java) { key.signNote(otherCluster, slot, content) }
    key.sign(domains, "witness", slot, content)
  }

  @Test
  fun signsOnlyWhileTheDeviceIsUnlocked() {
    withLockScreen { pin ->
      key.create(domains, challenge)
      val privateKey = keyStore().getKey(ALIAS, null) as PrivateKey
      lock()
      assertThrows(DeviceLockedException::class.java) { key.signNote(domains, slot, content) }
      assertThrows(DeviceLockedException::class.java) { key.sign(domains, "witness", slot, content) }
      assertThrows(DeviceLockedException::class.java) { key.signDeviceBinding(domains, slot) }
      if (DeviceKey.UNLOCKED_DEVICE_REQUIRED) {
        val refused = assertThrows(GeneralSecurityException::class.java) { rawSign(privateKey) }
        Log.i(TAG, "Keystore while locked: ${refused.javaClass.name}: ${refused.message}")
      }
      unlock(pin)
      key.signNote(domains, slot, ByteArray(32) { 3 })
      rawSign(privateKey)
    }
  }

  @Test
  fun refusesToSignWhileLockedEvenWhereKeystoreWould() {
    withLockScreen { pin ->
      DeviceKey(context, ALIAS, unlockedDeviceRequired = false).use { unenforced ->
        unenforced.create(domains, challenge)
        val privateKey = keyStore().getKey(ALIAS, null) as PrivateKey
        lock()
        assertThrows(DeviceLockedException::class.java) { unenforced.signNote(domains, slot, content) }
        assertThrows(DeviceLockedException::class.java) { unenforced.sign(domains, "witness", slot, content) }
        assertThrows(DeviceLockedException::class.java) { unenforced.signDeviceBinding(domains, slot) }
        rawSign(privateKey)
        unlock(pin)
        unenforced.signNote(domains, slot, content)
      }
    }
  }

  @Test
  fun keepsTheKeyWhenTheLockScreenIsRemoved() {
    assumeTrue(DeviceKey.UNLOCKED_DEVICE_REQUIRED)
    withLockScreen { pin ->
      val publicKey = key.create(domains, challenge).publicKey
      shell("locksettings clear --old $pin")
      try {
        assertFalse(keyguard.isDeviceSecure)
        assertArrayEquals(publicKey, key.get()?.publicKey)
        key.sign(domains, "witness", slot, content)
        Log.i(TAG, "lock screen removed: the key is kept and signs")
      } finally {
        shell("locksettings set-pin $pin")
      }
    }
  }

  @Test
  fun measuresSigning() {
    val publicKey = key.create(domains, challenge).publicKey
    var highS = 0
    val guarded =
      (0 until SIGNATURES).map { i ->
        val fresh = ByteArray(32) { i.toByte() }
        timed {
          val signature = key.signNote(domains, fresh, content)
          assertTrue(verifies(publicKey, Envelope.build(domains.of("note"), fresh, content), signature))
          if (s(signature) > N.shiftRight(1)) highS++
        }
      }
    val unguarded = (0 until SIGNATURES).map { timed { key.sign(domains, "witness", slot, content) } }
    Log.i(TAG, "signing a new note slot: ${percentiles(guarded)}, high-S $highS/$SIGNATURES; witness: ${percentiles(unguarded)}")
    assertTrue(highS > 0)
  }

  @Test
  fun signsNotesInOneInstanceAtATime() {
    key.create(domains, challenge)
    key.signNote(domains, slot, content)
    DeviceKey(context, ALIAS).use { second ->
      assertThrows(NoteGuardUnavailableException::class.java) { second.signNote(domains, slot, content) }
      assertThrows(NoteGuardUnavailableException::class.java) { second.reset() }
      second.sign(domains, "witness", slot, content)
      key.close()
      assertThrows(EquivocationException::class.java) { second.signNote(domains, slot, ByteArray(32) { 3 }) }
    }
  }

  @Test
  fun neverForgetsASpendHoweverMuchTimePasses() {
    key.create(domains, challenge)
    key.signNote(domains, slot, content)
    key.close()
    withClockAhead(CHALLENGE_MILLIS + 1_000) {
      DeviceKey(context, ALIAS).use { restarted ->
        assertThrows(EquivocationException::class.java) { restarted.signNote(domains, slot, ByteArray(32) { 3 }) }
        restarted.signNote(domains, slot, content)
      }
    }
  }

  @Test
  fun keepsItsRecordsWhenTheClockJumps() {
    key.create(domains, challenge)
    key.signNote(domains, slot, content)
    key.close()
    withClockAhead(YEAR_MILLIS) {
      DeviceKey(context, ALIAS).use { it.signNote(domains, ByteArray(32) { 4 }, content) }
    }
    DeviceKey(context, ALIAS).use { corrected ->
      assertThrows(EquivocationException::class.java) { corrected.signNote(domains, slot, ByteArray(32) { 3 }) }
    }
  }

  @Test
  fun signsOnlyOnceItsCreationFinished() {
    val publicKey = key.create(domains, challenge).publicKey
    key.signNote(domains, slot, content)
    assertTrue(marker().delete())
    for (sign in signers()) assertThrows(KeyUnavailableException::class.java) { sign() }
    assertArrayEquals(publicKey, key.create(domains, challenge).publicKey)
    assertThrows(EquivocationException::class.java) { key.signNote(domains, slot, ByteArray(32) { 3 }) }
    key.sign(domains, "witness", slot, content)
  }

  @Test
  fun finishesAnInterruptedCreationOnlyWithAGuardBoundToItsKey() {
    key.generate(challenge, strongBox = false)
    for (sign in signers()) assertThrows(KeyUnavailableException::class.java) { sign() }
    val guard = guardFile(checkNotNull(key.get()).publicKey)
    NoteGuard.create(guard, ByteArray(32)) {}
    assertThrows(NoteGuardUnavailableException::class.java) { key.create(domains, challenge) }
    assertFalse(marker().exists())
    for (sign in signers()) assertThrows(KeyUnavailableException::class.java) { sign() }
    assertTrue(SQLiteDatabase.deleteDatabase(guard))
    key.create(domains, challenge)
    key.signNote(domains, slot, content)
  }

  @Test
  fun finishesNoCreationWhileAnotherInstanceHoldsTheGuard() {
    key.create(domains, challenge)
    key.signNote(domains, slot, content)
    assertTrue(marker().delete())
    DeviceKey(context, ALIAS).use { other ->
      assertThrows(NoteGuardUnavailableException::class.java) { other.create(domains, challenge) }
    }
    assertFalse(marker().exists())
    key.close()
    key.create(domains, challenge)
    assertThrows(EquivocationException::class.java) { key.signNote(domains, slot, ByteArray(32) { 3 }) }
  }

  @Test
  fun resetsToANewIdentity() {
    val old = key.create(domains, challenge).publicKey
    key.signNote(domains, slot, content)
    key.reset()
    assertNull(key.get())
    assertFalse(marker().exists())
    assertEquals(listOf(guardFile(old)), guardFiles())
    assertTrue(File(context.noBackupFilesDir, "$ALIAS.guard.lock").exists())
    for (sign in signers()) assertThrows(KeyNotFoundException::class.java) { sign() }
    val new = key.create(domains, challenge).publicKey
    assertFalse(new.contentEquals(old))
    key.signNote(domains, slot, ByteArray(32) { 3 })
    assertEquals(setOf(guardFile(old), guardFile(new)), guardFiles().toSet())
  }

  @Test
  fun isSafeWhenAResetStopsAfterKeystore() {
    key.create(domains, challenge)
    key.signNote(domains, slot, content)
    key.close()
    keyStore().deleteEntry(ALIAS)
    assertThrows(KeyUnavailableException::class.java) { key.get() }
    assertThrows(KeyUnavailableException::class.java) { key.create(domains, challenge) }
    for (sign in signers()) assertThrows(KeyUnavailableException::class.java) { sign() }
    key.reset()
    assertNull(key.get())
    assertFalse(marker().exists())
    assertEquals(1, guardFiles().size)
  }

  @Test
  fun isSafeWhenAResetStopsAfterTheMarker() {
    val old = key.create(domains, challenge).publicKey
    key.signNote(domains, slot, content)
    key.close()
    keyStore().deleteEntry(ALIAS)
    assertTrue(marker().delete())
    assertNull(key.get())
    val new = key.create(domains, challenge).publicKey
    key.signNote(domains, slot, ByteArray(32) { 3 })
    assertEquals(setOf(guardFile(old), guardFile(new)), guardFiles().toSet())
    key.reset()
    assertEquals(setOf(guardFile(old), guardFile(new)), guardFiles().toSet())
  }

  @Test
  fun deletesNothingElseUntilKeystoreConfirmsTheKeyIsGone() {
    key.create(domains, challenge)
    key.signNote(domains, slot, content)
    key.close()
    val keyStore = FlakyKeyStore()
    DeviceKey(context, ALIAS, keyStore).use { flaky ->
      keyStore.failing = true
      assertThrows(KeyUnavailableException::class.java) { flaky.reset() }
      assertTrue(marker().exists())
      assertEquals(1, guardFiles().size)
      keyStore.failing = false
      flaky.reset()
    }
    assertNull(key.get())
    assertFalse(marker().exists())
    assertEquals(1, guardFiles().size)
  }

  private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun rawSign(privateKey: PrivateKey) =
    Signature.getInstance("SHA256withECDSA").run {
      initSign(privateKey)
      update(content)
      sign()
    }

  /** Runs `block` with a PIN lock screen, the one given as `-e pin` or a temporary one, and leaves the device unlocked. */
  private fun withLockScreen(block: (String) -> Unit) {
    if (keyguard.isDeviceSecure) {
      val pin = InstrumentationRegistry.getArguments().getString("pin")
      assumeTrue("pass the device PIN with -e pin", pin != null)
      unlocking(checkNotNull(pin), block)
      return
    }
    shell("locksettings set-pin $TEMPORARY_PIN")
    try {
      unlocking(TEMPORARY_PIN, block)
    } finally {
      shell("locksettings clear --old $TEMPORARY_PIN")
    }
  }

  private fun unlocking(
    pin: String,
    block: (String) -> Unit,
  ) {
    try {
      block(pin)
    } finally {
      if (keyguard.isDeviceLocked) unlock(pin)
    }
  }

  private fun lock() {
    shell("input keyevent KEYCODE_SLEEP")
    check(awaitLocked(true)) { "the device did not lock" }
  }

  private fun unlock(pin: String) {
    repeat(5) {
      shell("input keyevent KEYCODE_WAKEUP")
      SystemClock.sleep(500)
      shell("input keyevent KEYCODE_MENU")
      SystemClock.sleep(1_000)
      shell("input text $pin")
      shell("input keyevent KEYCODE_ENTER")
      if (awaitLocked(false, 4_000)) return
    }
    error("the device did not unlock")
  }

  private fun awaitLocked(
    locked: Boolean,
    timeout: Long = 20_000,
  ): Boolean {
    val deadline = SystemClock.uptimeMillis() + timeout
    while (keyguard.isDeviceLocked != locked) {
      if (SystemClock.uptimeMillis() > deadline) return false
      SystemClock.sleep(200)
    }
    return true
  }

  private fun shell(command: String): String =
    ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command)).use {
      it.readBytes().decodeToString()
    }

  private fun timed(block: () -> Unit): Double {
    val started = System.nanoTime()
    block()
    return (System.nanoTime() - started) / 1_000_000.0
  }

  private fun percentiles(millis: List<Double>) = millis.sorted().let { "p50 ${it[it.size / 2]} ms, p95 ${it[it.size * 95 / 100]} ms" }

  private fun verifies(
    spki: ByteArray,
    message: ByteArray,
    der: ByteArray,
  ): Boolean {
    val publicKey: PublicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki))
    return Signature.getInstance("SHA256withECDSA").run {
      initVerify(publicKey)
      update(message)
      verify(der)
    }
  }

  /** SEC1 compressed point of an X.509 key, computed through the platform's key factory. */
  private fun compressed(spki: ByteArray): ByteArray {
    val point = (KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki)) as ECPublicKey).w
    val x = point.affineX.toByteArray()
    val unsigned = x.copyOfRange(maxOf(0, x.size - 32), x.size)
    return byteArrayOf(if (point.affineY.testBit(0)) 0x03 else 0x02) + ByteArray(32 - unsigned.size) + unsigned
  }

  private fun certificate(encoded: ByteArray) =
    CertificateFactory.getInstance("X.509").generateCertificate(encoded.inputStream()) as X509Certificate

  private fun s(der: ByteArray): BigInteger {
    val rLength = der[3].toInt()
    val sLength = der[5 + rLength].toInt()
    return BigInteger(1, der.copyOfRange(6 + rLength, 6 + rLength + sLength))
  }

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  private fun marker() = File(context.noBackupFilesDir, "$ALIAS.key")

  private fun guardFile(publicKey: ByteArray) =
    File(context.noBackupFilesDir, "$ALIAS.${hex(NoteGuard.binding(publicKey, domains.of("note")))}.notes")

  private fun guardFiles() =
    context.noBackupFilesDir
      .listFiles { file -> file.name.startsWith("$ALIAS.") && file.name.endsWith(".notes") }
      .orEmpty()
      .toList()

  private fun signers(): List<() -> Unit> =
    listOf(
      { key.signNote(domains, slot, content) },
      { key.sign(domains, "witness", slot, content) },
      { key.signDeviceBinding(domains, slot) },
    )

  /** Runs `block` with the system clock moved `millis` ahead, then moves it back by as much. */
  private fun withClockAhead(
    millis: Long,
    block: () -> Unit,
  ) {
    val ahead = System.currentTimeMillis() + millis
    shell("cmd alarm set-time $ahead")
    try {
      assumeTrue("the shell cannot set the clock", System.currentTimeMillis() >= ahead)
      Log.i(TAG, "clock moved ${millis / 1000} s ahead")
      block()
    } finally {
      shell("cmd alarm set-time ${System.currentTimeMillis() - millis}")
    }
  }

  private fun issue(
    lockSeq: Int,
    start: Long,
    end: Long,
  ): ByteArray =
    ByteBuffer
      .allocate(32)
      .order(ByteOrder.LITTLE_ENDIAN)
      .put("ISSU".toByteArray(Charsets.US_ASCII))
      .putInt(lockSeq)
      .putLong(start)
      .putLong(end)
      .array()

  /**
   * Android Keystore that, while `failing`, reads as it does on a transient Keystore error:
   * `getKey` throws and the metadata calls report nothing. It counts deletions.
   */
  private class FlakyKeyStore private constructor(
    private val spi: Spi,
  ) : KeyStore(spi, spi.keyStore.provider, spi.keyStore.type) {
    constructor() : this(Spi(KeyStore.getInstance("AndroidKeyStore").apply { load(null) }))

    init {
      load(null)
    }

    var failing by spi::failing
    val deletes get() = spi.deletes

    private class Spi(
      val keyStore: KeyStore,
    ) : KeyStoreSpi() {
      var failing = false
      var deletes = 0

      override fun engineGetKey(
        alias: String,
        password: CharArray?,
      ): Key? {
        if (failing) throw UnrecoverableKeyException("Keystore is busy")
        return keyStore.getKey(alias, password)
      }

      override fun engineGetCertificateChain(alias: String): Array<Certificate>? =
        if (failing) null else keyStore.getCertificateChain(alias)

      override fun engineGetCertificate(alias: String): Certificate? = if (failing) null else keyStore.getCertificate(alias)

      override fun engineGetCreationDate(alias: String): Date? = if (failing) null else keyStore.getCreationDate(alias)

      override fun engineSetKeyEntry(
        alias: String,
        key: Key,
        password: CharArray?,
        chain: Array<out Certificate>?,
      ) = keyStore.setKeyEntry(alias, key, password, chain)

      override fun engineSetKeyEntry(
        alias: String,
        key: ByteArray,
        chain: Array<out Certificate>?,
      ) = keyStore.setKeyEntry(alias, key, chain)

      override fun engineSetCertificateEntry(
        alias: String,
        cert: Certificate,
      ) = keyStore.setCertificateEntry(alias, cert)

      override fun engineDeleteEntry(alias: String) {
        deletes++
        keyStore.deleteEntry(alias)
      }

      override fun engineAliases(): Enumeration<String> = keyStore.aliases()

      override fun engineContainsAlias(alias: String) = !failing && keyStore.containsAlias(alias)

      override fun engineSize() = keyStore.size()

      override fun engineIsKeyEntry(alias: String) = !failing && keyStore.isKeyEntry(alias)

      override fun engineIsCertificateEntry(alias: String) = keyStore.isCertificateEntry(alias)

      override fun engineGetCertificateAlias(cert: Certificate): String? = keyStore.getCertificateAlias(cert)

      override fun engineStore(
        stream: OutputStream?,
        password: CharArray?,
      ) = throw UnsupportedOperationException()

      override fun engineLoad(
        stream: InputStream?,
        password: CharArray?,
      ) = Unit
    }
  }

  private companion object {
    const val GRACE = 604_800L

    const val ALIAS = "buckspay-device-test"
    const val TAG = "DeviceKeyTest"
    const val ATTESTATION_OID = "1.3.6.1.4.1.11129.2.1.17"
    const val SIGNATURES = 50
    const val TEMPORARY_PIN = "1234"
    const val CHALLENGE_MILLIS = 7 * 24 * 3600 * 1000L
    const val YEAR_MILLIS = 365 * 24 * 3600 * 1000L
    val N = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)
  }
}
