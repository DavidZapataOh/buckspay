package xyz.buckspay.mesh

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.util.Log
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger

private const val TAG = "MeshL2cap"
private const val CONNECT_TIMEOUT_MS = 5_000L

/** Reads exactly `length` bytes; throws when the stream ends first. */
internal fun readExactly(
  input: InputStream,
  length: Int,
): ByteArray {
  val out = ByteArray(length)
  var read = 0
  while (read < length) {
    val n = input.read(out, read, length - read)
    if (n < 0) throw IOException("closed")
    read += n
  }
  return out
}

/**
 * Insecure L2CAP channels (no pairing): one server this phone is reached on, whose PSM the beacon carries, and the
 * channels opened to or from other phones, held by id for JavaScript to read and write. Bytes only: the hop wrapper
 * and the relay protocol run in JavaScript.
 */
internal class L2capHub(
  private val adapter: BluetoothAdapter,
  private val io: ExecutorService,
  private val onInbound: (Int, String) -> Unit,
) {
  private val channels = ConcurrentHashMap<Int, BluetoothSocket>()
  private val ids = AtomicInteger()

  @Volatile private var server: BluetoothServerSocket? = null

  /** The PSM of the open server, or 0 when none is. */
  val psm: Int get() = server?.psm ?: 0

  /** Closes the server and opens a new one on a new dynamic PSM; returns it. Open channels stay open. */
  @Synchronized
  fun listen(): Int {
    server?.close()
    val fresh = adapter.listenUsingInsecureL2capChannel()
    server = fresh
    io.execute { accept(fresh) }
    return fresh.psm
  }

  @Synchronized
  fun stop() {
    server?.close()
    server = null
    channels.values.forEach { it.close() }
    channels.clear()
  }

  private fun accept(listening: BluetoothServerSocket) {
    while (true) {
      val socket =
        try {
          listening.accept()
        } catch (error: IOException) {
          return
        }
      val id = register(socket)
      onInbound(id, socket.remoteDevice.address)
    }
  }

  private fun register(socket: BluetoothSocket): Int = ids.incrementAndGet().also { channels[it] = socket }

  /** Connects to the phone at `address` on `psm`; the call blocks until it is connected or `CONNECT_TIMEOUT_MS` passed. */
  fun connect(
    address: String,
    psm: Int,
  ): Int {
    adapter.cancelDiscovery()
    val socket = adapter.getRemoteDevice(address).createInsecureL2capChannel(psm)
    val connecting = io.submit { socket.connect() }
    try {
      connecting.get(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    } catch (error: Exception) {
      socket.close()
      Log.w(TAG, "connect failed", error)
      throw MeshException(if (error is TimeoutException) "timeout" else "connect-failed")
    }
    return register(socket)
  }

  private fun socket(id: Int): BluetoothSocket = channels[id] ?: throw MeshException("closed")

  /** Exactly `length` bytes, or a `timeout` (which closes the channel) or `closed` failure. */
  fun read(
    id: Int,
    length: Int,
    timeoutMs: Long,
  ): ByteArray {
    val socket = socket(id)
    val reading = io.submit<ByteArray> { readExactly(socket.inputStream, length) }
    try {
      return reading.get(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (error: TimeoutException) {
      close(id)
      throw MeshException("timeout")
    } catch (error: Exception) {
      close(id)
      throw MeshException("closed")
    }
  }

  fun write(
    id: Int,
    bytes: ByteArray,
  ) {
    try {
      socket(id).outputStream.apply {
        write(bytes)
        flush()
      }
    } catch (error: IOException) {
      close(id)
      throw MeshException("closed")
    }
  }

  fun close(id: Int) {
    channels.remove(id)?.close()
  }
}
