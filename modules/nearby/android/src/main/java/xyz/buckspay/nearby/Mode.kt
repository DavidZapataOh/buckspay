package xyz.buckspay.nearby

internal enum class Topology { PointToPoint, Star }

/** What the radio is used for: the service id keeps the modes apart and the topology picks the Nearby strategy. */
internal enum class Mode(
  val wire: String,
  val serviceId: String,
  val topology: Topology,
) {
  Pay("pay", "xyz.buckspay.pay", Topology.PointToPoint),
  Group("group", "xyz.buckspay.group", Topology.Star),
  GroupSequential("groupSequential", "xyz.buckspay.group", Topology.PointToPoint),
  ;

  companion object {
    /** `null` is Pay, so callers written before group mode keep their behaviour. */
    fun parse(name: String?): Mode =
      if (name == null) Pay else entries.firstOrNull { it.wire == name } ?: throw NearbyException("Unsupported")
  }
}
