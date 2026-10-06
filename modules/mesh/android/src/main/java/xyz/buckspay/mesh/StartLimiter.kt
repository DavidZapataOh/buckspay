package xyz.buckspay.mesh

/** Android silently refuses the sixth scan start inside 30 seconds, so starts are counted and delayed here. */
internal class StartLimiter(
  private val maxStarts: Int,
  private val windowMs: Long,
  private val clock: () -> Long,
) {
  private val starts = ArrayDeque<Long>()

  @Synchronized
  fun tryStart(): Boolean {
    prune()
    if (starts.size >= maxStarts) return false
    starts.addLast(clock())
    return true
  }

  @Synchronized
  fun msUntilNextStart(): Long {
    prune()
    return if (starts.size < maxStarts) 0L else starts.first() + windowMs - clock() + 1
  }

  @Synchronized
  fun recentStarts(): Int {
    prune()
    return starts.size
  }

  private fun prune() {
    val now = clock()
    while (starts.isNotEmpty() && now - starts.first() > windowMs) starts.removeFirst()
  }
}
