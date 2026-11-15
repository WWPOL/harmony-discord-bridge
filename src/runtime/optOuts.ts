/**
 * Discord users of the bridged server who are opted out of the bridge: by themselves, or
 * removed by a server manager or instance admin. Nothing of theirs is sent to Harmony.
 * `onChange` runs whenever the set of users changes, by any path.
 */
export class OptOutList {
  private ids = new Set<string>()
  private loadedVersion: string | null = null
  private seq = 0
  /** Local add/remove calls made while a read was in flight, by `seq`; empty when none is. */
  private edits: Array<{ seq: number; id: string; present: boolean }> = []
  private readsInFlight = 0

  constructor(private readonly onChange: () => void = () => {}) {}

  /** The `privacy_version` the list was read at; null before the first read. */
  version(): string | null {
    return this.loadedVersion
  }

  has(discordUserId: string): boolean {
    return this.ids.has(discordUserId)
  }

  /** Records one user ahead of the next read, e.g. after a 403 BRIDGE_AUTHOR_OPTED_OUT. */
  add(discordUserId: string): void {
    this.note(discordUserId, true)
    if (this.ids.has(discordUserId)) return
    this.ids.add(discordUserId)
    this.onChange()
  }

  remove(discordUserId: string): void {
    this.note(discordUserId, false)
    if (this.ids.delete(discordUserId)) this.onChange()
  }

  replace(version: string | null, discordUserIds: Iterable<string>): void {
    const next = new Set(discordUserIds)
    const changed = next.size !== this.ids.size || [...next].some(id => !this.ids.has(id))
    this.ids = next
    this.loadedVersion = version
    if (changed) this.onChange()
  }

  /**
   * Replaces the list with one read from Harmony. An add or remove made while the read is in
   * flight answers a later state than the read and is applied over it. Rejects as `read` does,
   * leaving the list as it was.
   */
  async load(read: () => Promise<{ version: string | null; ids: Iterable<string> }>): Promise<void> {
    const since = this.seq
    this.readsInFlight++
    try {
      const { version, ids } = await read()
      const next = new Set(ids)
      for (const edit of this.edits) {
        if (edit.seq <= since) continue
        if (edit.present) next.add(edit.id)
        else next.delete(edit.id)
      }
      this.replace(version, next)
    } finally {
      if (--this.readsInFlight === 0) this.edits = []
    }
  }

  size(): number {
    return this.ids.size
  }

  private note(id: string, present: boolean): void {
    this.seq++
    if (this.readsInFlight > 0) this.edits.push({ seq: this.seq, id, present })
  }
}
