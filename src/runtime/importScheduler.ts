import type { BridgeApi, ImportJob } from '../v2/BridgeApi.js'
import type { ImportResult } from './historyImport.js'
import { errorText, type Logger } from '../log.js'
import type { Problem, ProblemCode } from '../problems.js'

/** Counting semaphore shared by every bridge of one process: BRIDGE_IMPORT_CONCURRENCY imports at once. */
export class ImportSlots {
  private free: number
  private readonly waiters: { grant: () => void }[] = []

  constructor(max: number) {
    this.free = Math.max(1, Math.floor(max))
  }

  /** Resolves with a release function (idempotent). Rejects, leaving the queue, when `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'))
      const take = () => {
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.release()
        })
      }
      if (this.free > 0) {
        this.free--
        return take()
      }
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new Error('aborted'))
      }
      const waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort)
          take()
        },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private release() {
    const next = this.waiters.shift()
    if (next) next.grant()
    else this.free++
  }
}

export interface ImportSchedulerDeps {
  api: Pick<BridgeApi, 'listImports'>
  importer: { run(job: ImportJob, signal: AbortSignal): Promise<ImportResult> }
  slots: ImportSlots
  pollMs: number
  /** Whether the Message Content intent is on. Without it Discord returns empty history. */
  intentsOk(): boolean
  /** Whether Discord is connected; jobs wait (silently) until it is. Default: always. */
  ready?(): boolean
  /**
   * Problems of this bridge raised by imports. `clear()` with no code drops all of them (the job
   * that raised them is over, or none is queued).
   */
  problems?: { raise(problem: Problem): void; clear(code?: ProblemCode): void }
  log?: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
}

const PRIORITY: Partial<Record<ImportJob['state'], number>> = { running: 0, paused: 1, queued: 2 }

/** Picks the job to work on: `running` (left by a crash), then `paused`, then `queued` by creation time. */
function nextJob(jobs: ImportJob[]): ImportJob | null {
  const pending = jobs.filter(j => PRIORITY[j.state] !== undefined)
  pending.sort((a, b) =>
    PRIORITY[a.state]! - PRIORITY[b.state]!
    || Date.parse(a.created_at) - Date.parse(b.created_at)
    || a.id.localeCompare(b.id))
  return pending[0] ?? null
}

/**
 * Runs one history import at a time for one bridge. Polls GET /imports; a job also needs a free
 * slot of the process-wide ImportSlots before it starts.
 */
export class ImportScheduler {
  private timer: NodeJS.Timeout | null = null
  private current: Promise<void> | null = null
  private polling = false
  private abort: AbortController | null = null
  private stopped = true
  private lastPollError = ''

  constructor(private readonly deps: ImportSchedulerDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.timer = setInterval(() => this.kick(), this.deps.pollMs)
    this.timer.unref?.()
    this.kick()
  }

  /** Aborts the running job (the importer patches it `paused`) and waits for it. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.abort?.abort()
    await this.current
  }

  /** Polls now instead of at the next interval. */
  kick(): void {
    if (this.stopped || this.polling || this.current) return
    this.polling = true
    void this.poll().finally(() => { this.polling = false })
  }

  private async poll(): Promise<void> {
    const { api, problems, log } = this.deps
    let jobs: ImportJob[]
    try {
      jobs = await api.listImports()
      this.lastPollError = ''
    } catch (err) {
      const line = errorText(err)
      if (line !== this.lastPollError) {
        this.lastPollError = line
        log?.debug(`History import poll failed: ${line}`)
      }
      return
    }
    if (this.stopped || this.current) return

    const job = nextJob(jobs)
    if (!job) {
      problems?.clear()
      return
    }
    if (this.deps.ready && !this.deps.ready()) return
    if (!this.deps.intentsOk()) {
      problems?.raise({ code: 'message_content_needed_for_import' })
      return
    }
    problems?.clear('message_content_needed_for_import')

    const abort = new AbortController()
    this.abort = abort
    this.current = this.runJob(job, abort.signal).finally(() => {
      this.current = null
      this.abort = null
    })
  }

  private async runJob(first: ImportJob, signal: AbortSignal): Promise<void> {
    const { api, importer, slots, problems, log } = this.deps
    let release: (() => void) | null = null
    let result: ImportResult | null = null
    try {
      release = await slots.acquire(signal)
      // The wait for a slot can be long; the job may have been cancelled or changed meanwhile.
      const fresh = (await api.listImports()).find(j => j.id === first.id)
      if (!fresh || PRIORITY[fresh.state] === undefined || signal.aborted) return
      result = await importer.run(fresh, signal)
      log?.info(`History import ${first.id}: ${result}`)
    } catch (err) {
      if (!signal.aborted) log?.warn(`History import ${first.id} could not run: ${errorText(err)}`)
    } finally {
      release?.()
    }
    // Over for good: the problems it raised no longer apply. A paused job resumes and keeps them.
    if (result === 'done' || result === 'failed' || result === 'cancelled') problems?.clear()
    if (result && result !== 'paused' && !signal.aborted) setImmediate(() => this.kick())
  }
}
