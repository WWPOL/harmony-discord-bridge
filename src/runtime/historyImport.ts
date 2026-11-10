import type { Message as DiscordMessage } from 'discord.js'
import { BridgeApiError, type BridgeApi, type ImportJob, type ImportMessage } from '../v2/BridgeApi.js'
import { errorText, type Logger } from '../log.js'

export type ImportResult = 'done' | 'cancelled' | 'failed' | 'paused'

export interface HistoryImporterDeps {
  api: Pick<BridgeApi, 'updateImport' | 'postImportMessages' | 'importThread' | 'linkImportReplies' | 'listImports'>
  /** One page of a channel's history, newest first, at most 100; `before` is exclusive. */
  fetchPage(channelId: string, before: string | undefined): Promise<DiscordMessage[]>
  /** Ids of the channel's pinned messages. */
  fetchPins(channelId: string): Promise<Set<string>>
  translate(msg: DiscordMessage): Promise<Omit<ImportMessage, 'thread_id' | 'pinned'> | null>
  pageDelayMs: number
  sleep?: (ms: number) => Promise<void>
  log: Logger
}

const DISCORD_EPOCH_MS = 1420070400000n
/** Missing access, missing permissions, unknown channel: Discord history is gone for good. */
const ACCESS_LOST_CODES = new Set([50001, 50013, 10003])
/** Backoff before each retry of a transient failure; the call is made once more after each wait. */
const RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000]

/** Unwinds run() with its result. */
class Stop extends Error {
  constructor(readonly result: ImportResult) {
    super(`import stopped: ${result}`)
  }
}

const snowflakeTime = (id: string) => new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS))

/** Transient Harmony failure: network error, timeout, 5xx, or a 429 that survived the client's own retry. */
function isTransientApiError(error: unknown): boolean {
  if (!(error instanceof BridgeApiError)) return true
  return error.status >= 500 || error.status === 429
}

