export type SyncMode = 'mirror' | 'merge' | 'add'

export const SYNC_MODE_CHOICES: Array<{ name: string; value: SyncMode }> = [
  { name: 'Mirror: match Discord exactly (deletes extras)', value: 'mirror' },
  { name: 'Merge: add and update, keep Harmony extras', value: 'merge' },
  { name: 'Add: only add new ones', value: 'add' },
]

export interface SyncDiscordItem { id: string; name: string }
export interface SyncHarmonyItem { id: string; name: string; discordId: string | null }

export interface SyncPlan<D, H> {
  add: D[]
  update: Array<{ discord: D; harmony: H }>
  replace: Array<{ discord: D; harmony: H[] }>
  skip: Array<{ discord: D; harmony: H }>
  delete: H[]
  unchanged: number
  /** Add mode only: linked items that changed on Discord but are left as they are. */
  outdated: number
}

const key = (name: string): string => name.toLowerCase()

export function planSync<D extends SyncDiscordItem, H extends SyncHarmonyItem>(input: {
  mode: SyncMode
  discord: D[]
  presentIds?: string[]
  harmony: H[]
  differs: (d: D, h: H) => boolean
}): SyncPlan<D, H> {
  const { mode, discord, harmony, differs } = input
  const plan: SyncPlan<D, H> = { add: [], update: [], replace: [], skip: [], delete: [], unchanged: 0, outdated: 0 }
  const consumed = new Set<string>()

  const linkedByDiscord = new Map<string, H>()
  for (const hi of harmony) {
    if (hi.discordId && !linkedByDiscord.has(hi.discordId)) linkedByDiscord.set(hi.discordId, hi)
  }
  const unlinkedByName = new Map<string, H[]>()
  for (const hi of harmony) {
    if (hi.discordId) continue
    const k = key(hi.name)
    const list = unlinkedByName.get(k)
    if (list) list.push(hi)
    else unlinkedByName.set(k, [hi])
  }

  // Linked items first, so they always win over name matching.
  const unlinkedDiscord: D[] = []
  for (const di of discord) {
    const linked = linkedByDiscord.get(di.id)
    if (!linked) { unlinkedDiscord.push(di); continue }
    consumed.add(linked.id)
    if (!differs(di, linked)) plan.unchanged++
    else if (mode === 'add') plan.outdated++
    else plan.update.push({ discord: di, harmony: linked })
  }

  for (const di of unlinkedDiscord) {
    const candidates = (unlinkedByName.get(key(di.name)) ?? []).filter(x => !consumed.has(x.id))
    if (candidates.length === 0) { plan.add.push(di); continue }
    if (mode === 'add') {
      consumed.add(candidates[0].id)
      plan.skip.push({ discord: di, harmony: candidates[0] })
    } else {
      for (const c of candidates) consumed.add(c.id)
      plan.replace.push({ discord: di, harmony: candidates })
    }
  }

  if (mode === 'mirror') {
    const present = new Set<string>([...discord.map(x => x.id), ...(input.presentIds ?? [])])
    for (const hi of harmony) {
      if (consumed.has(hi.id)) continue
      if (hi.discordId && present.has(hi.discordId)) continue
      plan.delete.push(hi)
    }
  }
  return plan
}

const MAX_LISTED = 20

export function syncReportLines<D extends { name: string }, H extends { name: string }>(plan: SyncPlan<D, H>, opts: {
  dryRun: boolean; label: (name: string) => string; noun: string
}): string[] {
  const lines: string[] = []
  const section = (verb: string, tail: string, names: string[]): void => {
    if (names.length === 0) return
    const noun = opts.noun + (names.length === 1 ? '' : 's')
    lines.push(`${verb} ${names.length} ${noun}${tail}`)
    for (const n of names.slice(0, MAX_LISTED)) lines.push(`  • ${opts.label(n)}`)
    if (names.length > MAX_LISTED) lines.push(`  • …and ${names.length - MAX_LISTED} more`)
  }
  const v = (dry: string, real: string): string => (opts.dryRun ? dry : real)
  section(v('Would add', 'Add'), '', plan.add.map(x => x.name))
  section(v('Would update', 'Update'), '', plan.update.map(x => x.discord.name))
  section(v('Would replace', 'Replace'), ' (same name on Harmony)', plan.replace.map(x => x.discord.name))
  section(v('Would delete', 'Delete'), '', plan.delete.map(x => x.name))
  section(v('Skipped', 'Skip'), ' (name already on Harmony)', plan.skip.map(x => x.discord.name))
  if (plan.outdated > 0) lines.push(`Not updated (add mode): ${plan.outdated} changed on Discord; use merge or mirror to update`)
  if (plan.unchanged > 0) lines.push(`Unchanged: ${plan.unchanged}`)
  const nothingToDo = plan.add.length + plan.update.length + plan.replace.length + plan.delete.length + plan.skip.length + plan.outdated === 0
  if (opts.dryRun && nothingToDo) lines.push('Already matches: nothing to change')
  return lines
}
