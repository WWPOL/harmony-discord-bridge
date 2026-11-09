# Soundboard sync (Discord → Harmony): design

Date: 2026-11-09
Repos: `harmony-discord-bridge` (this repo) and Harmony (`brapmony`, upstream `y4my4my4m/harmony`). One PR each.

## Intent

The bridge already copies a Discord server's channels, roles and custom emoji into its paired
Harmony server. The soundboard should come over too, and stay in step on demand: an admin runs one
command and Harmony's soundboard is made to match Discord's. Discord is the source of truth, but an
admin can choose to keep Harmony-side additions.

The sync modes and the dry-run/confirm flow are meant to become the shared pattern for every
"sync X from Discord" command (emoji, stickers, …), not a soundboard one-off.

## Goals

- `/bridge sync-sounds` brings Discord guild soundboard sounds into the paired Harmony server.
- A rerun applies what changed on Discord since the last run.
- Three modes (choice option `mode`, default `mirror`):

  | Mode       | Adds new | Updates changed | Deletes Harmony sounds not on Discord |
  |------------|----------|-----------------|---------------------------------------|
  | `mirror`   | yes      | yes             | yes, **including sounds uploaded on Harmony only** |
  | `merge`    | yes      | yes             | no                                    |
  | `add`      | yes      | no              | no                                    |

- `dry_run: true` reports the add / update / delete lists and changes nothing.
- A real run that would delete anything first shows the delete list with **Confirm** / **Cancel**
  buttons; with nothing to delete it runs straight away.

## Non-goals

- Live sync (gateway soundboard events). Sync happens only when the command runs.
- Harmony → Discord direction.
- Building the emoji/sticker/other syncs now (see Follow-ups); only making the pattern reusable.
- Changing `/bridge import-emojis` in this work.

## Anti-goals

- Harmony fetching audio from a URL the bot supplies. Harmony downloads only from Discord's CDN,
  by sound id, as emoji import does.
- An accidental default run silently wiping Harmony-only sounds (hence the confirmation).
- A rerun creating a duplicate of a sound already imported.

## Constraints (verified)

**Discord** (`GET /guilds/{guild.id}/soundboard-sounds`; discord.js `guild.soundboardSounds.fetch()`,
discord.js ^14.27): each sound has `sound_id`, `name` (2–32), `volume` (0–1), `emoji_id` /
`emoji_name`, `available`. Audio at `https://cdn.discordapp.com/soundboard-sounds/{sound_id}`,
mp3 or ogg, ≤512 KB, ≤5.2 s. The audio of an existing sound cannot be replaced, so "changed" means
name, volume or emoji only. No gateway intent is needed for the REST fetch. Discord does not return
duration.

**Harmony** (`public.server_sounds`, migrations `20261011300001_soundboard.sql`,
`20261016100002_soundboard_custom_emoji.sql`): columns `name` (1–32, trimmed), `emoji` (unicode,
1–16 chars) xor `emoji_id` (uuid → `emojis`), `volume` numeric(3,2) 0–1, `duration_ms` NOT NULL
1–5200, `storage_path` `{server_id}/{uuid}.{mp3|ogg|wav}` in bucket `soundboard` (public, 512 KB,
audio/mpeg|ogg|wav), max 48 per server (trigger `enforce_server_sound_limit`). Other servers can
play a server's sounds when `allow_cross_server_sounds` is on; deleting a sound removes it for them
too (accepted).

**Bridge**: `/bridge` subcommands require Discord Administrator; Harmony bridge-write endpoints
accept only the bot of the server's `discord_bridges` row, so this is a v2-only subcommand like
`import-emojis`.

## Approaches considered

- **A. Mirror the emoji import (chosen).** Harmony gets a bridge-only endpoint + SECURITY DEFINER
  RPC and a `discord_sound_id` link column; bot-gateway downloads the clip from Discord's CDN
  itself. Matches a pattern upstream already accepted; Harmony never trusts bot-supplied bytes.
- **B. Generic bot "upload a sound" endpoint.** Reusable by other bots, but Harmony would have to
  validate arbitrary audio from bots: larger attack surface, harder upstream sell. Rejected.
- **C. A + live sync via gateway events.** Rejected by the user: sync should happen when an admin
  reruns the command, not continuously.

## Design

### Harmony (`brapmony`)

1. **Migration** `db_schema/migrations/<ts>_bridge_server_sounds.sql`:
   - `server_sounds.discord_sound_id text`, check `^[0-9]{1,20}$`, unique `(server_id,
     discord_sound_id) WHERE discord_sound_id IS NOT NULL`.
   - `bridge_import_server_sound(p_bot_id, p_server_id, p_discord_sound_id, p_name, p_emoji,
     p_emoji_id, p_volume, p_storage_path, p_duration_ms)` → `(status, id, name, emoji, emoji_id,
     volume, discord_sound_id)`. Bridge-bot check as in `bridge_import_server_emoji` (42501).
     Outcomes:
     - `existing` / `updated`: row with this `discord_sound_id` exists; name/emoji/emoji_id/volume
       are set to the given values when they differ (`updated`), else `existing`.
     - Same-name collisions (an unlinked Harmony sound whose name matches case-insensitively) are
       not linked: audio can't be compared cheaply, and Discord is the source of truth. The
       bridge plans them as **replace** in `mirror`/`merge` (delete the Harmony sound, then create
       from Discord) and **skip** in `add`. Several unlinked same-name sounds: all are replaced.
       The RPC therefore has no `linked` outcome.
     - `created`: needs `p_storage_path` + `p_duration_ms` (gateway stored the file); without them
       the RPC raises `invalid sound file` (22023) so the gateway knows to download, same two-step
       as emoji import.
     - `p_update false` (for `add` mode) returns an `existing` row unchanged.
   - `bridge_delete_server_sound(p_bot_id, p_server_id, p_sound_id)` → storage_path of the deleted
     row (any sound of that server, Discord-linked or not). Bridge-bot check.
   - `bridge_list_server_sounds` is not needed if a list endpoint reads the table with
     service_role; follow whichever the gateway's emoji list does.
   - pgTAP test in `db_schema/tests/` alongside `116_soundboard.sql`.