/** Copies Discord history into a Harmony channel through the bridge import API. */
export class HistoryImporter {
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: HistoryImporterDeps) {
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /**
   * Runs one job to the end of its messages phase. Resumable: progress is read from the job's
   * `reached_discord_message_id`. Returns 'paused' when the scheduler should pick the job up again
   * later (abort, or retries exhausted), 'failed' when the job is over, 'cancelled' on request.
   */
  async run(job: ImportJob, signal: AbortSignal): Promise<ImportResult> {
    const state = { ...job }
    try {
      return await this.messagesPhase(state, signal)
    } catch (error) {
      if (error instanceof Stop) return error.result
      this.deps.log.error(`History import ${job.id} crashed: ${errorText(error)}`)
      await this.bestEffortPatch(job.id, { state: 'paused' })
      return 'paused'
    }
  }

  private async messagesPhase(job: ImportJob, signal: AbortSignal): Promise<ImportResult> {
    const { api, log } = this.deps
    const channelId = job.discord_channel_id

    // Always: a no-op for a job left 'running' by a crash, a transition for queued/paused.
    await this.patch(job, { state: 'running' })
    if (job.cancel_requested) return this.cancel(job)

    const pins = await this.discordCall(job, signal, () => this.deps.fetchPins(channelId))

    let before = job.reached_discord_message_id ?? undefined
    for (;;) {
      if (signal.aborted) return this.pause(job)

      const raw = await this.discordCall(job, signal, () => this.deps.fetchPage(channelId, before))
      if (raw.length === 0) break
      // Newest first, whatever order the fetcher produced.
      const page = [...raw].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0))

      if (!job.start_discord_message_id) {
        const newest = page[0]
        const patch = {
          start_discord_message_id: newest.id,
          start_at: newest.createdAt.toISOString(),
          channel_created_at: snowflakeTime(channelId).toISOString(),
        }
        await this.patch(job, patch)
        Object.assign(job, patch)
      }

      const batch: ImportMessage[] = []
      for (const msg of page) {
        let translated: Awaited<ReturnType<HistoryImporterDeps['translate']>>
        try {
          translated = await this.deps.translate(msg)
        } catch (error) {
          log.warn(`History import ${job.id}: skipping Discord message ${msg.id}, translation failed: ${errorText(error)}`)
          continue
        }
        if (translated) batch.push({ ...translated, pinned: pins.has(msg.id) })
      }
      if (batch.length > 0) {
        // `skipped` mixes empty and already-present ids; it says nothing about progress.
        await this.harmonyCall(job, signal, () => api.postImportMessages(job.id, batch))
      }

      const oldest = page[page.length - 1]
      const reached = { reached_discord_message_id: oldest.id, reached_at: oldest.createdAt.toISOString() }
      await this.patch(job, reached, signal)
      Object.assign(job, reached)
      before = oldest.id

      if (signal.aborted) return this.pause(job)
      await this.sleep(this.deps.pageDelayMs)
      if (signal.aborted) return this.pause(job)

      const latest = (await this.harmonyCall(job, signal, () => api.listImports())).find(j => j.id === job.id)
      if (!latest || latest.cancel_requested) return this.cancel(job)
    }

    // B3 replaces this hand-off: after the messages phase it runs the threads and replies phases
    // within this same run(), and only then finishes the job. Until then the messages phase ends
    // with the phase switched to 'threads' and reports 'done'.
    await this.patch(job, { phase: 'threads' })
    return 'done'
  }

  private async cancel(job: ImportJob): Promise<ImportResult> {
    await this.bestEffortPatch(job.id, { state: 'cancelled' })
    return 'cancelled'
  }

  private async pause(job: ImportJob): Promise<ImportResult> {
    await this.bestEffortPatch(job.id, { state: 'paused' })
    return 'paused'
  }

  private async bestEffortPatch(id: string, patch: Partial<ImportJob>): Promise<void> {
    try {
      await this.deps.api.updateImport(id, patch)
    } catch (error) {
      this.deps.log.warn(`History import ${id}: could not PATCH ${JSON.stringify(patch)}: ${errorText(error)}`)
    }
  }

  private patch(job: ImportJob, patch: Partial<ImportJob>, signal?: AbortSignal): Promise<unknown> {
    return this.harmonyCall(job, signal, () => this.deps.api.updateImport(job.id, patch))
  }

  /**
   * One Harmony call with the retry policy: transient failures are retried after 1s, 2s, 4s, 8s,
   * 16s, then the job is paused for the scheduler. 409: the server already stopped the job, so
   * 'failed' with no PATCH. Any other 4xx is not retried and fails the job.
   */
  private async harmonyCall<T>(job: ImportJob, signal: AbortSignal | undefined, call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call()
      } catch (error) {
        if (error instanceof BridgeApiError && error.status === 409) {
          this.deps.log.warn(`History import ${job.id}: stopped by the server (${error.code ?? 409})`)
          throw new Stop('failed')
        }
        if (!isTransientApiError(error)) {
          this.deps.log.error(`History import ${job.id}: Harmony rejected a request: ${errorText(error)}`)
          await this.bestEffortPatch(job.id, { state: 'failed', error: `harmony_${(error as BridgeApiError).status}` })
          throw new Stop('failed')
        }
        await this.backoffOrPause(job, signal, attempt, error)
      }
    }
  }

  /**
   * One Discord read. Lost access fails the job; other errors are retried with the same backoff,
   * then the job is paused.
   */
  private async discordCall<T>(job: ImportJob, signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call()
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        if (typeof code === 'number' && ACCESS_LOST_CODES.has(code)) {
          this.deps.log.warn(`History import ${job.id}: Discord access lost (${code})`)
          await this.bestEffortPatch(job.id, { state: 'failed', error: 'discord_access_lost' })
          throw new Stop('failed')
        }
        await this.backoffOrPause(job, signal, attempt, error)
      }
    }
  }

  private async backoffOrPause(job: ImportJob, signal: AbortSignal | undefined, attempt: number, error: unknown): Promise<void> {
    if (signal?.aborted || attempt >= RETRY_BACKOFF_MS.length) {
      this.deps.log.warn(`History import ${job.id}: pausing after repeated failures: ${errorText(error)}`)
      await this.bestEffortPatch(job.id, { state: 'paused' })
      throw new Stop('paused')
    }
    this.deps.log.warn(`History import ${job.id}: transient failure, retry ${attempt + 1}/${RETRY_BACKOFF_MS.length}: ${errorText(error)}`)
    await this.sleep(RETRY_BACKOFF_MS[attempt])
  }
}
