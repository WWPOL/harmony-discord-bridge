import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChannelType, Collection } from 'discord.js'
import { BridgeRuntime } from '../src/runtime/BridgeRuntime.js'
import { HarmonyHttpError } from '../src/HarmonyClient.js'
import { V2Directory } from '../src/v2/V2Directory.js'
import { APPLICATION_FLAGS } from '../src/runtime/discordConnection.js'
import { Logger } from '../src/log.js'
import type { PairWriter } from '../src/runtime/PairDirectory.js'
import { FakeDiscordClient, appResponse } from './fakeDiscord.js'

// Messages the bridge holds no mapping for (history import, a restart) and mappings whose Harmony
// message is gone (erase, purge) or in another channel.

const ALL = APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT | APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS | APPLICATION_FLAGS.GATEWAY_PRESENCE
const writer: PairWriter = { link: async () => {}, linkMany: async () => [], unlink: async () => false }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-mapping-'))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** `capabilities`: what the gateway lists; Harmony 1.9.7 lists bridge_privacy, 1.9.6 nothing. */
function setup(opts: { capabilities?: string[] } = {}) {
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u.endsWith('/applications/@me')) return appResponse(ALL)()
    if (u.includes('/members')) return Response.json([])
    return new Response('not found', { status: 404 })
  })
  const log = new Logger('debug', '', true)
  const runtime = new BridgeRuntime({
    mode: 'v2',
    directory: new V2Directory({
      bridge_id: 'b', server_id: 's', mode: 'self', discord_guild_id: 'g1',
      settings: { sync_member_list: true },
      pairs: [{ discord_channel_id: '1001', harmony_channel_id: 'h1', harmony_channel_name: 'general', direction: 'both' }],
      harmony_channels: [],
    }),
    writer,
    discordToken: 'dtok',
    harmony: { token: 'htok', gatewayUrl: 'ws://127.0.0.1:9/gateway', apiUrl: 'http://127.0.0.1:9', baseUrl: 'https://h.example' },
    permissionStorePath: join(dir, 'permission-sync.yml'),
    log,
    fetchImpl,
    media: { maxUploadBytes: 8 * 1024 * 1024, mediaOrigin: null },
    appEmojiDir: null,
    createDiscordClient: (options) => {
      const c = new FakeDiscordClient(options)
      c.addGuild('g1', [])
      return c as any
    },
  })
  const h = runtime.harmony
  ;(h as any).setCapabilities(opts.capabilities ?? ['bridge_privacy'])
  const spies = {
    sendMessage: vi.spyOn(h, 'sendMessage').mockImplementation(async () => ({ id: 'hm-new' })),
    editMessage: vi.spyOn(h, 'editMessage').mockResolvedValue({}),
    deleteMessage: vi.spyOn(h, 'deleteMessage').mockResolvedValue({ success: true }),
    addReaction: vi.spyOn(h, 'addReaction').mockResolvedValue({ success: true }),
    removeReaction: vi.spyOn(h, 'removeReaction').mockResolvedValue({ success: true }),
    createThread: vi.spyOn(h, 'createThread').mockResolvedValue({ id: 'ht-1' } as any),
    lookupThread: vi.spyOn(h, 'lookupThreadByDiscordId').mockResolvedValue(null),
    lookupMessage: vi.spyOn(h, 'lookupMessageByDiscordId').mockResolvedValue(null),
    recent: vi.spyOn(h, 'loadRecentMessages').mockResolvedValue([]),
    getMessage: vi.spyOn(h, 'getMessage').mockResolvedValue(null),
  }
  return { rt: runtime as any, h: spies, log }
}

