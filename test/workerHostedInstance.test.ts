import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerHostedInstance, type WorkerHostedInstanceOptions } from '../src/v2/WorkerHostedInstance.js'
import { Logger } from '../src/log.js'

const FAKE = new URL('./fixtures/fakeHostedWorker.mjs', import.meta.url)

const running: WorkerHostedInstance[] = []
afterEach(async () => {
  await Promise.allSettled(running.splice(0).map(i => i.stop()))
  vi.restoreAllMocks()
})

function make(mode: string, overrides: Partial<WorkerHostedInstanceOptions> & { spawns?: Int32Array } = {}) {
  const { spawns, ...rest } = overrides
  const inst = new WorkerHostedInstance({
    workerUrl: FAKE,
    workerData: { mode, healthIntervalMs: 50, spawns },
    heapMb: 64,
    log: new Logger('warn'),
    restart: { baseMs: 50, maxMs: 200, stableMs: 60_000 },
    stopTimeoutMs: 300,
    healthStaleMs: 2_000,
    hangMs: 10_000,
    ...rest,
  })
  running.push(inst)
  return inst
}

async function waitFor(check: () => boolean, ms = 8_000) {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time')
    await new Promise(r => setTimeout(r, 20))
  }
}

const body = (inst: WorkerHostedInstance) => inst.health().body as Record<string, any>

describe('WorkerHostedInstance', () => {
  it('reports the worker health with its isolation, and stops the thread', async () => {
    const inst = make('ok')
    await inst.start()
    await waitFor(() => inst.health().ok)
    expect(body(inst)).toMatchObject({ bridge_id: 'fake', isolation: 'worker', heap_limit_mb: 64, restarts: 0, last_exit: null })
    await inst.stop()
    expect(inst.health()).toMatchObject({ ok: false, body: { state: 'stopped' } })
  })

  it('ends only the bridge that runs out of heap, then restarts it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const spawns = new Int32Array(new SharedArrayBuffer(4))
    const neighbour = make('ok')
    const hog = make('oom-once', { spawns })
    await Promise.all([neighbour.start(), hog.start()])

    await waitFor(() => body(hog).restarts === 1 && hog.health().ok)
    expect(body(hog).last_exit.reason).toBe('out of memory (heap limit 64 MB)')
    expect(body(hog).spawn).toBe(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Hosted bridge worker ended: out of memory (heap limit 64 MB)'))
    expect(neighbour.health().ok).toBe(true)
    expect(body(neighbour).restarts).toBe(0)
  })

  it('rejects start when the thread ends before it starts, and keeps restarting it with backoff', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const inst = make('oom-before-start')
    await expect(inst.start()).rejects.toThrow('out of memory')
    await waitFor(() => body(inst).restarts >= 2)
    expect(inst.health().ok).toBe(false)
  })

  it('rejects start with the bridge error and leaves the thread running', async () => {
    const inst = make('start-fail')
    await expect(inst.start()).rejects.toThrow('Discord rejected the token')
    await waitFor(() => inst.health().ok)
    expect(body(inst).restarts).toBe(0)
  })

  it('restarts a thread that throws, naming the error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const inst = make('throw')
    await inst.start()
    await waitFor(() => body(inst).restarts >= 1)
    expect(body(inst).last_exit.reason).toContain('boom')
  })

  it('reports a blocked thread unresponsive, then ends and restarts it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const inst = make('hang', { healthStaleMs: 200, hangMs: 600 })
    await inst.start()
    await waitFor(() => body(inst).state === 'unresponsive')
    expect(inst.health().ok).toBe(false)
    await waitFor(() => body(inst).restarts >= 1)
    expect(body(inst).last_exit.reason).toMatch(/^unresponsive for \d+ s$/)
  })

  it('retries a thread whose script fails to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const inst = make('ok', { workerUrl: new URL('./fixtures/missing.mjs', import.meta.url) })
    await expect(inst.start()).rejects.toThrow()
    await waitFor(() => body(inst).restarts >= 2)
    expect(inst.health().ok).toBe(false)
    expect(body(inst).last_exit.reason).toContain('missing.mjs')
  })

  it('retries a thread that cannot be created, without throwing into the host process', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const inst = make('ok', { workerUrl: new URL('https://example.invalid/worker.mjs') })
    await expect(inst.start()).rejects.toThrow('thread not created')
    await waitFor(() => body(inst).restarts >= 2)
    expect(body(inst)).toMatchObject({ state: 'restarting' })
    expect(body(inst).last_exit.reason).toMatch(/^thread not created/)
  })

  it('terminates a thread that ignores stop', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const inst = make('ignore-stop')
    await inst.start()
    const t0 = Date.now()
    await inst.stop()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('did not stop'))
  })

  it('does not restart after stop during the restart wait', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const spawns = new Int32Array(new SharedArrayBuffer(4))
    const inst = make('oom', { spawns, restart: { baseMs: 400, maxMs: 400, stableMs: 60_000 } })
    await inst.start()
    await waitFor(() => body(inst).state === 'restarting')
    await inst.stop()
    await new Promise(r => setTimeout(r, 600))
    expect(Atomics.load(spawns, 0)).toBe(1)
    expect(body(inst).state).toBe('stopped')
  })
})
