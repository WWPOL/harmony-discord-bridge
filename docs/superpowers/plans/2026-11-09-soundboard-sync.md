# Soundboard Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/bridge sync-sounds mode:<mirror|merge|add> dry_run:<bool>` makes the paired Harmony server's soundboard match the Discord guild's soundboard.

**Architecture:** Harmony (repo `brapmony`) gains a `server_sounds.discord_sound_id` link, two bridge-only SECURITY DEFINER RPCs, and three bot-gateway routes. The gateway downloads clips from Discord's CDN itself (never bot-supplied bytes), as emoji import does. The bridge (this repo) gets a generic pure sync planner (`expressionSync.ts`), reusable later for emoji and stickers, plus a confirm-button helper and the command.

**Tech Stack:** Postgres/pgTAP + Supabase storage, Express + vitest + supertest (bot-gateway), discord.js 14 + vitest (bridge), `music-metadata` for clip duration.

**Spec:** `docs/superpowers/specs/2026-11-09-soundboard-sync-design.md` (this repo). Read it first.

## Repos and branches

- **Harmony:** worktree of `C:\Users\Rudhra\Code\brapmony` on new branch `feat/bridge-soundboard-sync` from `master` (7615d48d), at `C:SERSRUDHRACODEWORKTREESBRAPMONY-SOUNDBOARD-SYNC`. Tasks H1–H3. Read `docs/contribute/migrations.md` there before H1.
- **Bridge:** this worktree (`harmony-discord-bridge`, branch `worktree-cuddly-swinging-heron`). Tasks B1–B3. B1 has no Harmony dependency; B2/B3 code against the H3 HTTP contract below.

## Global Constraints

- Discord: sound `name` 2–32, `volume` 0–1, audio mp3/ogg ≤ 512 KB (524288 bytes), ≤ 5.2 s; CDN `https://cdn.discordapp.com/soundboard-sounds/{sound_id}`. Audio of a Discord sound never changes.
- Harmony `server_sounds`: `name` trimmed 1–32; `emoji` 1–16 chars XOR `emoji_id` (uuid → `emojis`); `volume` numeric(3,2) 0–1; `duration_ms` 1–5200; `storage_path` `{server_id}/{uuid}.{mp3|ogg}` in bucket `soundboard`; max 48 per server (existing trigger, raises on insert).
- Only the bot of the server's `discord_bridges` row may call the new RPCs/routes (42501 / HTTP 403 otherwise). RPCs are granted to `service_role` only.
- `created_by` stays NULL for bridge-created sounds.
- Modes: `mirror` adds, updates, replaces same-name, deletes every Harmony sound not on Discord (including Harmony-only ones). `merge` adds, updates, replaces same-name, deletes nothing else. `add` only adds; same-name Harmony sounds are skipped; linked sounds untouched.
- Default mode `mirror`. Real run with ≥1 delete or replace asks Confirm/Cancel (60 s timeout = cancel, only invoker can press).
- Apply order: deletes (incl. the Harmony side of replaces) first, then creates, then updates.
- Discord sounds with `available === false`: never imported, but count as present (their linked Harmony copy is neither deleted nor updated).
- Command is v2-only (like `import-emojis`) and Administrator-gated by the existing `/bridge` check.
- Commits in both repos end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Signing: follow the global CLAUDE.md rule (retry once, then `git -c commit.gpgsign=false commit`, note base SHA). Do not push.

## Review Focus

1. A Harmony sound named like a Discord one but differing only in case ("AirHorn" vs "airhorn") must be treated as a same-name collision → B1 test `treats case-insensitive name matches as collisions`.
2. A Discord custom emoji not yet imported to Harmony must yield no emoji, never its text name as unicode → B2 test `drops an unimported custom emoji instead of using its name`.
3. Harmony returns `volume` as `"0.50"` (numeric) or `0.5`; a sound whose volume did not change must not be reported as updated → B2 test `treats 0.5 and "0.50" as the same volume`.
4. Two Discord sounds whose names collide with the same Harmony sound, or two Harmony sounds with the same name: no Harmony row may be scheduled for deletion twice → B1 test `never schedules one Harmony sound for two actions`.
5. The RPC failing after the gateway stored the clip (e.g. 48-cap) must not leave an orphaned storage object → H3 test `removes the stored clip when the import RPC fails`.