function discordMessage(over: Record<string, any> = {}) {
  return {
    id: 'dm-1',
    channelId: '1001',
    guildId: 'g1',
    partial: false,
    author: { id: 'du-1', bot: false, username: 'user', discriminator: '0', globalName: null, displayAvatarURL: () => 'https://cdn.example/a.png' },
    member: { displayName: 'Dave', displayAvatarURL: () => 'https://cdn.example/m.png' },
    content: 'hello',
    attachments: new Collection(),
    stickers: new Collection(),
    embeds: [],
    mentions: { users: new Collection(), roles: new Collection(), channels: new Collection(), repliedUser: null },
    reference: null,
    messageSnapshots: new Collection(),
    flags: { has: () => false },
    guild: null,
    ...over,
  }
}

const reaction = (messageId: string) => ({
  partial: false,
  emoji: { id: null, name: '👍' },
  message: { id: messageId, channelId: '1001', guildId: 'g1', channel: { isThread: () => false }, guild: null },
})
const user = (id: string) => ({ id, bot: false, username: 'user', discriminator: '0', globalName: null, displayAvatarURL: () => 'https://cdn.example/a.png' })
const textOf = (parts: unknown) => JSON.stringify(parts)

describe('Discord events on messages the bridge holds no mapping for', () => {
  it('deletes the Harmony copy of an imported message it finds by Discord id', async () => {
    const { rt, h } = setup()
    h.lookupMessage.mockResolvedValue({ id: 'hm-old', metadata: { discord_message_id: 'dm-1', history_import: true } })
    await rt.onDiscordMessageDelete(discordMessage())
    expect(h.lookupMessage).toHaveBeenCalledWith('h1', 'dm-1')
    expect(h.deleteMessage).toHaveBeenCalledWith('hm-old')
  })

  it('leaves a Harmony original alone when the deleted Discord message is its copy', async () => {
    const { rt, h } = setup()
    h.lookupMessage.mockResolvedValue({ id: 'hm-orig', metadata: { discord_message_id: 'dm-1', bridge_source: 'harmony' } })
    await rt.onDiscordMessageDelete(discordMessage({ author: null }))
    expect(h.deleteMessage).not.toHaveBeenCalled()
  })

  it('edits the Harmony copy it finds by Discord id', async () => {
    const { rt, h } = setup()
    h.lookupMessage.mockResolvedValue({ id: 'hm-old', metadata: { discord_message_id: 'dm-1' } })
    await rt.onDiscordMessageUpdate(discordMessage({ content: 'edited', editedTimestamp: 1 }))
    expect(h.editMessage).toHaveBeenCalledWith('hm-old', expect.anything())
  })

  it('adds and removes reactions on a message it finds by Discord id', async () => {
    const { rt, h } = setup()
    h.lookupMessage.mockResolvedValue({ id: 'hm-old', metadata: { discord_message_id: 'dm-1' } })
    await rt.onDiscordReactionAdd(reaction('dm-1'), user('du-2'))
    await rt.onDiscordReactionRemove(reaction('dm-1'), user('du-2'))
    expect(h.addReaction).toHaveBeenCalledWith('h1', 'hm-old', '👍', expect.anything())
    expect(h.removeReaction).toHaveBeenCalledWith('h1', 'hm-old', '👍', 'du-2')
    expect(h.lookupMessage).toHaveBeenCalledTimes(1)
  })

  it('asks Harmony once about a message it does not hold, however many reactions follow', async () => {
    const { rt, h } = setup()
    for (const id of ['du-2', 'du-3', 'du-4']) await rt.onDiscordReactionAdd(reaction('dm-9'), user(id))
    expect(h.lookupMessage).toHaveBeenCalledTimes(1)
    expect(h.addReaction).not.toHaveBeenCalled()
    vi.advanceTimersByTime(11 * 60_000)
    await rt.onDiscordReactionAdd(reaction('dm-9'), user('du-5'))
    expect(h.lookupMessage).toHaveBeenCalledTimes(2)
  })

  it('logs a lookup that fails and deletes nothing', async () => {
    const { rt, h, log } = setup()
    const error = vi.spyOn(log, 'error')
    h.lookupMessage.mockRejectedValue(new HarmonyHttpError('down', 503))
    await rt.onDiscordMessageDelete(discordMessage())
    expect(h.deleteMessage).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to look up the Harmony copy of Discord message dm-1'))
  })

  it('looks nothing up on Harmony 1.9.6, whose lookup reads the whole channel', async () => {
    const { rt, h } = setup({ capabilities: [] })
    h.lookupMessage.mockResolvedValue({ id: 'hm-old', metadata: { discord_message_id: 'dm-1' } })
    await rt.onDiscordMessageDelete(discordMessage())
    await rt.onDiscordMessageUpdate(discordMessage({ content: 'edited', editedTimestamp: 1 }))
    await rt.onDiscordReactionAdd(reaction('dm-1'), user('du-2'))
    expect(h.lookupMessage).not.toHaveBeenCalled()
    expect(h.deleteMessage).not.toHaveBeenCalled()
    expect(h.editMessage).not.toHaveBeenCalled()
    rt.discordToHarmonyMessages.set('dm-1', 'hm-1')
    await rt.onDiscordMessageDelete(discordMessage())
    expect(h.deleteMessage).toHaveBeenCalledWith('hm-1')
  })

  it('still deletes the copy of a private-thread message an older bridge relayed', async () => {
    const { rt, h } = setup()
    rt.discordToHarmonyMessages.set('dm-1', 'hm-1')
    const privateThread = { id: 'pt-1', type: ChannelType.PrivateThread, parentId: '1001', isThread: () => true }
    await rt.onDiscordMessageDelete(discordMessage({ channelId: 'pt-1', channel: privateThread }))
    expect(h.deleteMessage).toHaveBeenCalledWith('hm-1')
  })
})

