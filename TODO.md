# Discord Bridge - TODO

## High Priority

### Fix Supabase Realtime (replace polling)
Currently using polling for message edits/deletes because Supabase Realtime subscriptions time out:
```
📡 Message updates subscription: TIMED_OUT
📡 Message deletes subscription: TIMED_OUT
```

**Current workaround:** Bot-gateway polls the database every 2 seconds and compares cached content vs DB content.

**Proper fix needed:**
- [ ] Debug why Realtime subscriptions fail (check Supabase config, service role permissions)

### Message mapping persistence
- Mappings live in memory (LRU, 50k); Discord ids are also stored in Harmony message metadata and restored from the last 100 messages per paired channel at startup
- [ ] Edits/reactions on messages older than that window are not bridged after a restart

### From the 2.6.0 review
- [ ] A lookup in flight can store a miss after history import cleared it, so reactions and edits on that imported message are dropped for 10 minutes; a held delete replayed after a failed send can join such a lookup and be dropped (`lookupHarmonyCopy`: keep a generation per id, bumped by `forgetLookupMisses`)
- [ ] A sticker Harmony refuses (422 `STICKER_FILE`) keeps its planned slot at every sync, so stickers past the server's limit are never copied (`expressionSync.ts`, `commands.ts` sticker apply)
- [ ] Sync creates before it renames: a new item taking a renamed item's old name fails (23505), and name swaps never finish (`commands.ts` emoji and sticker apply order)
- [ ] Two Discord items of one name: the copy kept from a removed one holds the name and the other is skipped at every sync
- [ ] The sound report lists an applied rename as a clash; any Harmony sound of the same name blocks the copy
- [ ] A batch POST that times out (120 s) is retried while the gateway still mirrors its files, so two copies download at once (`historyImport.ts` harmonyCall); dedupe keeps one row
- [ ] An import disarmed by a 403 arms again only when the configuration changes
- [ ] `/bridge-privacy opt-in` ends a pending erase the user asked for without saying so
- [ ] `/bridge-privacy erase` answers 429 `erase_recent` with a one-second wait in its message
- [ ] A reaction refused with 403 `BRIDGE_AUTHOR_OPTED_OUT` logs an error per reaction and does not add the author to the opt-out list
- [ ] The import status shows the raw codes `server_purged`, `instance_purged` and `invalid_batch` (`importErrorText`)
- [ ] `publish.yml` grants `packages: write` at workflow level, so the test job that runs `npm ci` holds it; `ci.yml` has no `permissions` block
- [ ] Two Harmony servers bridging one guild: an opt-out reaches only the bridge where the member ran it
- [ ] An opt-out added from a refusal (403, an import `opted_out`) can outlast a manager's restore when `privacy_version` (`count:max(created_at)`) returns to an earlier value: the list is not read again; a refusal should trigger a read, and the version should only move forward
- [ ] An origin mark evicted from `harmonyOriginCopies` while the mapping stays lets a Discord delete of the Harmony message's copy, arriving as a partial, delete the Harmony original (only with `manage_messages`); keep the origin flag in the mapping itself
- [ ] An emoji a person restored keeps the id of its deleted Discord emoji: a Harmony reaction with it fails on Discord and logs an error each time
- [ ] Editing an old message whose sticker was renamed on Discord and then retired sends the sticker's current name, which Harmony's sticker check does not find in the stored message; the edit falls back to a Discord CDN link
- [ ] The import notice can be posted twice in one job when the run pauses before the first page sets the start marker and the bot cannot pin

---

## Medium Priority

### Improve edit/delete tracking
- [ ] Current 72h/10k message cache is arbitrary - consider making configurable
- [ ] Add metrics/logging for cache hit rate
- [ ] Handle edge case: message edited while bridge was offline

### Thread/Reply support
- [x] Bridge Discord threads to Harmony threads and back (2.4.0)
- [x] Thread notices name their starter on both sides (2.4.1)
- [ ] Thread renames, archiving and deletion are not mirrored

### Attachment handling notes
- Discord CDN URLs in messages expire (~24–72h); Discord has no permanent public link
- [ ] On-demand proxy (stream from Discord at view time, no storage) vs optional mirror
- [ ] Store attachment IDs + refresh URL from Discord API when loading old messages

---

## Low Priority / Nice to Have

### Performance
- [ ] Batch Discord webhook calls if multiple Harmony messages arrive quickly

### Features
- [ ] Bridge Discord embeds to Harmony (link previews)
- [ ] Bridge Harmony link previews to Discord embeds
- [ ] Support Discord stickers
- [ ] Bridge Discord slash commands other than `/m`
- [ ] Expression/server sync follow-ups (reuse `expressionSync.ts` modes, dry run, confirm):
  - [x] `/bridge sync-emojis` (`import-emojis` is now `mode:add`, with the old import as fallback on an older Harmony)
  - [x] `/bridge sync-stickers` (Lottie, names under 2 characters and refused files are skipped and listed)
  - [ ] Server profile sync (name, icon, banner, description)
  - [ ] Channel details sync (topic, slowmode, NSFW on linked channels)
  - [ ] Scheduled events, if Harmony gains them

### Monitoring
- [ ] Expose metrics (messages bridged, errors, latency)

---

## Completed ✓

- [x] Bi-directional message bridging
- [x] User mentions (both directions)
- [x] Discord user autocomplete via `/m` slash command
- [x] Reaction bridging (Discord → Harmony with user attribution)
- [x] Reaction bridging (Harmony → Discord; bot-gateway now emits MESSAGE_REACTION_ADD/REMOVE)
- [x] Custom emoji bridging
- [x] `/bridge sync-sounds`: Discord soundboard to Harmony (merge/mirror/add, dry run, Confirm/Cancel before deletes)
- [x] Media/attachment bridging
- [x] Webhook puppeting (Harmony users appear with their name/avatar in Discord)
- [x] Discord users in Harmony autosuggest
- [x] Message edits (Harmony → Discord via polling, checks newest 100 messages)
- [x] Message deletes (Harmony → Discord via polling, detects soft-delete flag)
- [x] Message edits (Discord → Harmony)
- [x] Message deletes (Discord → Harmony)
- [x] `/health` endpoint; status heartbeat with problem codes to Harmony (v2)
- [x] Bounded retry honoring Retry-After for Harmony and Discord REST
- [x] Long Harmony messages split across several Discord messages

