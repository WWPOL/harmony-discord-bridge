import type { HostedEntry } from './BridgeApi.js'
import type { HealthReport } from '../health.js'
import type { LogLevel } from '../log.js'

/** workerData of one own-bot hosted bridge (hostedWorker.ts). Structured-cloned into the thread. */
export interface HostedWorkerData {
  entry: HostedEntry
  apiBase: string
  gatewayUrl: string
  baseUrl: string | null
  dataDir: string
  appEmojiDir: string
  logLevel: LogLevel
  version: string
  /** Period of the worker's health messages, ms. */
  healthIntervalMs: number
}

/** Main thread → worker. */
export type ToWorker = { type: 'stop' }

/**
 * Worker → main thread. `started` / `start-failed` answer V2Bridge.start() once;
 * `health` repeats every healthIntervalMs. The worker exits after `stop`.
 */
export type FromWorker =
  | { type: 'started' }
  | { type: 'start-failed'; error: string }
  | { type: 'health'; report: HealthReport }
