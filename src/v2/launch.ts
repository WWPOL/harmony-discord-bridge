import { mkdirSync } from 'fs'
import { join } from 'path'
import { BridgeApi, type HostedEntry } from './BridgeApi.js'
import { CredentialsError, obtainCredentials, type StoredCredentials } from './credentials.js'
import { EndpointError, endpointsFor, probeEndpoints, type HarmonyEndpoints } from './endpoints.js'
import { HostRunner, type HostedInstance } from './HostRunner.js'
import { InstanceHost } from './InstanceHost.js'
import { V2Bridge, type V2ImportOptions } from './V2Bridge.js'
import { WorkerHostedInstance } from './WorkerHostedInstance.js'
import { HOSTED_AUTH_HINT, HOSTED_DISCORD_TOKEN_HINT, SELF_AUTH_HINT } from './hints.js'
import type { HostedWorkerData } from './hostedWorkerProtocol.js'
import { DEFAULT_HOSTED_ISOLATION, DEFAULT_IMPORT_SETTINGS, type HostedIsolation, type ImportSettings } from '../env.js'
import { ImportSlots } from '../runtime/importScheduler.js'
import { SharedDiscordClient } from '../runtime/SharedDiscordClient.js'
import { Backoff, sleep, type FetchLike } from '../http.js'
import { Logger, errorText } from '../log.js'
import type { HealthReport, Launched } from '../health.js'

/** Config errors the user must fix; printed without a stack, exit status 1. */
export class FatalConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FatalConfigError'
  }
}

export { HOSTED_AUTH_HINT, HOSTED_DISCORD_TOKEN_HINT, SELF_AUTH_HINT }

/** Retries `fn` with backoff while `isTransient` accepts its error; other errors propagate. */
async function untilReachable<T>(
  log: Logger,
  what: string,
  fn: () => Promise<T>,
  isTransient: (err: unknown) => boolean,
  shouldStop: () => boolean,
): Promise<T> {
  const backoff = new Backoff(5_000, 5 * 60_000)
  let logged = false
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      if (!isTransient(err) || shouldStop()) throw err
      const delay = backoff.next()
      if (!logged) log.error(`${what}: ${errorText(err)}. Retrying with backoff.`)
      else log.debug(`${what}: ${errorText(err)}. Next attempt in ${Math.round(delay / 1000)} s.`)
      logged = true
      await sleep(delay)
      if (shouldStop()) throw err
    }
  }
}

/** History import wiring of a self-run bridge. One bridge runs one job at a time. */
function importOptions(settings: ImportSettings = DEFAULT_IMPORT_SETTINGS): V2ImportOptions {
  return { slots: new ImportSlots(1), settings }
}

function ensureDataDir(dataDir: string) {
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch (err) {
    throw new FatalConfigError(
      `DATA_DIR ${dataDir} cannot be created (${errorText(err)}). With Docker, mount a volume: -v harmony-bridge:/data`,
    )
  }
}

/**
 * Self-hosted v2: redeem HARMONY_SETUP_CODE once (or reuse saved
 * credentials), then run one V2Bridge.
 */
export async function runSelf(opts: {
  harmonyUrl: string
  setupCode: string | null
  discordToken: string
  dataDir: string
  log: Logger
  version: string
  ignoredLegacyConfig: string | null
  import?: ImportSettings
  fetchImpl?: FetchLike
}): Promise<Launched> {
  const { log } = opts
  let stopped = false
  if (opts.ignoredLegacyConfig) {
    log.info(`HARMONY_URL is set; ignoring legacy ${opts.ignoredLegacyConfig}.`)
  }
  ensureDataDir(opts.dataDir)

  const probed = await untilReachable(
    log,
    'Cannot reach Harmony',
    () => probeEndpoints(opts.harmonyUrl, opts.fetchImpl),
    err => err instanceof EndpointError && err.unreachable,
    () => stopped,
  ).catch(err => {
    if (err instanceof EndpointError) throw new FatalConfigError(err.message)
    throw err
  })

  let creds: StoredCredentials
  try {
    const result = await untilReachable(
      log,
      'Cannot redeem the setup code',
      () => obtainCredentials({
        harmonyUrl: opts.harmonyUrl,
        setupCode: opts.setupCode,
        dataDir: opts.dataDir,
        apiBase: probed.apiBase,
        fetchImpl: opts.fetchImpl,
        warn: line => log.warn(line),
      }),
      err => err instanceof CredentialsError && err.kind === 'unreachable',
      () => stopped,
    )
    creds = result.creds
    if (result.source === 'redeemed') {
      log.info(`Setup code redeemed; credentials saved to ${join(opts.dataDir, 'credentials.json')}. HARMONY_SETUP_CODE is no longer needed.`)
    } else {
      log.info(`Using saved credentials for bridge ${creds.bridge_id}`)
    }
  } catch (err) {
    if (err instanceof CredentialsError) throw new FatalConfigError(err.message)
    throw err
  }

  // A bot-gateway URL given directly (co-located) wins; otherwise the URLs Harmony returned.
  const endpoints: HarmonyEndpoints = probed.direct
    ? probed
    : endpointsFor(creds.api_url || probed.apiBase, false)
  const gatewayUrl = probed.direct ? probed.gatewayUrl : (creds.gateway_url || endpoints.gatewayUrl)

  const bridge = new V2Bridge({
    harmonyToken: creds.harmony_token,
    apiBase: endpoints.apiBase,
    gatewayUrl,
    baseUrl: creds.base_url || null,
    discordToken: opts.discordToken,
    dataDir: opts.dataDir,
    log,
    version: opts.version,
    authHint: SELF_AUTH_HINT,
    import: importOptions(opts.import),
    fetchImpl: opts.fetchImpl,
  })
  await bridge.start()

  return {
    async stop() {
      stopped = true
      await bridge.stop()
    },
    health(): HealthReport {
      const h = bridge.health()
      return { ok: h.ok, body: { mode: 'self', ...h.body } }
    },
  }
}