2. **bot-gateway** (`BotRestAPI.ts`, new `utils/discordSoundImport.ts` modeled on
   `discordEmojiImport.ts`):
   - `GET /servers/:serverId/sounds` → rows incl. `discord_sound_id` (bridge bot only).
   - `POST /servers/:serverId/sounds/discord` body `{ discord_sound_id, name, emoji | emoji_id,
     volume, update }` → row + `status`; 201 on `created`.
   - `DELETE /servers/:serverId/sounds/:soundId` → 204; removes the storage object after the row.
   - Download: `cdn.discordapp.com/soundboard-sounds/{id}`, content-type audio/mpeg or audio/ogg,
     1 B–512 KB; read duration from the file headers (small parser dependency, e.g.
     `music-metadata`, or a hand-rolled mp3/ogg frame reader — builder's call); refuse >5200 ms;
     store at `{server_id}/{uuid}.{mp3|ogg}`; remove the object if the RPC then fails.
   - Status codes: 201 `created`, 200 for `existing` / `updated`. `created_by` is left
     NULL (bridge rows are identified by `discord_sound_id` and the bot-action log).
   - Each create/update/delete logs a bot action (`sound_imported`, `sound_updated`,
     `sound_deleted`).
   - Docs: bridge section of `docs/` mentions the endpoints; CHANGELOG entry.

### Bridge (this repo)

1. **`HarmonyClient`**: `getServerSounds`, `importDiscordSound`, `deleteServerSound`.
2. **Reusable sync core** `src/runtime/expressionSync.ts`:
   - `type SyncMode = 'mirror' | 'merge' | 'add'`.
   - `planSync({ discord, harmony, key, linkKey, differs, mode })` → `{ add, update, replace,
     skip, delete, unchanged }`, pure and unit-tested. Matching: by Discord id link first; an
     unlinked Harmony item with the same name (case-insensitive) becomes `replace` in
     mirror/merge or `skip` in add. A rerun of any mode never duplicates, because imported
     sounds carry `discord_sound_id`.
   - `renderSyncReport(...)` for dry-run and final summaries (shared wording).
   - `confirmDeletes(command, items)`: ephemeral Confirm/Cancel buttons via
     `awaitMessageComponent` on the reply, 60 s timeout = cancel; only the invoking user can press.
3. **`/bridge sync-sounds`** (v2 only), options `mode` (choices Mirror/Merge/Add, default mirror),
   `dry_run`. Flow: fetch Discord sounds (skip `available === false`) + Harmony sounds → plan →
   dry run reports and stops → if deletes, confirm → apply deletes first (frees slots under the
   48 cap), then adds/updates (via import endpoint) → summary with per-item failures, like import-emojis.
   - Emoji mapping: Discord `emoji_id` set → the linked Harmony emoji id via `rt.emojiLinks`, else
     no emoji (report hints at `import-emojis`; `emoji_name` is then the custom emoji's text name,
     never used as unicode). `emoji_id` null → `emoji_name` as unicode `emoji`. A sound whose
     custom emoji was imported since the last run counts as changed.
   - Discord sounds with `available === false` are not imported but count as present, so mirror
     never deletes their Harmony copy. A failed Discord fetch aborts the run; a genuinely empty
     Discord soundboard goes through the normal confirm, which lists every delete.
   - Version gate: probe `GET /servers/:id/sounds` first; a 404 there means Harmony is too old.
   - Long dry-run / confirm lists are truncated with "…and N more" (Discord 2000-char limit).
     Confirm timeout (60 s) edits the reply to "Cancelled, nothing changed".
   - Name: Discord names are 2–32 already; trim.
   - 48-cap: Harmony refusals are reported per item, not fatal.
   - Older Harmony (404 on the endpoint): one clear "needs Harmony ≥ X" message.
4. README command list, TODO entry, tests mirroring `test/commands.test.ts` with `fakeDiscord.ts`.

## Left to the builder

- Duration parser choice; exact migration timestamp; Harmony version number in messages.

## Follow-ups (planned, not built here)

Each reuses `expressionSync.ts` modes, dry run and confirm:
- **Emoji sync** — `/bridge sync-emojis`; `import-emojis` becomes an alias for `mode:add` or is
  retired. Needs Harmony update/delete for bridge emoji (Harmony has emoji lifecycle since 1.9.4).
- **Stickers** — Harmony server stickers (cap 15 default, alt text required, png/apng/webp/gif);
  Discord Lottie stickers are not importable.
- **Server profile** — name, icon, banner, description.
- **Channel details** — topic, slowmode, NSFW on linked channels.
- **Thread renames/archiving** (already in TODO).
- Scheduled events, if Harmony gains them.
