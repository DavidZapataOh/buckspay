package xyz.buckspay.nfc

import android.app.Activity
import android.content.ComponentName
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.cardemulation.CardEmulation
import android.nfc.tech.IsoDep
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

private const val LINK_TIMEOUT_MS = 1500
private const val POLL_LINK_MS = 50L
private const val PROGRESS_INTERVAL_MS = 200L
private const val STATS_KEPT = 100

/** A failure JavaScript maps to `NfcNativeError`; the code is one of its `NfcErrorCode` values. */
internal class NfcException(
  code: String,
) : CodedException(code, code, null)

private fun failure(error: Throwable): NfcException =
  when (error) {
    is NfcException -> error
    is Cancelled -> NfcException("Cancelled")
    is Interrupted -> NfcException("Interrupted")
    is Malformed -> NfcException("Malformed")
    else -> NfcException("Unavailable")
  }

private class Op(
  val promise: Promise,
) {
  val cancelled = AtomicBoolean(false)
  val finished = AtomicBoolean(false)
}

/** One phone's NFC state: a card, a reader and the operations pending on them. */
internal class NfcSide(
  val card: CardEndpoint,
  links: LinkSource,
  private val emit: (Map<String, Any?>) -> Unit,
  private val linkMs: () -> Long? = { null },
  private val onChange: () -> Unit = {},
) {
  @Volatile
  var role: String? = null
    private set

  val pending = AtomicInteger()
  private val driver = ReaderDriver(links)
  private val worker = Executors.newSingleThreadExecutor { Thread(it, "nfc-reader").apply { isDaemon = true } }
  private val consumed = mutableListOf<ByteArray>()
  private val ops = ConcurrentHashMap<Int, Pair<Op, () -> Unit>>()
  private val readerOp = AtomicReference<Op?>()
  private var lastProgress = 0L

  fun acquire(role: String) {
    synchronized(this) {
      if (this.role != null) throw NfcException("Busy")
      if (role != "card" && role != "reader") throw NfcException("Unavailable")
      this.role = role
    }
  }

  fun release() {
    ops.keys.forEach(::cancel)
    card.withdraw()
    card.closeReceive()
    synchronized(this) { role = null }
    onChange()
  }

  fun cancel(opId: Int) {
    val (op, undo) = ops[opId] ?: return
    op.cancelled.set(true)
    undo()
    settle(opId, op) { reject(NfcException("Cancelled")) }
  }

  fun offer(
    opId: Int,
    kind: Int,
    payload: ByteArray,
    promise: Promise,
  ) {
    requireRole("card")
    val sent = card.offer(kind, payload)
    val op = register(opId, promise) { card.withdraw(sent) }
    sent.whenComplete { _, error -> settle(opId, op) { if (error == null) resolve(null) else reject(NfcException("Cancelled")) } }
  }

  fun push(
    opId: Int,
    kind: Int,
    payload: ByteArray,
    promise: Promise,
  ) {
    requireRole("reader")
    runReader(opId, promise) { op ->
      driver.send(kind, payload, op.cancelled::get) { done, total -> progress(opId, "out", kind, done, total) }
      null
    }
  }

  fun receive(
    opId: Int,
    acceptMask: Int,
    promise: Promise,
  ) {
    val current = role ?: throw NfcException("Unavailable")
    if (current == "reader") {
      runReader(opId, promise) { op ->
        val received = driver.receive(acceptMask, consumed, op.cancelled::get) { done, total -> progress(opId, "in", -1, done, total) }
        NfcMessage().apply {
          kind = received.kind
          payload = received.payload
        }
      }
      return
    }
    val op = register(opId, promise) { card.closeReceive() }
    try {
      card.openReceive(acceptMask) { kind, payload ->
        card.closeReceive()
        settle(opId, op) {
          resolve(
            NfcMessage().apply {
              this.kind = kind
              this.payload = payload
            },
          )
        }
      }
    } catch (_: BusyException) {
      settle(opId, op) { reject(NfcException("Busy")) }
    }
  }

  private fun requireRole(expected: String) {
    if (role != expected) throw NfcException("Unavailable")
  }

  private fun runReader(
    opId: Int,
    promise: Promise,
    work: (Op) -> Any?,
  ) {
    if (readerOp.get()?.finished?.get() == false) throw NfcException("Busy")
    val op = register(opId, promise) {}
    readerOp.set(op)
    worker.execute {
      try {
        val result = work(op)
        settle(opId, op) { resolve(result) }
      } catch (error: Throwable) {
        settle(opId, op) { reject(failure(error)) }
      }
    }
  }

  private fun register(
    opId: Int,
    promise: Promise,
    undo: () -> Unit,
  ): Op {
    val op = Op(promise)
    ops[opId] = op to undo
    pending.incrementAndGet()
    onChange()
    return op
  }

  private fun settle(
    opId: Int,
    op: Op,
    outcome: Promise.() -> Unit,
  ) {
    if (!op.finished.compareAndSet(false, true)) return
    ops.remove(opId)
    pending.decrementAndGet()
    onChange()
    op.promise.outcome()
  }

  private fun progress(
    opId: Int,
    direction: String,
    kind: Int,
    done: Int,
    total: Int,
  ) {
    val now = System.nanoTime() / 1_000_000
    if (done < total && now - lastProgress < PROGRESS_INTERVAL_MS) return
    lastProgress = now
    emit(mapOf("opId" to opId, "direction" to direction, "kind" to kind, "done" to done, "total" to total, "linkMs" to linkMs()))
  }
}