describe('mappings whose Harmony message is gone or elsewhere', () => {
  const replyTo = (messageId: string) => ({ reference: { messageId, type: 0 } })

  it.each([
    ['Harmony 1.9.7', new HarmonyHttpError('reply_to names a message in another channel', 400, 'REPLY_OUT_OF_SCOPE')],
    ['Harmony 1.9.6', new HarmonyHttpError('REPLY_OUT_OF_SCOPE: a reply names a message in the same channel or conversation', 500)],
  ])('sends a reply Harmony refuses as out of scope again without the reply (%s)', async (_name, refusal) => {
    const { rt, h } = setup()
    rt.discordToHarmonyMessages.set('dp', 'hm-dead')
    rt.harmonyToDiscordMessages.set('hm-dead', 'dp')
    h.sendMessage.mockRejectedValueOnce(refusal)
    await rt.onDiscordMessage(discordMessage(replyTo('dp')))
    expect(h.sendMessage.mock.calls.map(c => c[3])).toEqual(['hm-dead', null])
    expect(rt.discordToHarmonyMessages.get('dp')).toBeUndefined()
    expect(rt.discordToHarmonyMessages.get('dm-1')).toBe('hm-new')
  })

  it('starts a thread standalone when its mapped starter is gone from the channel', async () => {
    const { rt, h } = setup()
    rt.discordToHarmonyMessages.set('dt-1', 'hm-dead')
    rt.harmonyToDiscordMessages.set('hm-dead', 'dt-1')
    h.createThread.mockRejectedValueOnce(new HarmonyHttpError('Message not found in this channel', 404))
    const thread = { id: 'dt-1', name: 'topic', ownerId: null, type: ChannelType.PublicThread }
    expect(await rt.threads.harmonyThreadFor(thread, 'h1')).toBe('ht-1')
    expect(h.createThread.mock.calls.map(c => (c[2] as any).messageId)).toEqual(['hm-dead', null])
    expect(rt.discordToHarmonyMessages.get('dt-1')).toBeUndefined()
  })
})

