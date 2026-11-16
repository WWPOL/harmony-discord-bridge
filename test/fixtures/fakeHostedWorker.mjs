// Stand-in for dist/v2/hostedWorker.js speaking hostedWorkerProtocol.
// workerData: { mode, healthIntervalMs, spawns?: Int32Array over a SharedArrayBuffer }
import { parentPort, workerData } from 'worker_threads'

const { mode, healthIntervalMs = 50 } = workerData
const spawn = workerData.spawns ? Atomics.add(workerData.spawns, 0, 1) : 0
const send = (msg) => parentPort.postMessage(msg)
const health = () => send({ type: 'health', report: { ok: true, body: { bridge_id: 'fake', spawn } } })
const hog = []
const exhaustHeap = () => { for (;;) hog.push(new Array(100_000).fill(spawn)) }

if (mode === 'oom-before-start') exhaustHeap()

const timer = setInterval(health, healthIntervalMs)
parentPort.on('message', (msg) => {
  if (msg?.type !== 'stop' || mode === 'ignore-stop') return
  clearInterval(timer)
  process.exit(0)
})

if (mode === 'start-fail') {
  send({ type: 'start-failed', error: 'Discord rejected the token' })
} else {
  send({ type: 'started' })
}
health()

if (mode === 'oom' || (mode === 'oom-once' && spawn === 0)) setTimeout(exhaustHeap, 20)
if (mode === 'hang') setTimeout(() => { for (;;) {} }, 20)
if (mode === 'throw') setTimeout(() => { throw new Error('boom') }, 20)
