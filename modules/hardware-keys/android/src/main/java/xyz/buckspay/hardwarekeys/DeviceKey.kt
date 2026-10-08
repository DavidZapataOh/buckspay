package xyz.buckspay.hardwarekeys

import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.system.Os
import android.system.OsConstants
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.types.Enumerable
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec

enum class SecurityLevel(
  val value: String,
) : Enumerable {
  STRONGBOX("strongbox"),
  TEE("tee"),
  HARDWARE("hardware"),
  SOFTWARE("software"),
  UNKNOWN("unknown"),
}

class KeyRecord(
  @Field val publicKey: ByteArray,
  @Field val securityLevel: SecurityLevel,
  @Field val attestationChain: List<ByteArray>,
) : Record

internal class KeyNotFoundException : CodedException("The device key does not exist")

internal class KeyUnavailableException(
  cause: Throwable? = null,
) : CodedException("The device key cannot be read", cause)

internal class DeviceLockedException(
  cause: Throwable? = null,
) : CodedException("The device key is usable only while the device is unlocked", cause)

internal class IouSignerException : CodedException("This device key is not a party to this body")

internal class InvalidEnvelopeException(
  cause: Throwable,
) : CodedException("Invalid signing envelope", cause)

internal class UnknownOutputException : CodedException("The note guard has no record of this output")

internal class ReclaimTooEarlyException : CodedException("The output can still be settled by its payee")

internal class InvalidDeadlineException : CodedException("The deadline is past or more than a day ahead")

internal class InvalidChallengeException : CodedException("The attestation challenge is longer than 128 bytes")

/**
 * The device's P-256 signing key in Android Keystore, created once and never exported. Clearing
 * the app's storage, uninstalling or a factory reset deletes the key.
 *
 * Creating the key writes a marker with the hash of its public key to `noBackupFilesDir`, last; the
 * key signs only while the marker matches it, and while the marker exists the key is never
 * generated again, so a key Keystore fails to read, even transiently, is reported unavailable
 * instead of being replaced. Notes are signed through the note guard, which one process at a time
 * holds, from its first note signature until it exits.
 */
