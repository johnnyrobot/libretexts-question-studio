import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WEBGPU_LOST_MESSAGE } from './fixtures'

// The WebLLM worker script runs WebLLM's handler and tells the page when
// WebGPU loses the device the model runs on, which WebLLM only logs.

vi.mock('@mlc-ai/web-llm', () => ({
  WebWorkerMLCEngineHandler: class {
    onmessage() {}
  },
}))

type LostInfo = { reason: 'unknown' | 'destroyed'; message: string }

let posted: unknown[] = []

// A worker whose GPU hands out one device, and a way to lose it.
async function workerScript() {
  let lose: (info: LostInfo) => void = () => undefined
  const device = { lost: new Promise<LostInfo>((resolve) => (lose = resolve)) }
  class FakeAdapter {
    async requestDevice() {
      return device
    }
  }
  vi.stubGlobal('GPUAdapter', FakeAdapter)
  vi.stubGlobal('self', { postMessage: (message: unknown) => posted.push(message) })
  await import('./local.worker')
  return { adapter: new FakeAdapter(), lose }
}

beforeEach(() => {
  posted = []
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('tells the page when WebGPU loses the device', async () => {
  const { adapter, lose } = await workerScript()
  // As WebLLM does when it loads the model.
  await adapter.requestDevice()

  lose({ reason: 'unknown', message: WEBGPU_LOST_MESSAGE })

  await vi.waitFor(() => expect(posted).toEqual([{ kind: 'gpuLost', message: WEBGPU_LOST_MESSAGE }]))
})

it('says nothing when the device was destroyed on purpose', async () => {
  const { adapter, lose } = await workerScript()
  await adapter.requestDevice()

  lose({ reason: 'destroyed', message: 'Device was destroyed.' })
  await new Promise((resolve) => setTimeout(resolve))

  expect(posted).toEqual([])
})