## HTTP contract (H3 produces, B2 consumes)

```
GET    /servers/:serverId/sounds
  200 → HarmonyServerSound[]  (all sounds of the server, linked or not)
  403 → not the bridge bot · 400 bad uuid · 404 route missing on old Harmony
POST   /servers/:serverId/sounds/discord
  body { discord_sound_id: string, name: string, emoji: string|null, emoji_id: string|null,
         volume: number, update: boolean }
  201 { status:'created', ...HarmonyServerSound } · 200 { status:'existing'|'updated', ... }
  400 validation / 403 / 409 {error, code:'SOUND_LIMIT'} when the 48-cap refuses / 502 CDN or storage
DELETE /servers/:serverId/sounds/:soundId
  204 · 404 not a sound of this server · 403
HarmonyServerSound = { id: string, name: string, emoji: string|null, emoji_id: string|null,
                       volume: number|string, discord_sound_id: string|null }
```

---

### Task H1: Harmony migration + pgTAP

**Files:**
- Create: `db_schema/migrations/20261109200001_bridge_server_sounds.sql`
- Create: `db_schema/tests/250_bridge_server_sounds.sql`
- Modify: `db_schema/SURFACE.tsv`, `db_schema/REACHABILITY.tsv` (rows for the two RPCs, same format as the `bridge_import_server_emoji` rows; sorted position as the generator would place them). Docker is not available locally: hand-write the rows; CI's `surface`/`reachability` jobs verify. Say so in the PR body.

**Interfaces — Produces:**
- Column `server_sounds.discord_sound_id text`, CHECK `discord_sound_id IS NULL OR discord_sound_id ~ '^[0-9]{1,20}$'`, unique index `server_sounds_server_discord_sound_key ON (server_id, discord_sound_id) WHERE discord_sound_id IS NOT NULL`.
- `public.bridge_import_server_sound(p_bot_id uuid, p_server_id uuid, p_discord_sound_id text, p_name text, p_emoji text, p_emoji_id uuid, p_volume numeric, p_update boolean, p_storage_path text, p_duration_ms integer) RETURNS TABLE(status text, id uuid, name text, emoji text, emoji_id uuid, volume numeric, discord_sound_id text)` — SECURITY DEFINER, `search_path = public, pg_temp`, `#variable_conflict use_column`.
- `public.bridge_delete_server_sound(p_bot_id uuid, p_server_id uuid, p_sound_id uuid) RETURNS text` — returns the deleted row's `storage_path`, NULL when no such sound in that server.
- Both: `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role`.