const safeDirName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_')

/** Period of a hosted worker's health messages, ms. */
const HOSTED_HEALTH_INTERVAL_MS = 5_000

/**
 * Host mode: every own-token hosted bridge (one Discord client each) and
 * every instance bot bridge (one shared Discord client), reconciled every 60 s.
 * With worker isolation each own-token bridge runs in its own thread under a
 * heap limit; instance bot bridges share one login and stay on the main thread.
 * Neither kind imports history; no importer or scheduler is built for them.
 */
export async function runHost(opts: {
  harmonyUrl: string
  hostSecret: string
  publicUrl: string | null
  dataDir: string
  log: Logger
  version: string
  hostedIsolation?: HostedIsolation
  fetchImpl?: FetchLike
}): Promise<Launched> {
  const { log } = opts
  const isolation = opts.hostedIsolation ?? DEFAULT_HOSTED_ISOLATION
  let stopped = false
  ensureDataDir(opts.dataDir)

  const endpoints = await untilReachable(
    log,
    'Cannot reach Harmony',
    () => probeEndpoints(opts.harmonyUrl, opts.fetchImpl),
    err => err instanceof EndpointError && err.unreachable,
    () => stopped,
  ).catch(err => {
    if (err instanceof EndpointError) throw new FatalConfigError(err.message)
    throw err
  })
  const publicUrl = opts.publicUrl ?? (endpoints.direct ? null : opts.harmonyUrl)

  const instanceLog = log.child('[instance]')
  const instance = new InstanceHost<SharedDiscordClient>({
    log: instanceLog,
    fetchInstance: () => BridgeApi.hostedInstance(endpoints.apiBase, opts.hostSecret, opts.fetchImpl),
    createShared: ({ token, presence }) => new SharedDiscordClient({
      token,
      presence,
      log: instanceLog,
      fetchImpl: opts.fetchImpl,
    }),
    createBridge: (entry, shared) => new V2Bridge({
      label: `[${entry.bridge_id.slice(0, 8)}]`,
      harmonyToken: entry.harmony_token,
      apiBase: endpoints.apiBase,
      gatewayUrl: endpoints.gatewayUrl,
      baseUrl: publicUrl,
      discordToken: '',
      sharedDiscord: shared,
      dataDir: join(opts.dataDir, 'instance', safeDirName(entry.bridge_id)),
      appEmojiDir: join(opts.dataDir, 'app-emojis'),
      log,
      version: opts.version,
      authHint: HOSTED_AUTH_HINT,
      fetchImpl: opts.fetchImpl,
    }),
  })

  const createHosted = (entry: HostedEntry): HostedInstance => {
    const label = `[${entry.bridge_id.slice(0, 8)}]`
    const dataDir = join(opts.dataDir, 'hosted', safeDirName(entry.bridge_id))
    const appEmojiDir = join(opts.dataDir, 'app-emojis')
    if (isolation.mode === 'inline') {
      return new V2Bridge({
        label,
        harmonyToken: entry.harmony_token,
        apiBase: endpoints.apiBase,
        gatewayUrl: endpoints.gatewayUrl,
        baseUrl: publicUrl,
        discordToken: entry.discord_token,
        dataDir,
        appEmojiDir,
        log,
        version: opts.version,
        authHint: HOSTED_AUTH_HINT,
        discordTokenHint: HOSTED_DISCORD_TOKEN_HINT,
        fetchImpl: opts.fetchImpl,
      })
    }
    const workerData: HostedWorkerData = {
      entry,
      apiBase: endpoints.apiBase,
      gatewayUrl: endpoints.gatewayUrl,
      baseUrl: publicUrl,
      dataDir,
      appEmojiDir,
      logLevel: log.level,
      version: opts.version,
      healthIntervalMs: HOSTED_HEALTH_INTERVAL_MS,
    }
    return new WorkerHostedInstance({
      workerUrl: new URL('./hostedWorker.js', import.meta.url),
      workerData,
      heapMb: isolation.heapMb,
      log: log.child(label),
      healthStaleMs: HOSTED_HEALTH_INTERVAL_MS * 6,
    })
  }

  const runner = new HostRunner({
    log,
    instance,
    fetchHosted: () => BridgeApi.hosted(endpoints.apiBase, opts.hostSecret, opts.fetchImpl),
    createInstance: createHosted,
  })
  log.info(`Host mode: bot-gateway ${endpoints.apiBase}`)
  log.info(isolation.mode === 'worker'
    ? `Own-bot bridges run in worker threads, heap limit ${isolation.heapMb} MB each`
    : 'Own-bot bridges run on the main thread (BRIDGE_HOSTED_ISOLATION=inline)')
  await runner.start()

  return {
    async stop() {
      stopped = true
      await runner.stop()
    },
    health: () => runner.health(),
  }
}
