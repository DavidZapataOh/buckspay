package xyz.buckspay.mesh

/** The mesh frame kind of a beacon; `FrameKind.Beacon` in `src/features/mesh/frame.ts` is the same value. */
internal const val BEACON_KIND: Byte = 1

/** Seconds a beacon stays on the air before it is advertised again with the state of the moment. */
internal const val BEACON_TTL_SECONDS = 24L * 60 * 60

/**
 * The frame that tells phones nearby this one can reach the internet and where to hand it a payment:
 * `kind 1 ‖ version 1 ‖ flags (bit 0 online) ‖ clusterTag 4 ‖ keyId ‖ psm u16`.
 */
internal fun beaconFrame(
  online: Boolean,
  clusterTag: ByteArray,
  keyId: Int,
  psm: Int,
): ByteArray {
  require(clusterTag.size == 4) { "the cluster tag is four bytes" }
  return byteArrayOf(
    BEACON_KIND,
    1,
    if (online) 1 else 0,
    *clusterTag,
    keyId.toByte(),
    (psm shr 8).toByte(),
    psm.toByte(),
  )
}