Import RPC logic, in order:
1. Bridge-bot check (copy from `bridge_import_server_emoji`) → 42501 `bot is not the Discord bridge of this server`.
2. Validate → 22023: id `^[0-9]{1,20}$` (`invalid Discord sound id`); `p_name = btrim(p_name)` and length 1–32 (`invalid sound name`); not both `p_emoji` and `p_emoji_id`; `p_emoji` 1–16 chars trimmed; `p_emoji_id` must be an `emojis` row (any scope visible on this server: `server_id = p_server_id` or `scope = 'instance'`) (`invalid sound emoji`); `p_volume` 0–1 (`invalid sound volume`).
3. Row with `(server_id, discord_sound_id)` exists: if `p_update` and any of name/emoji/emoji_id/volume differ → UPDATE them, `updated`; else `existing`.
4. Else require `p_storage_path ~ ('^' || p_server_id || '/[0-9a-f-]{36}\.(mp3|ogg)$')` and `p_duration_ms` 1–5200, otherwise raise 22023 **`invalid sound file`** (the gateway's cue to download). INSERT with `ON CONFLICT … DO NOTHING`; on conflict return the existing row as `existing` (race). Return `created`.
5. No same-name linking (the bridge plans replacements itself).

Delete RPC: bridge-bot check, `DELETE … WHERE id = p_sound_id AND server_id = p_server_id RETURNING storage_path`.

- [ ] **Step 1: Write `250_bridge_server_sounds.sql`** modeled on `97_bridge_server_emojis.sql` (fixture server `55555555-0000-0000-0000-000000000005`, bots `b1` bridge / `b2` not). Assertions:
  - authenticated and anon lack EXECUTE on both functions;
  - b2 calling import → `throws_ok … '42501'`; b2 delete → 42501;
  - import with no path for a new id → throws 22023 `invalid sound file`;
  - import with path `<server>/<uuid>.mp3`, duration 1200 → status `created`, `created_by IS NULL`, `discord_sound_id` stored;
  - same call again → `existing`; with changed name + `p_update true` → `updated` and name changed; with changed name + `p_update false` → `existing`, name unchanged;
  - both emoji and emoji_id → 22023; volume 1.5 → 22023; name `'  '` → 22023; duration 6000 → 22023;
  - delete returns the storage path and the row is gone; delete of a random uuid returns NULL.
  The `storage.objects` existence check in `guard_server_sound_client_write` is skipped for service-role writes, so no storage fixture is needed; verify by reading that trigger.
- [ ] **Step 2: Write the migration** (BEGIN / `SET LOCAL lock_timeout = '3s'` / … / COMMIT, header comment as in `20261009400001_bridge_server_emojis.sql`).
- [ ] **Step 3: Add SURFACE/REACHABILITY rows.** REACHABILITY entries: `rpc in bot-gateway/src/api/BotRestAPI.ts` (true after H3).
- [ ] **Step 4: Static check.** No Docker: re-read the SQL against `20261011300001_soundboard.sql` / `20261016100002_soundboard_custom_emoji.sql` column names; `psql` is not available either. State in the task report that pgTAP runs only in CI.
- [ ] **Step 5: Commit** `feat(db): bridge soundboard import and delete RPCs`.

### Task H2: bot-gateway clip download + duration

**Files:**
- Create: `bot-gateway/src/utils/discordSoundImport.ts`
- Test: `bot-gateway/src/utils/__tests__/discordSoundImport.test.ts`
- Modify: `bot-gateway/package.json` (+ lockfile): add `music-metadata` (latest major; ESM; use `parseBuffer`).

**Interfaces — Produces:**
- `export const SOUND_BUCKET = 'soundboard'`, `MAX_DISCORD_SOUND_BYTES = 524288`, `MAX_SOUND_DURATION_MS = 5200`, `DISCORD_SOUND_ID = /^[0-9]{1,20}$/`.
- `export function discordSoundCdnUrl(discordSoundId: string): string`
- `export function soundFormat(bytes: Uint8Array): 'mp3' | 'ogg' | null` — `OggS` magic → ogg; `ID3` or frame sync (`0xFF`, `(b1 & 0xE0) === 0xE0`) → mp3. Decide by bytes, not content-type.
- `export async function audioDurationMs(bytes: Uint8Array, format: 'mp3'|'ogg'): Promise<number>` — `Math.round(duration*1000)`; throws when the parser gives no duration.
- `export async function storeDiscordSound(serverId: string, discordSoundId: string, fetchImpl: typeof fetch = fetch): Promise<{ storagePath: string; durationMs: number }>` — fetch CDN URL; throw on !ok, 0 or > 524288 bytes, unknown format, duration < 1 or > 5200; upload to `soundboard` at `${serverId}/${randomUUID()}.${format}` with `contentType` `audio/mpeg`/`audio/ogg`, `upsert: false`, `cacheControl: '31536000'`.
- `export async function removeStoredSound(storagePath: string): Promise<void>` — best effort; logs, never throws.

- [ ] **Step 1: Write failing tests** (mock `../../config/supabase.js` storage as `discordEmojiImport.test.ts` does):
  - `soundFormat` recognizes `OggS…`, `ID3…`, `0xFF 0xFB …`, and returns null for `RIFF…` / random bytes;
  - `audioDurationMs` on a synthetic MP3 (build 77 MPEG-1 Layer III frames: header `FF FB 90 64`, 417-byte frames, zero payload ≈ 2.01 s) returns a value within 1950–2050;
  - `storeDiscordSound` uploads to a path matching `^<serverId>/[0-9a-f-]{36}\.mp3$` and returns that path + duration;
  - throws (no upload) on: HTTP 404; 524289-byte body; WAV bytes; synthetic MP3 of 230 frames (~6 s).
- [ ] **Step 2: Run** `cd bot-gateway && npx vitest run src/utils/__tests__/discordSoundImport.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** same command → PASS; `npx tsc --noEmit` in `bot-gateway` clean.
- [ ] **Step 5: Commit** `feat(bot-gateway): download Discord soundboard clips`.

### Task H3: bot-gateway routes, docs, changelog

**Files:**
- Modify: `bot-gateway/src/api/BotRestAPI.ts` (register next to `/servers/:serverId/emojis/discord`, line ~310; handlers next to `importDiscordEmoji`, ~2468)
- Test: `bot-gateway/src/api/__tests__/BotRestAPI.discordSound.test.ts` (copy the mock harness of `BotRestAPI.discordEmoji.test.ts`)
- Modify: `CHANGELOG.md` (`[Unreleased] → Added`), the bridge page under `docs/` that documents bridge endpoints/emoji import (find via `grep -rl "emojis/discord" docs`).

**Interfaces — Consumes:** H1 RPCs, H2 `storeDiscordSound`, `removeStoredSound`, `DISCORD_SOUND_ID`. **Produces:** the HTTP contract above.

Handlers (`listServerSounds`, `importDiscordSound`, `deleteServerSound`): UUID check on `serverId`/`soundId` (400), bridge-row check exactly as `importDiscordEmoji` (403). List: `supabase.from('server_sounds').select('id, name, emoji, emoji_id, volume, discord_sound_id').eq('server_id', serverId)`. Import: validate body (`update` boolean, defaults false); call RPC with null path/duration; on error message `invalid sound file` → `storeDiscordSound` (502 on throw) → call again with path/duration; if that errors → `removeStoredSound(path)` then map error. Error map: 42501→403, 22023→400, message containing the 48-cap trigger's text (read `enforce_server_sound_limit`) → 409 `{ code: 'SOUND_LIMIT' }`, else 500. Delete: RPC → NULL → 404; else `removeStoredSound(path)`, 204. Log bot actions `sound_imported` (created), `sound_updated`, `sound_deleted` via `this.logBotAction`.

- [ ] **Step 1: Write failing tests:** list returns rows (200) and 403 without bridge row; import `existing` → 200 and no download; `invalid sound file` → download → second RPC → 201; second RPC fails with limit → 409 and **`removes the stored clip when the import RPC fails`**; download throws → 502; bad body (`discord_sound_id: 'x'`) → 400; delete → 204 + storage removal called; RPC NULL → 404.
- [ ] **Step 2: Run** `npx vitest run src/api/__tests__/BotRestAPI.discordSound.test.ts` → FAIL.
- [ ] **Step 3: Implement** handlers and routes.
- [ ] **Step 4: Run** the new test file, then the whole `npx vitest run` and `npx tsc --noEmit` in `bot-gateway` → PASS / clean.
- [ ] **Step 5: Docs + CHANGELOG** entry: "Discord bridge can sync a server's soundboard (`/bridge sync-sounds` in harmony-discord-bridge)", listing the three endpoints.
- [ ] **Step 6: Commit** `feat(bot-gateway): bridge soundboard sync endpoints`.

### Task B1: Generic sync planner

**Files:**
- Create: `src/runtime/expressionSync.ts`
- Test: `test/expressionSync.test.ts`

**Interfaces — Produces:**
```ts
export type SyncMode = 'mirror' | 'merge' | 'add'
export const SYNC_MODE_CHOICES: Array<{ name: string; value: SyncMode }>  // Mirror (default), Merge, Add — names include a short hint
export interface SyncDiscordItem { id: string; name: string }
export interface SyncHarmonyItem { id: string; name: string; discordId: string | null }
export interface SyncPlan<D, H> {
  add: D[]
  update: Array<{ discord: D; harmony: H }>
  replace: Array<{ discord: D; harmony: H[] }>
  skip: Array<{ discord: D; harmony: H }>
  delete: H[]
  unchanged: number
}
export function planSync<D extends SyncDiscordItem, H extends SyncHarmonyItem>(input: {
  mode: SyncMode
  discord: D[]            // importable items
  presentIds?: string[]   // ids on Discord but not importable (unavailable): protected
  harmony: H[]
  differs: (d: D, h: H) => boolean
}): SyncPlan<D, H>
export function syncReportLines<D, H>(plan: SyncPlan<D, H>, opts: {
  dryRun: boolean; label: (name: string) => string; noun: string   // e.g. 'sound'
}): string[]
```
Rules: linked (`h.discordId === d.id`) → `update` if `mode !== 'add' && differs`, else unchanged. Unlinked Discord item with unlinked Harmony items of the same lowercased name → `replace` (all of them) in mirror/merge, `skip` (first one) in add. Otherwise `add`. `delete` only in mirror: Harmony items not linked to a Discord id in `discord ∪ presentIds` and not already in a `replace`. Harmony items linked to a `presentIds` id are untouched. Each Harmony item appears in at most one bucket.

`syncReportLines` lists, per non-empty bucket, a heading with count (`Add`, `Update`, `Replace (same name on Harmony)`, `Delete`, `Skipped (name already on Harmony)`), then `  • label(name)` lines; dry-run headings say "Would …". Callers pass the result through `joinLinesWithinDiscordLimit` (`src/utils/discordMessage.ts`); cap each bucket at 20 entries with `  • …and N more`.

- [ ] **Step 1: Write failing tests** (one `it` each): adds new items in every mode; updates differing linked items in mirror and merge but not add; `treats case-insensitive name matches as collisions` (replace in mirror/merge, skip in add); mirror deletes Harmony-only and stale-linked items, merge/add delete nothing; items linked to `presentIds` are neither deleted nor updated; `never schedules one Harmony sound for two actions` (two Discord items named "a" vs one Harmony "A"; and two Harmony "a" vs one Discord "a" → both in one replace); `syncReportLines` dry-run says "Would add 1 sound" and truncates at 20 with "…and 5 more".
- [ ] **Step 2: Run** `npx vitest run test/expressionSync.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** `feat: generic Discord→Harmony sync planner`.

### Task B2: Harmony client + sound mapping

**Files:**
- Modify: `src/HarmonyClient.ts` (next to `importDiscordEmoji`, ~line 687)
- Create: `src/runtime/soundSync.ts`
- Test: `test/soundSync.test.ts`

**Interfaces — Consumes:** HTTP contract; B1 types. `rt.emojiLinks.harmonyFor(serverId, discordEmojiId): HarmonyServerEmoji | null`.
**Produces:**
```ts
// HarmonyClient
export interface HarmonyServerSound { id: string; name: string; emoji: string | null; emoji_id: string | null; volume: number | string; discord_sound_id: string | null }
getServerSounds(serverId: string): Promise<HarmonyServerSound[]>
importDiscordSound(serverId: string, sound: DesiredSound, update: boolean): Promise<HarmonyServerSound & { status: 'created' | 'existing' | 'updated' }>
deleteServerSound(serverId: string, soundId: string): Promise<void>
// soundSync.ts
export interface DiscordSoundInput { soundId: string; name: string; volume: number; emojiId: string | null; emojiName: string | null; available: boolean }
export interface DesiredSound { id: string /* Discord sound id */; name: string; volume: number; emoji: string | null; emojiId: string | null; hadUnimportedEmoji: boolean }
export function desiredSound(d: DiscordSoundInput, harmonyEmojiFor: (discordEmojiId: string) => string | null): DesiredSound
export function harmonySyncItem(row: HarmonyServerSound): SyncHarmonyItem & { row: HarmonyServerSound }
export function soundDiffers(d: DesiredSound, h: { row: HarmonyServerSound }): boolean
```
`desiredSound`: name trimmed; volume rounded to 2 decimals and clamped 0–1; `emojiId` set → `harmonyEmojiFor` result (emoji null), none → both null and `hadUnimportedEmoji: true`; `emojiId` null and `emojiName` → `emoji = emojiName`. `importDiscordSound` POSTs body `{ discord_sound_id, name, emoji, emoji_id, volume, update }` via `sendJson`; `deleteServerSound` uses `request` with DELETE and the same error handling as `sendJson` (throw `HarmonyHttpError`).

- [ ] **Step 1: Write failing tests:** `drops an unimported custom emoji instead of using its name`; maps a linked custom emoji to its Harmony id; unicode emoji passes through; `treats 0.5 and "0.50" as the same volume` (`soundDiffers` false); name change → differs; emoji link appearing later → differs; HarmonyClient `importDiscordSound` sends the exact body (mock `fetch` as other client tests do, e.g. `test/runtime.test.ts`/`test/serverEmojiLinks.test.ts` patterns).
- [ ] **Step 2: Run** `npx vitest run test/soundSync.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: Harmony soundboard client and Discord sound mapping`.

### Task B3: Confirm helper + `/bridge sync-sounds`

**Files:**
- Create: `src/runtime/confirmPrompt.ts`
- Modify: `src/runtime/commands.ts` (subcommand inside the `mode === 'v2'` block after `import-emojis`; switch case; `runBridgeSyncSounds`), `README.md` (command list near line 260), `TODO.md` (Completed + follow-ups list from the spec)
- Test: `test/commands.test.ts`, `test/syncSoundsCommand.test.ts`

**Interfaces — Consumes:** B1 `planSync`, `syncReportLines`, `SYNC_MODE_CHOICES`; B2 client + `desiredSound`/`harmonySyncItem`/`soundDiffers`.
**Produces:**
```ts
export async function confirmAction(command: ChatInputCommandInteraction, content: string, timeoutMs = 60_000): Promise<boolean>
```
`confirmAction`: `editReply({ content, components: [row(Confirm danger, Cancel secondary)] })` with custom ids carrying `command.id`; `awaitMessageComponent({ componentType: ComponentType.Button, filter: i => i.user.id === command.user.id, time })`; on press `i.update({ components: [] , content: … })`; timeout → `editReply({ content: 'Cancelled, nothing changed.', components: [] })`, false.

`runBridgeSyncSounds(rt, command)`: defer ephemeral → bridge lookup (as `runBridgeImportEmojis`) → `rt.harmony.getServerSounds` (HarmonyHttpError 404 → "Soundboard sync needs a newer Harmony (bridge soundboard endpoints).") → `guild.soundboardSounds.fetch()` (any throw aborts with an error reply; map discord.js `SoundboardSound` → `DiscordSoundInput`: `soundId`, `name`, `volume`, `emoji?.id ?? emojiId`, `emoji?.name ?? emojiName`, `available` — check the installed `discord.js` typings) → `rt.emojiLinks.ensure(serverId)` → plan → dry run: reply report, stop → nothing to do: "✅ Soundboard already matches." → deletes or replaces exist: `confirmAction` with the report; false → stop → apply: delete (`delete` + every `replace.harmony`), create (`add` + `replace.discord`, `update: false`), update (`update` with `update: true`). Per-item failures collected (`errorText`), `SOUND_LIMIT` hint "Harmony allows 48 sounds per server." → summary lines (counts + failures, first 15) + "Run `/bridge import-emojis` first to keep custom emoji on N sound(s)" when any `hadUnimportedEmoji` was applied.

- [ ] **Step 1: Write failing tests:** `commands.test.ts` — `sync-sounds` only in v2, with `mode` choices `mirror|merge|add` and `dry_run`. `syncSoundsCommand.test.ts` (fake interaction + fake `rt.harmony`; build with existing helpers in `test/fakeDiscord.ts` where they fit): dry run calls no write method; mirror with a Harmony-only sound asks confirm and, on cancel, writes nothing; on confirm deletes before creating; merge with nothing to delete never asks; 404 from `getServerSounds` gives the newer-Harmony message; Discord fetch failure writes nothing.
- [ ] **Step 2: Run** `npx vitest run test/commands.test.ts test/syncSoundsCommand.test.ts` → FAIL.
- [ ] **Step 3: Implement** helper, subcommand, handler; export `runBridgeSyncSounds` for the test.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` → all PASS.
- [ ] **Step 5: README** line: `/bridge sync-sounds`: modes, dry run, confirm, Harmony version note; **TODO.md**: completed item + spec follow-ups.
- [ ] **Step 6: Commit** `feat: /bridge sync-sounds`.

## After all tasks

Whole-branch review per repo, then PRs (Harmony PR to upstream `y4my4my4m/harmony`, bridge PR) only when the user asks and commits are signed.
