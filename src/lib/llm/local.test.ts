import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WEBGPU_LOST_MESSAGE,
  WEBLLM_DISPOSED_ERROR,
  WEBLLM_INTERRUPTED_ERROR,
  WEBLLM_NOT_LOADED_ERROR,
} from './fixtures'

// The page side of the WebLLM engine, with stand-ins for the worker and for
// WebLLM's page-side engine, which answer the way the real ones do.

const MODEL = 'Qwen3.5-4B-q4f16_1-MLC'

type Chunk = {
  choices: { delta: { content?: string }; finish_reason: string | null }[]
  usage?: { prompt_tokens: number; completion_tokens: number }
}
// What chat.completions.create gives back: a stream, or a rejection, which
// WebLLM passes on from its worker as a plain string.
type Answer = (engine: { worker: FakeWorker }) => Promise<AsyncIterable<Chunk>>

class FakeWorker {
  static all: FakeWorker[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  terminated = false

  constructor() {
    FakeWorker.all.push(this)
  }

  // A message the worker script itself posts, outside WebLLM's protocol.
  post(data: unknown) {
    if (!this.terminated) this.onmessage?.({ data })
  }

  terminate() {
    this.terminated = true
  }
}

const { FakeEngine } = vi.hoisted(() => {
  class FakeEngine {
    static all: FakeEngine[] = []
    static answer: Answer
    calls = 0
    readonly worker: FakeWorker

    constructor(worker: FakeWorker) {
      this.worker = worker
      // Like WebLLM, which fails on message kinds it does not know.
      worker.onmessage = (event) => {
        throw new Error(`UnknownMessageKindError: ${(event.data as { kind: string }).kind}`)
      }
      FakeEngine.all.push(this)
    }

    async reload() {}

    interruptGenerate() {}

    chat = {
      completions: {
        create: () => {
          this.calls++
          return FakeEngine.answer(this)
        },
      },
    }
  }
  return { FakeEngine }
})

vi.mock('@mlc-ai/web-llm', () => ({
  WebWorkerMLCEngine: FakeEngine,
  prebuiltAppConfig: { model_list: [] },
  hasModelInCache: async () => true,
  deleteModelAllInfoInCache: async () => undefined,
}))

async function* stream(text: string, finish = 'stop'): AsyncIterable<Chunk> {
  yield { choices: [{ delta: { content: text }, finish_reason: finish }] }
  yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }
}

const request = {
  system: '',
  prompt: 'Write a question.',
  schemaName: 'question',
  schema: {},
  validate: (value: unknown) => value,
}

async function fresh() {
  vi.resetModules()
  const client = await import('./local')
  const models = await import('./local-models')
  const types = await import('./types')
  return { ...client, ...models, ...types }
}

beforeEach(() => {
  FakeWorker.all = []
  FakeEngine.all = []
  FakeEngine.answer = async () => stream('{"stem": "Why?"}')
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a lost GPU', () => {
  it('leaves no model loaded when the device goes while the model sits idle', async () => {
    const { loadLocalModel, loadedLocalModel } = await fresh()
    await loadLocalModel(MODEL, () => undefined)

    FakeWorker.all[0].post({ kind: 'gpuLost', message: WEBGPU_LOST_MESSAGE })

    expect(loadedLocalModel()).toBeNull()
  })

  it('fails the next question at once with what the GPU reported', async () => {
    const { loadLocalModel, createProvider, GpuLost } = await fresh()
    await loadLocalModel(MODEL, () => undefined)
    FakeWorker.all[0].post({ kind: 'gpuLost', message: WEBGPU_LOST_MESSAGE })

    const failure = createProvider(MODEL).complete(request)

    await expect(failure).rejects.toBeInstanceOf(GpuLost)
    await expect(failure).rejects.toMatchObject({ detail: WEBGPU_LOST_MESSAGE })
    expect(FakeEngine.all[0].calls).toBe(0)
  })

  it('fails a question the loss interrupts as a lost GPU, not as a rejected answer', async () => {
    const { loadLocalModel, createProvider, loadedLocalModel, GpuLost } = await fresh()
    await loadLocalModel(MODEL, () => undefined)
    FakeEngine.answer = (engine) => {
      engine.worker.post({ kind: 'gpuLost', message: WEBGPU_LOST_MESSAGE })
      return Promise.reject(WEBLLM_INTERRUPTED_ERROR)
    }
    const statuses: string[] = []

    const failure = createProvider(MODEL).complete({
      ...request,
      onProgress: (event) => event.kind === 'status' && statuses.push(event.message),
    })

    await expect(failure).rejects.toBeInstanceOf(GpuLost)
    expect(FakeEngine.all[0].calls).toBe(1)
    expect(statuses).toEqual([])
    expect(loadedLocalModel()).toBeNull()
  })

  it.each([
    ['a disposed model', WEBLLM_DISPOSED_ERROR],
    ['a model disposed mid-answer', WEBLLM_INTERRUPTED_ERROR],
    ['a model WebLLM dropped', WEBLLM_NOT_LOADED_ERROR],
  ])('takes %s for a lost GPU even when the loss was not reported', async (_, reply) => {
    const { loadLocalModel, createProvider, loadedLocalModel, GpuLost } = await fresh()
    await loadLocalModel(MODEL, () => undefined)
    FakeEngine.answer = () => Promise.reject(reply)

    const failure = createProvider(MODEL).complete(request)

    await expect(failure).rejects.toBeInstanceOf(GpuLost)
    await expect(failure).rejects.toMatchObject({ detail: reply })
    expect(FakeEngine.all[0].calls).toBe(1)
    expect(loadedLocalModel()).toBeNull()
  })

  it('loads the model again on a fresh worker when asked to recover', async () => {
    const { loadLocalModel, createProvider, loadedLocalModel } = await fresh()
    await loadLocalModel(MODEL, () => undefined)
    FakeWorker.all[0].post({ kind: 'gpuLost', message: WEBGPU_LOST_MESSAGE })

    const provider = createProvider(MODEL)
    await provider.recover!()

    expect(FakeWorker.all).toHaveLength(2)
    expect(FakeWorker.all[0].terminated).toBe(true)
    expect(loadedLocalModel()).toBe(MODEL)
    await expect(provider.complete(request)).resolves.toMatchObject({ value: { stem: 'Why?' } })
    expect(FakeEngine.all[1].calls).toBe(1)
  })

  it('forgets the loss once the model is loaded again', async () => {
    const { loadLocalModel, createProvider } = await fresh()
    await loadLocalModel(MODEL, () => undefined)
    FakeWorker.all[0].post({ kind: 'gpuLost', message: WEBGPU_LOST_MESSAGE })
    const provider = createProvider(MODEL)
    await provider.recover!()
    let calls = 0
    // The first answer runs into the output limit, which is worth another try.
    FakeEngine.answer = async () => (++calls === 1 ? stream('{"stem": "Why', 'length') : stream('{"stem": "Why?"}'))

    await expect(provider.complete(request)).resolves.toMatchObject({ attempts: 2, value: { stem: 'Why?' } })
  })
})
