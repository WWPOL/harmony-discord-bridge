import { describe, expect, it, vi } from 'vitest'
import { runBridgeSyncSounds } from '../src/runtime/commands.js'
import { HarmonyHttpError } from '../src/HarmonyClient.js'

function discordSound(soundId: string, name: string, extra: Record<string, unknown> = {}) {
  return { soundId, name, volume: 1, available: true, emoji: null, ...extra }
}
function harmonyRow(id: string, name: string, discord: string | null = null) {
  return { id, name, emoji: null, emoji_id: null, volume: 1, discord_sound_id: discord }
}

function setup(opts: {
  mode?: string | null
  dryRun?: boolean
  discord?: unknown[]
  fetchError?: Error
  harmony?: unknown[] | Error
  confirm?: 'confirm' | 'cancel' | 'timeout'
}) {
  const calls: string[] = []
  const replies: Array<Record<string, any>> = []
  const message = {
    awaitMessageComponent: vi.fn(async () => {
      if (opts.confirm === 'timeout') throw new Error('time')
      return { customId: `${opts.confirm ?? 'confirm'}:i1`, user: { id: 'u1' }, update: vi.fn(async () => {}) }
    }),
  }
  const command: any = {
    id: 'i1',
    user: { id: 'u1' },
    options: {
      getString: () => opts.mode ?? null,
      getBoolean: () => opts.dryRun ?? false,
    },
    guild: {
      id: 'g1',
      name: 'G',
      soundboardSounds: {
        fetch: vi.fn(async () => {
          if (opts.fetchError) throw opts.fetchError
          return new Map((opts.discord ?? []).map((s: any) => [s.soundId, s]))
        }),
      },
    },
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async (r: any) => { replies.push(r); return message }),
  }
  const rt: any = {
    mode: 'v2',
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    dir: { getBridgeForDiscordGuild: () => ({ harmonyServerId: 's1' }) },
    emojiLinks: { ensure: vi.fn(async () => {}), harmonyFor: () => null },
    harmony: {
      getServerSounds: vi.fn(async () => {
        if (opts.harmony instanceof Error) throw opts.harmony
        return opts.harmony ?? []
      }),
      deleteServerSound: vi.fn(async (_s: string, id: string) => { calls.push(`delete:${id}`) }),
      importDiscordSound: vi.fn(async (_s: string, sound: any, update: boolean) => {
        calls.push(`${update ? 'update' : 'create'}:${sound.name}`)
      }),
    },
  }
  return { command, rt, calls, replies, message }
}

describe('runBridgeSyncSounds', () => {
  it('writes nothing on a dry run', async () => {
    const t = setup({ dryRun: true, discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'extra')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(t.replies.at(-1)!.content).toContain('Would add')
  })

  it('asks for confirmation in mirror mode and writes nothing on cancel', async () => {
    const t = setup({ discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'extra')], confirm: 'cancel' })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.message.awaitMessageComponent).toHaveBeenCalled()
    expect(t.replies[0].content).toContain('This deletes 1 Harmony sound(s). Confirm?')
    expect(t.calls).toEqual([])
  })

  it('writes nothing when the confirmation times out', async () => {
    const t = setup({ discord: [], harmony: [harmonyRow('h1', 'extra')], confirm: 'timeout' })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
  })

  it('deletes before creating after confirm', async () => {
    const t = setup({ discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'extra')], confirm: 'confirm' })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual(['delete:h1', 'create:horn'])
    expect(t.replies.at(-1)!.components).toEqual([])
  })

  it('does not ask in merge mode with nothing to delete', async () => {
    const t = setup({ mode: 'merge', discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'extra')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(t.calls).toEqual(['create:horn'])
  })

  it('treats a 404 on delete as already deleted', async () => {
    const t = setup({ discord: [], harmony: [harmonyRow('h1', 'extra')], confirm: 'confirm' })
    t.rt.harmony.deleteServerSound.mockRejectedValue(new HarmonyHttpError('gone', 404))
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.replies.at(-1)!.content).not.toContain('failure')
  })

  it('explains an old Harmony on 404', async () => {
    const t = setup({ harmony: new HarmonyHttpError('nope', 404) })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.replies.at(-1)!.content).toContain('needs a newer Harmony')
    expect(t.calls).toEqual([])
  })

  it('writes nothing when the Discord fetch fails', async () => {
    const t = setup({ fetchError: new Error('boom'), harmony: [harmonyRow('h1', 'extra')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.replies.at(-1)!.content).toContain('boom')
  })

  it('leaves unavailable sounds alone', async () => {
    const t = setup({
      discord: [discordSound('d1', 'horn', { available: false })],
      harmony: [harmonyRow('h1', 'horn', 'd1')],
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.replies.at(-1)!.content).toContain('already matches')
  })
})