describe('leading Discord message links', () => {
  it('relays a message that is only a link to a message Harmony does not hold, link included', async () => {
    const { rt, h } = setup()
    const link = 'https://discord.com/channels/900000000000000001/1001/999'
    await rt.onDiscordMessage(discordMessage({ content: link }))
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    expect(textOf(h.sendMessage.mock.calls[0][1])).toContain(link)
    expect(h.sendMessage.mock.calls[0][3]).toBeNull()
  })

  it('treats a leading link into another channel as a link, not a reply', async () => {
    const { rt, h } = setup()
    rt.discordToHarmonyMessages.set('555', 'hm-other')
    const link = 'https://discord.com/channels/900000000000000001/2002/555'
    await rt.onDiscordMessage(discordMessage({ content: `${link}\nlook at this` }))
    expect(h.sendMessage.mock.calls[0][3]).toBeNull()
    expect(textOf(h.sendMessage.mock.calls[0][1])).toContain(link)
  })
})

describe('a delete or edit that arrives while the relay is still sending', () => {
  /** The next send waits for release or fail; `started` resolves once the relay has sent it. */
  function heldSend(h: any) {
    let release!: (v: unknown) => void
    let fail!: (e: unknown) => void
    let start!: () => void
    const started = new Promise<void>(res => { start = res })
    const pending = new Promise((res, rej) => { release = res; fail = rej })
    h.sendMessage.mockImplementationOnce(() => { start(); return pending })
    return { started, release: (v: unknown) => release(v), fail: (e: unknown) => fail(e) }
  }

  it('deletes the Harmony copy once the send returns', async () => {
    const { rt, h } = setup()
    const send = heldSend(h)
    const relay = rt.onDiscordMessage(discordMessage())
    await send.started
    await rt.onDiscordMessageDelete(discordMessage())
    expect(h.deleteMessage).not.toHaveBeenCalled()
    send.release({ id: 'hm-new' })
    await relay
    expect(h.deleteMessage).toHaveBeenCalledWith('hm-new')
    expect(rt.relaysInFlight.size).toBe(0)
  })

  it('applies an edit once the send returns; a later delete wins over it', async () => {
    const { rt, h } = setup()
    let send = heldSend(h)
    let relay = rt.onDiscordMessage(discordMessage())
    await send.started
    await rt.onDiscordMessageUpdate(discordMessage({ content: 'fixed typo', editedTimestamp: 5 }))
    send.release({ id: 'hm-new' })
    await relay
    expect(h.editMessage).toHaveBeenCalledWith('hm-new', expect.anything())
    expect(textOf(h.editMessage.mock.calls[0][1])).toContain('fixed typo')

    send = heldSend(h)
    // Other content: the anti-spam check drops a repeat.
    relay = rt.onDiscordMessage(discordMessage({ id: 'dm-2', content: 'second' }))
    await send.started
    await rt.onDiscordMessageUpdate(discordMessage({ id: 'dm-2', content: 'edit', editedTimestamp: 6 }))
    await rt.onDiscordMessageDelete(discordMessage({ id: 'dm-2' }))
    send.release({ id: 'hm-2' })
    await relay
    expect(h.deleteMessage).toHaveBeenCalledWith('hm-2')
    expect(h.editMessage).toHaveBeenCalledTimes(1)
  })

  it('applies a held delete and edit through Harmony\'s lookup when the send fails after the gateway stored it', async () => {
    const { rt, h } = setup()
    let send = heldSend(h)
    let relay = rt.onDiscordMessage(discordMessage())
    await send.started
    await rt.onDiscordMessageDelete(discordMessage())
    h.lookupMessage.mockResolvedValue({ id: 'hm-late', metadata: { discord_message_id: 'dm-1' } })
    send.fail(new TypeError('fetch failed'))
    await relay
    expect(h.lookupMessage).toHaveBeenCalledWith('h1', 'dm-1')
    expect(h.deleteMessage).toHaveBeenCalledWith('hm-late')

    send = heldSend(h)
    relay = rt.onDiscordMessage(discordMessage({ id: 'dm-2', content: 'second' }))
    await send.started
    await rt.onDiscordMessageUpdate(discordMessage({ id: 'dm-2', content: 'private bit removed', editedTimestamp: 9 }))
    h.lookupMessage.mockResolvedValue({ id: 'hm-late-2', metadata: { discord_message_id: 'dm-2' } })
    send.fail(new HarmonyHttpError('gateway timeout', 504))
    await relay
    expect(h.editMessage).toHaveBeenCalledWith('hm-late-2', expect.anything())
    expect(textOf(h.editMessage.mock.calls[0][1])).toContain('private bit removed')
  })

  it('does not send a message whose delete arrived before the send', async () => {
    const { rt, h } = setup()
    let release!: () => void
    vi.spyOn(rt, 'guildMemberFor').mockImplementationOnce(() => new Promise(res => { release = () => res(null) }))
    const relay = rt.onDiscordMessage(discordMessage())
    await rt.onDiscordMessageDelete(discordMessage())
    release()
    await relay
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(h.deleteMessage).not.toHaveBeenCalled()
    expect(rt.relaysInFlight.size).toBe(0)
  })

  it('applies nothing when the send fails, and forgets the message', async () => {
    const { rt, h } = setup()
    const send = heldSend(h)
    const relay = rt.onDiscordMessage(discordMessage())
    await send.started
    await rt.onDiscordMessageDelete(discordMessage())
    send.fail(new HarmonyHttpError('down', 400))
    await relay
    expect(h.deleteMessage).not.toHaveBeenCalled()
    expect(rt.relaysInFlight.size).toBe(0)
  })
})