internal class DeviceKey(
  private val context: Context,
  private val alias: String = ALIAS,
  private val keyStore: KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) },
  private val unlockedDeviceRequired: Boolean = UNLOCKED_DEVICE_REQUIRED,
) : Closeable {
  private class Entry(
    val privateKey: PrivateKey,
    val chain: List<X509Certificate>,
  ) {
    val publicKey: ByteArray get() = chain.first().publicKey.encoded
  }

  private val keyguard = context.getSystemService(KeyguardManager::class.java)
  private val directory = context.noBackupFilesDir
  private val marker = File(directory, "$alias.key")
  private val guardLock = File(directory, "$alias.guard.lock")
  private var lock: GuardLock? = null
  private var guard: Pair<ByteArray, NoteGuard>? = null

  fun isStrongBoxAvailable(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

  /**
   * Creates the key and its note guard for `domains` if the key does not exist. An existing key is
   * returned unchanged, with the attestation chain of its creation; the challenge of a later call
   * is ignored.
   */
  fun create(
    domains: Domains,
    challenge: ByteArray,
    strongBox: Boolean = isStrongBoxAvailable(),
  ): KeyRecord {
    if (challenge.size > MAX_CHALLENGE) throw InvalidChallengeException()
    return exclusively {
      val entry =
        entry() ?: run {
          generate(challenge, strongBox)
          read() ?: throw KeyUnavailableException()
        }
      if (!marker.exists()) {
        // Also finishes a creation that stopped before the marker: an existing guard is kept only
        // if it is bound to this key. This instance's own open guard would hold the database.
        closeGuard()
        val binding = NoteGuard.binding(entry.publicKey, domains.of(NOTE))
        NoteGuard.create(guardFile(binding), binding, ::syncDirectory)
        writeDurably(marker, sha256(entry.publicKey))
      }
      record(entry)
    }
  }

  /**
   * The key, or null if it was never created. A key that Keystore cannot read, or that the marker
   * says was created and Keystore no longer has, throws.
   */
  fun get(): KeyRecord? = entry()?.let(::record)

  /** DER `SHA256withECDSA` signature over `DOMAIN(note) ‖ slot ‖ content`, admitted first by the note guard. */
  fun signNote(
    domains: Domains,
    slot: ByteArray,
    content: ByteArray,
  ): ByteArray {
    val envelope = envelope(domains, NOTE, slot, content)
    val entry = signingEntry()
    if (keyguard.isDeviceLocked) throw DeviceLockedException()
    val guard = guard(NoteGuard.binding(entry.publicKey, domains.of(NOTE)))
    return try {
      guard.admit(slot, content) { signature(entry.privateKey, envelope) }
    } catch (e: IllegalArgumentException) {
      throw InvalidEnvelopeException(e)
    }
  }

  /**
   * DER `SHA256withECDSA` signature over `DOMAIN(iou) ‖ slot ‖ SHA-256(body)` for a tab state or a
   * netting join that names this key, admitted first by the IOU guard: one body per slot, for good.
   */
  fun signIou(
    domains: Domains,
    body: ByteArray,
  ): ByteArray {
    val (slot, signers) =
      try {
        Envelope.iouSlot(body) to Envelope.iouSigners(body)
      } catch (e: IllegalArgumentException) {
        throw InvalidEnvelopeException(e)
      }
    val entry = signingEntry()
    if (signers.none { it.contentEquals(Envelope.compressed(entry.publicKey)) }) throw IouSignerException()
    if (keyguard.isDeviceLocked) throw DeviceLockedException()
    val content = sha256(body)
    val envelope = envelope(domains, IOU, slot, content)
    val guard = guard(NoteGuard.binding(entry.publicKey, domains.of(NOTE)))
    return guard.ious.admit(slot, content) { signature(entry.privateKey, envelope) }
  }

  /** DER `SHA256withECDSA` signature over `DOMAIN(purpose) ‖ slot ‖ content` for `witness` and `payword`. */
  fun sign(
    domains: Domains,
    purpose: String,
    slot: ByteArray,
    content: ByteArray,
  ): ByteArray {
    if (purpose == NOTE || purpose == IOU) {
      throw InvalidEnvelopeException(IllegalArgumentException("note and iou envelopes are signed with their own guarded functions"))
    }
    val envelope = envelope(domains, purpose, slot, content)
    val entry = signingEntry()
    if (keyguard.isDeviceLocked) throw DeviceLockedException()
    return signature(entry.privateKey, envelope)
  }

  /** Tells the note guard about an output this device holds, which a reclaim of it needs. */
  fun recordOutput(
    domains: Domains,
    output: ByteArray,
    expiry: Long,
  ) {
    val entry = signingEntry()
    val guard = guard(NoteGuard.binding(entry.publicKey, domains.of(NOTE)))
    try {
      guard.recordOutput(output, expiry)
    } catch (e: IllegalArgumentException) {
      throw InvalidEnvelopeException(e)
    }
  }

  /**
   * DER `SHA256withECDSA` signature over the reclaim of `output`, a message built here. Signed only
   * for an output the guard was told about, only once `expiry + grace` of it has passed, with a
   * deadline between `now` and a day ahead: the payee's window is over, and the signature is useful
   * for a short time only. It is signed even if the device signed a spend of the output.
   */
  fun signReclaim(
    domains: Domains,
    output: ByteArray,
    deadline: Long,
    grace: Long,
    now: Long,
  ): ByteArray {
    val entry = signingEntry()
    if (keyguard.isDeviceLocked) throw DeviceLockedException()
    val guard = guard(NoteGuard.binding(entry.publicKey, domains.of(NOTE)))
    val expiry =
      try {
        guard.expiryOf(output)
      } catch (e: IllegalArgumentException) {
        throw InvalidEnvelopeException(e)
      } ?: throw UnknownOutputException()
    if (now <= expiry + grace) throw ReclaimTooEarlyException()
    if (deadline < now || deadline > now + DAY) throw InvalidDeadlineException()
    val message =
      try {
        Envelope.reclaim(domains.of(RECLAIM), output, deadline)
      } catch (e: IllegalArgumentException) {
        throw InvalidEnvelopeException(e)
      }
    return signature(entry.privateKey, message)
  }

  /**
   * DER `SHA256withECDSA` signature over this key's consent to being bound to `wallet`, a message
   * built here from the key itself: `DOMAIN(device) ‖ wallet ‖ SHA-256(ver ‖ 0x50 ‖ wallet ‖ key)`.
   */
  fun signDeviceBinding(
    domains: Domains,
    wallet: ByteArray,
  ): ByteArray {
    if (wallet.size != 32) throw InvalidEnvelopeException(IllegalArgumentException("a wallet is 32 bytes"))
    val entry = signingEntry()
    if (keyguard.isDeviceLocked) throw DeviceLockedException()
    val binding = Envelope.deviceBinding(domains.of(DEVICE), wallet, Envelope.compressed(entry.publicKey))
    return signature(entry.privateKey, binding)
  }

  /**
   * Deletes the key and then its marker, so that the next `create` makes a new identity; notes the
   * key received and did not settle are lost with it. Keystore must report the key gone before the
   * marker is deleted, so stopping in between is safe and resetting again finishes. The note guards
   * and the lock files are kept: a guard is named after its binding, so a new key never opens an old
   * one, and a key Keystore brought back would find its guard with every slot it signed.
   */
  fun reset() {
    lock()
    exclusively {
      closeGuard()
      readKey {
        keyStore.deleteEntry(alias)
        if (keyStore.getKey(alias, null) != null) throw KeyUnavailableException()
      }
      if (marker.exists() && !marker.delete()) throw IOException("cannot delete $marker")
      syncDirectory(directory)
    }
  }

  override fun close() {
    closeGuard()
    lock?.close()
    lock = null
  }

  internal fun generate(
    challenge: ByteArray,
    strongBox: Boolean,
  ) {
    val attempts = listOf(true, false).filter { strongBox || !it }.flatMap { listOf(it to challenge, it to null) }
    var failure: Exception? = null
    for ((inStrongBox, attestationChallenge) in attempts) {
      try {
        generate(inStrongBox, attestationChallenge)
        return
      } catch (e: GeneralSecurityException) {
        failure = e
      } catch (e: ProviderException) {
        failure = e
      }
      // Generation runs only while the alias holds no key, so an entry Keystore can read now was
      // left by this failed attempt.
      if (createdByFailedAttempt()) keyStore.deleteEntry(alias)
    }
    throw checkNotNull(failure)
  }

  private fun createdByFailedAttempt(): Boolean =
    try {
      keyStore.getKey(alias, null) != null
    } catch (e: GeneralSecurityException) {
      false
    } catch (e: ProviderException) {
      false
    }

  private fun generate(
    strongBox: Boolean,
    challenge: ByteArray?,
  ) {
    val spec =
      KeyGenParameterSpec
        .Builder(alias, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setAttestationChallenge(challenge)
        .apply {
          if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true)
          if (unlockedDeviceRequired) setUnlockedDeviceRequired(true)
        }.build()
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).run {
      initialize(spec)
      generateKeyPair()
    }
  }

  /** The entry as Keystore reports it: null only when the alias does not exist. */
  private fun read(): Entry? =
    readKey {
      val privateKey = keyStore.getKey(alias, null) ?: return null
      if (privateKey !is PrivateKey) throw KeyUnavailableException()
      val chain = keyStore.getCertificateChain(alias)?.map { it as X509Certificate } ?: throw KeyUnavailableException()
      Entry(privateKey, chain)
    }

  /** The entry checked against the marker, as `get` describes. */
  private fun entry(): Entry? {
    val entry = read()
    val created = if (marker.exists()) marker.readBytes() else null
    if (entry == null) {
      if (created != null) throw KeyUnavailableException()
      return null
    }
    if (created != null && !created.contentEquals(sha256(entry.publicKey))) throw KeyUnavailableException()
    return entry
  }

  /** The entry to sign with: its creation finished, so the marker holds the hash of its public key. */
  private fun signingEntry(): Entry {
    val entry = entry() ?: throw KeyNotFoundException()
    if (!marker.exists()) throw KeyUnavailableException()
    return entry
  }

  private fun record(entry: Entry): KeyRecord {
    val attested = entry.chain.first().getExtensionValue(ATTESTATION_OID) != null
    return KeyRecord(
      publicKey = entry.publicKey,
      securityLevel = securityLevel(entry.privateKey),
      attestationChain = if (attested) entry.chain.map { it.encoded } else emptyList(),
    )
  }

  private fun envelope(
    domains: Domains,
    purpose: String,
    slot: ByteArray,
    content: ByteArray,
  ): ByteArray =
    try {
      require(purpose in Envelope.SIGNED) { "purpose not signed by this device" }
      Envelope.build(domains.of(purpose), slot, content)
    } catch (e: IllegalArgumentException) {
      throw InvalidEnvelopeException(e)
    }

  private fun signature(
    privateKey: PrivateKey,
    envelope: ByteArray,
  ): ByteArray =
    try {
      Signature.getInstance("SHA256withECDSA").run {
        initSign(privateKey)
        update(envelope)
        sign()
      }
    } catch (e: GeneralSecurityException) {
      if (keyguard.isDeviceLocked) throw DeviceLockedException(e)
      throw e
    }

  /** The note guard bound to `binding`, which the key's creation made, opened under this process's guard lock. */
  private fun guard(binding: ByteArray): NoteGuard {
    guard?.let { (bound, open) -> if (bound.contentEquals(binding)) return open }
    closeGuard()
    val open = NoteGuard.open(guardFile(binding), binding, lock())
    guard = binding to open
    return open
  }

  private fun closeGuard() {
    guard?.second?.close()
    guard = null
  }

  /** The guard lock, taken once and held until this key is closed; the module never closes it. */
  private fun lock(): GuardLock = lock ?: GuardLock.acquire(guardLock).also { lock = it }

  private fun guardFile(binding: ByteArray) = File(directory, "$alias.${hex(binding)}.notes")

  private fun securityLevel(privateKey: PrivateKey): SecurityLevel {
    val info = KeyFactory.getInstance(privateKey.algorithm, PROVIDER).getKeySpec(privateKey, KeyInfo::class.java)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      @Suppress("DEPRECATION")
      return if (info.isInsideSecureHardware) SecurityLevel.HARDWARE else SecurityLevel.SOFTWARE
    }
    return when (info.securityLevel) {
      KeyProperties.SECURITY_LEVEL_STRONGBOX -> SecurityLevel.STRONGBOX
      KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> SecurityLevel.TEE
      KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE -> SecurityLevel.HARDWARE
      KeyProperties.SECURITY_LEVEL_SOFTWARE -> SecurityLevel.SOFTWARE
      KeyProperties.SECURITY_LEVEL_UNKNOWN -> SecurityLevel.UNKNOWN
      else -> SecurityLevel.UNKNOWN
    }
  }

  private inline fun <T> readKey(read: () -> T): T =
    try {
      read()
    } catch (e: GeneralSecurityException) {
      throw KeyUnavailableException(e)
    } catch (e: ProviderException) {
      throw KeyUnavailableException(e)
    }

  /** Runs `block` holding a file lock, so no other thread or process creates the key meanwhile. */
  private inline fun <T> exclusively(block: () -> T): T =
    RandomAccessFile(File(directory, "$alias.lock"), "rw").use { file ->
      val lock = file.channel.lock()
      try {
        block()
      } finally {
        lock.release()
      }
    }

  companion object {
    const val ALIAS = "buckspay-device"
    private const val NOTE = "note"
    private const val IOU = "iou"
    private const val DEVICE = "device"
    private const val RECLAIM = "reclaim"
    private const val DAY = 24 * 60 * 60L
    private const val PROVIDER = "AndroidKeyStore"
    private const val MAX_CHALLENGE = 128
    private const val ATTESTATION_OID = "1.3.6.1.4.1.11129.2.1.17"

    // Android 12 to 14 cannot use such a key without a secure lock screen and delete it when the
    // lock screen is removed; Android 15 fixed both.
    val UNLOCKED_DEVICE_REQUIRED = Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    private fun syncDirectory(directory: File) {
      val fd = Os.open(directory.path, OsConstants.O_RDONLY, 0)
      try {
        Os.fsync(fd)
      } finally {
        Os.close(fd)
      }
    }

    /** Replaces `file` with `bytes` atomically, and syncs the file and its directory. */
    private fun writeDurably(
      file: File,
      bytes: ByteArray,
    ) {
      val temporary = File(file.parentFile, "${file.name}.tmp")
      RandomAccessFile(temporary, "rw").use {
        it.setLength(0)
        it.write(bytes)
        it.fd.sync()
      }
      if (!temporary.renameTo(file)) throw IOException("cannot replace $file")
      syncDirectory(requireNotNull(file.parentFile))
    }
  }
}