/** Reads the other phone through `IsoDep`; one link per contact, kept while the phones touch. */
internal class IsoDepLinks : LinkSource {
  private class Contact(
    val iso: IsoDep,
  ) {
    val startedAt = System.nanoTime()
    val rtts = mutableListOf<Long>()
    var result = "open"
  }

  private val queue = LinkedBlockingQueue<Contact>()
  private val order = LinkedBlockingQueue<Contact>()

  @Volatile private var current: Contact? = null

  /** Called on a binder thread by reader mode: opens the contact and queues it. */
  fun discovered(tag: Tag) {
    val iso = IsoDep.get(tag) ?: return
    try {
      iso.connect()
      iso.timeout = LINK_TIMEOUT_MS
    } catch (_: IOException) {
      runCatching { iso.close() }
      return
    }
    queue.put(Contact(iso))
  }

  override fun awaitLink(cancelled: () -> Boolean): ApduLink? {
    while (!cancelled()) {
      val reusable = current?.takeIf { it.iso.isConnected }
      if (reusable != null) return link(reusable)
      val next = queue.poll(POLL_LINK_MS, TimeUnit.MILLISECONDS) ?: continue
      if (!next.iso.isConnected) {
        runCatching { next.iso.close() }
        continue
      }
      current = next
      order.put(next)
      while (order.size > STATS_KEPT) order.poll()
      return link(next)
    }
    return null
  }

  fun ageMs(): Long? = current?.let { (System.nanoTime() - it.startedAt) / 1_000_000 }

  /** Lengths and times of the last links; never payload. */
  fun stats(): List<Map<String, Any?>> =
    order.toList().map { contact ->
      val sorted = contact.rtts.sorted()

      fun at(q: Double) = sorted.getOrNull(((sorted.size - 1) * q).toInt()) ?: 0L
      mapOf(
        "commands" to sorted.size,
        "rttMsP50" to at(0.5),
        "rttMsP95" to at(0.95),
        "rttMsMax" to (sorted.lastOrNull() ?: 0L),
        "result" to contact.result,
      )
    }

  private fun link(contact: Contact) =
    ApduLink { command ->
      val started = System.nanoTime()
      try {
        contact.iso.transceive(command).also { contact.rtts.add((System.nanoTime() - started) / 1_000_000) }
      } catch (_: IOException) {
        end(contact)
        throw LinkLost()
      } catch (_: SecurityException) {
        end(contact)
        throw LinkLost()
      }
    }

  private fun end(contact: Contact) {
    contact.result = "lost"
    if (current === contact) current = null
    runCatching { contact.iso.close() }
  }
}

/** Process-wide state: the hardware side, the foreground rules and the in-memory pair used to test the bridge. */
internal object NfcRuntime {
  @Volatile var progressListener: ((Map<String, Any?>) -> Unit)? = null

  private val links = IsoDepLinks()
  private val emit: (Map<String, Any?>) -> Unit = { progressListener?.invoke(it) }
  val hardware = NfcSide(CardEndpoint(), links, emit, links::ageMs, ::refresh)

  private val loopback: List<NfcSide> by lazy {
    val cards = List(2) { CardEndpoint().also { card -> card.active = true } }
    List(2) { i -> NfcSide(cards[i], { ApduLink { command -> cards[1 - i].handle(command) } }, emit) }
  }

  @Volatile private var activity: Activity? = null
  private var applied: Activity? = null
  private var preferred = false
  private var readerOn = false

  fun side(instance: Int): NfcSide =
    when (instance) {
      0 -> hardware
      1, 2 -> loopback[instance - 1]
      else -> throw NfcException("Unavailable")
    }

  fun stats() = links.stats()

  fun resume(host: Activity?) {
    activity = host
    refresh()
  }

  fun pause() = update(foreground = false)

  fun release() {
    hardware.release()
    pause()
  }

  private fun refresh() = update(foreground = true)

  private fun update(foreground: Boolean) {
    val host = (if (foreground) activity else null) ?: applied ?: return
    host.runOnUiThread { apply(if (foreground) activity else null) }
  }

  @Synchronized
  private fun apply(target: Activity?) {
    val busy = hardware.pending.get() > 0
    val wantCard = target != null && busy && hardware.role == "card"
    val wantReader = target != null && busy && hardware.role == "reader"
    hardware.card.active = wantCard
    val old = applied
    val adapter = old?.let { NfcAdapter.getDefaultAdapter(it) } ?: target?.let { NfcAdapter.getDefaultAdapter(it) } ?: return
    if (preferred && !wantCard && old != null) {
      CardEmulation.getInstance(adapter).unsetPreferredService(old)
      preferred = false
    }
    if (readerOn && !wantReader && old != null) {
      adapter.disableReaderMode(old)
      readerOn = false
    }
    if (!preferred && !readerOn) applied = null
    if (target == null) return
    if (wantCard && !preferred) {
      CardEmulation.getInstance(adapter).setPreferredService(target, ComponentName(target, BuckspayApduService::class.java))
      preferred = true
      applied = target
    }
    if (wantReader && !readerOn) {
      val flags = NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS
      adapter.enableReaderMode(target, links::discovered, flags, null)
      readerOn = true
      applied = target
    }
  }
}
