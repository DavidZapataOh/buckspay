const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? '' : 's'}`

/** A length of time in words: "1 hour", "1 hour 30 minutes", "10 minutes", "45 seconds". */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return minutes > 0 ? `${unit(hours, 'hour')} ${unit(minutes, 'minute')}` : unit(hours, 'hour')
  return minutes > 0 ? unit(minutes, 'minute') : unit(seconds, 'second')
}

/** Time left as `m:ss`. */
export function formatCountdown(seconds: number): string {
  const left = Math.max(0, seconds)
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}