describe('lookups by Discord id', () => {
  it('a delete asks Harmony even after a remembered miss', async () => {
    const { rt, h } = setup()
    await rt.onDiscordReactionAdd(reaction('dm-1'), user('du-2'))
    h.lookupMessage.mockResolvedValue({ id: 'hm-imported', metadata: { discord_message_id: 'dm-1', history_import: true } })
    await rt.onDiscordMessageDelete(discordMessage())
    expect(h.lookupMessage).toHaveBeenCalledTimes(2)
    expect(h.deleteMessage).toHaveBeenCalledWith('hm-imported')
  })

  it('forgets the misses of messages history import stored', async () => {
    const { rt, h } = setup()
    await rt.onDiscordReactionAdd(reaction('dm-9'), user('du-2'))
    rt.forgetLookupMisses(['dm-9'])
    h.lookupMessage.mockResolvedValue({ id: 'hm-9', metadata: { discord_message_id: 'dm-9' } })
    await rt.onDiscordReactionAdd(reaction('dm-9'), user('du-3'))
    expect(h.lookupMessage).toHaveBeenCalledTimes(2)
    expect(h.addReaction).toHaveBeenCalledWith('h1', 'hm-9', '👍', expect.anything())
  })

  it('shares one lookup between events that arrive together', async () => {
    const { rt, h } = setup()
    h.lookupMessage.mockResolvedValue({ id: 'hm-old', metadata: { discord_message_id: 'dm-1' } })
    await Promise.all([
      rt.onDiscordReactionAdd(reaction('dm-1'), user('du-2')),
      rt.onDiscordReactionAdd(reaction('dm-1'), user('du-3')),
    ])
    expect(h.lookupMessage).toHaveBeenCalledTimes(1)
    expect(h.addReaction).toHaveBeenCalledTimes(2)
  })

  it('records a Harmony original found as a reply parent, so deleting its Discord copy keeps it', async () => {
    const { rt, h } = setup()
    h.lookupMessage.mockResolvedValue({ id: 'hm-orig', metadata: { discord_message_id: 'dc-copy', bridge_source: 'harmony' } })
    await rt.onDiscordMessage(discordMessage({ reference: { messageId: 'dc-copy', type: 0 } }))
    expect(h.sendMessage.mock.calls[0][3]).toBe('hm-orig')
    // Later, out of Discord's cache: a partial delete without webhook or author.
    await rt.onDiscordMessageDelete(discordMessage({ id: 'dc-copy', author: null, webhookId: null }))
    expect(h.deleteMessage).not.toHaveBeenCalled()
  })
})

