package xyz.buckspay.nearby

internal fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

internal fun String.hexToBytes(): ByteArray {
  require(length % 2 == 0) { "odd length" }
  return ByteArray(length / 2) { substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
