// Slack's conversations.info is a Tier 3 method (about 50 calls a minute per app), shared by every member serving the app,
// and one turn asks it about the same channel many times. What it says changes rarely, so one answer serves a channel for a
// while: concurrent asks share the request in flight, and a failed one is never kept.

export class ChannelInfoCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>()
  private hits = 0
  private misses = 0

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 2000
  ) {}

  get(key: string, fetch: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key)
    if (hit && this.now() - hit.at < this.ttlMs) {
      this.hits += 1
      return hit.value
    }
    this.misses += 1
    const value = fetch()
    this.entries.delete(key)
    if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!)
    this.entries.set(key, { at: this.now(), value })
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key)
    })
    return value
  }

  forget(key: string): void {
    this.entries.delete(key)
  }

  /** What was answered since the last call, from the cache and from Slack, and starts counting again. */
  takeCounts(): { hits: number; misses: number } {
    const counts = { hits: this.hits, misses: this.misses }
    this.hits = 0
    this.misses = 0
    return counts
  }
}