describe('Discord updates that are not edits', () => {
  it('ignores an update of a message that was never edited (a thread started on it, embeds loaded)', async () => {
    const { rt, h } = setup()
    rt.discordToHarmonyMessages.set('dm-1', 'hm-1')
    await rt.onDiscordMessageUpdate(discordMessage({ editedTimestamp: null }))
    expect(h.editMessage).not.toHaveBeenCalled()
  })

  it('ignores an update whose cached old version has the same edit time and content', async () => {
    const { rt, h } = setup()
    rt.discordToHarmonyMessages.set('dm-1', 'hm-1')
    const old = discordMessage({ editedTimestamp: 7 })
    await rt.onDiscordMessageUpdate(discordMessage({ editedTimestamp: 7 }), old)
    expect(h.editMessage).not.toHaveBeenCalled()
    await rt.onDiscordMessageUpdate(discordMessage({ editedTimestamp: 8, content: 'changed' }), old)
    expect(h.editMessage).toHaveBeenCalledTimes(1)
  })
})

describe('native replies that start with a message link', () => {
  const nativeReply = (content: string) => discordMessage({ content, reference: { messageId: 'dp', type: 0 } })

  const toParent = (content: string) => discordMessage({ content, reference: { messageId: '321', type: 0 } })
  const parentLink = 'https://discord.com/channels/900000000000000001/1001/321'

  it('drops one leading link to the reply\'s own parent, the bridge reply format', async () => {
    const { rt, h } = setup()
    rt.discordToHarmonyMessages.set('321', 'hm-p')
    await rt.onDiscordMessage(toParent(`${parentLink}\n${parentLink}\nanswer`))
    expect(h.sendMessage.mock.calls[0][3]).toBe('hm-p')
    const sent = textOf(h.sendMessage.mock.calls[0][1])
    expect(sent.split(parentLink).length - 1).toBe(1)
    expect(sent).toContain('answer')
  })

  it('keeps a leading link to another message of the channel', async () => {
    const { rt, h } = setup()
    rt.discordToHarmonyMessages.set('321', 'hm-p')
    const other = 'https://discord.com/channels/900000000000000001/1001/654'
    await rt.onDiscordMessage(toParent(other))
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    expect(textOf(h.sendMessage.mock.calls[0][1])).toContain(other)
  })

  it('relays a reply that is only a link to its parent, with the link', async () => {
    const { rt, h } = setup()
    rt.discordToHarmonyMessages.set('321', 'hm-p')
    await rt.onDiscordMessage(toParent(parentLink))
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    expect(textOf(h.sendMessage.mock.calls[0][1])).toContain(parentLink)
  })

  it('a reply by leading link drops that one line, not a second link under it', async () => {
    const { rt, h } = setup()
    rt.discordToHarmonyMessages.set('321', 'hm-p')
    const parent = 'https://discord.com/channels/900000000000000001/1001/321'
    const shared = 'https://discord.com/channels/900000000000000001/1001/654'
    await rt.onDiscordMessage(discordMessage({ content: `${parent}\n${shared}\nanswer` }))
    expect(h.sendMessage.mock.calls[0][3]).toBe('hm-p')
    const sent = textOf(h.sendMessage.mock.calls[0][1])
    expect(sent).toContain(shared)
    expect(sent).not.toContain(parent)
  })

  it('keeps a leading link into another channel', async () => {
    const { rt, h } = setup()
    rt.discordToHarmonyMessages.set('dp', 'hm-p')
    const other = 'https://discord.com/channels/900000000000000001/2002/321'
    await rt.onDiscordMessage(nativeReply(`${other}\nsee this`))
    expect(textOf(h.sendMessage.mock.calls[0][1])).toContain(other)
  })
})
