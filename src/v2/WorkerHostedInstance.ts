import { Worker } from 'worker_threads'
import type { HostedInstance } from './HostRunner.js'
import type { FromWorker, ToWorker } from './hostedWorkerProtocol.js'
import type { HealthReport } from '../health.js'
import { Backoff } from '../http.js'
import { Logger, errorText } from '../log.js'

export interface WorkerHostedInstanceOptions {
  /** Script run in the thread; speaks hostedWorkerProtocol. */
  workerUrl: URL
  workerData: unknown
  /** V8 old-generation limit of the thread, MB. Past it V8 ends the thread, not the process. */
  heapMb: number
  log: Logger
  /** Crash restart delay: doubles from baseMs to maxMs; resets after a run of stableMs. */
  restart?: { baseMs: number; maxMs: number; stableMs: number }
  /** After `stop`, the thread is terminated if still running past this. */
  stopTimeoutMs?: number
  /** Health older than this reports unhealthy. */
  healthStaleMs?: number
  /** Health older than this ends the thread and restarts it: its event loop is blocked. */
  hangMs?: number
  now?: () => number
}

const DEFAULTS = {
  restart: { baseMs: 5_000, maxMs: 5 * 60_000, stableMs: 10 * 60_000 },
  stopTimeoutMs: 8_000,
  healthStaleMs: 30_000,
  hangMs: 120_000,
}

/** Thread exit before `started`; the crash path has already logged it. */
class WorkerEndedError extends Error {}

/**
 * One own-bot hosted bridge in a worker thread (hostedWorker.ts). A thread
 * that runs out of heap, throws, or stops answering ends alone and restarts
 * with backoff; the host process and every other bridge keep running.
 */
export class WorkerHostedInstance implements HostedInstance {
  private worker: Worker | null = null
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private restarts = 0
  private lastExit: { at: string; reason: string } | null = null
  private lastHealth: HealthReport | null = null
  private lastHealthAt = 0
  private spawnedAt = 0
  /** Ends the current thread as hung; set per spawn. */
  private endHung: ((ageMs: number) => void) | null = null
  private readonly backoff: Backoff
  private readonly restartOpts: { baseMs: number; maxMs: number; stableMs: number }
  private readonly stopTimeoutMs: number
  private readonly healthStaleMs: number
  private readonly hangMs: number
  private readonly now: () => number

  constructor(private readonly opts: WorkerHostedInstanceOptions) {
    this.restartOpts = opts.restart ?? DEFAULTS.restart
    this.stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs
    this.healthStaleMs = opts.healthStaleMs ?? DEFAULTS.healthStaleMs
    this.hangMs = opts.hangMs ?? DEFAULTS.hangMs
    this.now = opts.now ?? Date.now
    this.backoff = new Backoff(this.restartOpts.baseMs, this.restartOpts.maxMs)
  }

  async start(): Promise<void> {
    this.stopping = false
    this.watchdog ??= setInterval(() => this.checkHang(), Math.max(1_000, Math.min(this.healthStaleMs, this.hangMs) / 2))
    this.watchdog.unref()
    return this.spawn()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.watchdog) clearInterval(this.watchdog)
    this.restartTimer = this.watchdog = null
    const worker = this.worker
    if (!worker) return
    const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()))
    worker.postMessage({ type: 'stop' } satisfies ToWorker)
    const kill = setTimeout(() => {
      this.opts.log.warn(`Hosted bridge worker did not stop within ${Math.round(this.stopTimeoutMs / 1000)} s; terminating it`)
      void worker.terminate()
    }, this.stopTimeoutMs)
    await exited
    clearTimeout(kill)
  }

  health(): HealthReport {
    const isolation = {
      isolation: 'worker',
      heap_limit_mb: this.opts.heapMb,
      restarts: this.restarts,
      last_exit: this.lastExit,
    }
    if (!this.worker) return { ok: false, body: { state: this.stopping ? 'stopped' : 'restarting', ...isolation } }
    if (!this.lastHealth) return { ok: false, body: { state: 'starting', ...isolation } }
    const age = this.now() - this.lastHealthAt
    if (age > this.healthStaleMs) {
      return { ok: false, body: { ...this.lastHealth.body, state: 'unresponsive', health_age_s: Math.round(age / 1000), ...isolation } }
    }
    return { ok: this.lastHealth.ok, body: { ...this.lastHealth.body, ...isolation } }
  }

  private spawn(): Promise<void> {
    const { heapMb } = this.opts
    this.spawnedAt = this.now()
    let worker: Worker
    try {
      worker = new Worker(this.opts.workerUrl, {
        workerData: this.opts.workerData,
        resourceLimits: { maxOldGenerationSizeMb: heapMb },
      })
    } catch (err) {
      const reason = `thread not created (${errorText(err)})`
      this.scheduleRestart(reason)
      return Promise.reject(new WorkerEndedError(reason))
    }
    this.worker = worker
    this.lastHealth = null
    this.lastHealthAt = 0
    let outOfMemory = false
    let failure: string | null = null
    let hungFor: number | null = null
    this.endHung = (ageMs) => {
      hungFor = ageMs
      void worker.terminate()
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (err?: Error) => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }
      worker.on('message', (msg: FromWorker) => {
        if (msg?.type === 'health') {
          this.lastHealth = msg.report
          this.lastHealthAt = this.now()
        } else if (msg?.type === 'started') {
          settle()
        } else if (msg?.type === 'start-failed') {
          settle(new Error(msg.error))
        }
      })
      worker.on('error', (err: Error & { code?: string }) => {
        if (err.code === 'ERR_WORKER_OUT_OF_MEMORY') outOfMemory = true
        else failure = errorText(err)
      })
      worker.on('exit', (code) => {
        if (this.worker === worker) {
          this.worker = null
          this.endHung = null
        }
        const reason = outOfMemory
          ? `out of memory (heap limit ${heapMb} MB)`
          : hungFor !== null
            ? `unresponsive for ${Math.round(hungFor / 1000)} s`
            : failure ?? `exit code ${code}`
        if (this.stopping) {
          settle()
          return
        }
        this.scheduleRestart(reason)
        settle(new WorkerEndedError(`worker ended before start: ${reason}`))
      })
    })
  }

  private scheduleRestart(reason: string) {
    const { log } = this.opts
    this.lastExit = { at: new Date(this.now()).toISOString(), reason }
    this.lastHealth = null
    if (this.now() - this.spawnedAt >= this.restartOpts.stableMs) this.backoff.reset()
    const delay = this.backoff.next()
    log.error(`Hosted bridge worker ended: ${reason}. Restarting in ${Math.round(delay / 1000)} s; other bridges keep running.`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      this.restarts++
      this.spawn().catch(err => {
        if (!(err instanceof WorkerEndedError)) log.error(`Hosted bridge failed to start: ${errorText(err)}`)
      })
    }, delay)
  }

  /** Ends a thread whose health stopped arriving; its exit handler restarts it. */
  private checkHang() {
    if (!this.worker || this.stopping || this.lastHealthAt === 0) return
    const age = this.now() - this.lastHealthAt
    if (age > this.hangMs) this.endHung?.(age)
  }
}
