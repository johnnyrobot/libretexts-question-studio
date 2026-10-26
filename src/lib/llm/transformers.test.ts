import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVICE_LOST_ERROR } from './fixtures'
import type { WorkerReply, WorkerRequest } from './transformers'

// The page side of the Transformers.js worker, with a stand-in worker that
// answers the way the real one does.

const MODEL = 'onnx-community/gemma-4-E4B-it-ONNX:q4f16'

// Omit on each kind of reply, so each keeps its own fields.
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type Answer = (request: WorkerRequest) => WithoutId<WorkerReply> | null

class FakeWorker {
  static all: FakeWorker[] = []
  static answer: Answer = () => ({ kind: 'done', value: null })
  onmessage: ((event: { data: WorkerReply }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  received: WorkerRequest[] = []
  terminated = false

  constructor() {
    FakeWorker.all.push(this)
  }

  postMessage(request: WorkerRequest) {
    this.received.push(request)
    const reply = FakeWorker.answer(request)
    if (reply) setTimeout(() => this.reply({ ...reply, id: request.id } as WorkerReply))
  }

  reply(data: WorkerReply) {
    if (!this.terminated) this.onmessage?.({ data })
  }

  terminate() {
    this.terminated = true
  }
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
  const client = await import('./transformers')
  const models = await import('./local-models')
  const types = await import('./types')
  return { ...client, ...models, ...types }
}

beforeEach(() => {
  FakeWorker.all = []
  FakeWorker.answer = () => ({ kind: 'done', value: null })
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a lost GPU', () => {
  it('fails the question at once and leaves no model loaded', async () => {
    const { loadLocalModel, createProvider, loadedLocalModel, GpuLost } = await fresh()
    await loadLocalModel(MODEL, () => undefined)
    FakeWorker.answer = (request) =>
      request.kind === 'generate' ? { kind: 'error', message: DEVICE_LOST_ERROR } : { kind: 'done', value: null }

    await expect(createProvider(MODEL).complete(request)).rejects.toBeInstanceOf(GpuLost)

    const [worker] = FakeWorker.all
    expect(worker.received.filter((sent) => sent.kind === 'generate')).toHaveLength(1)
    expect(worker.terminated).toBe(true)
    expect(loadedLocalModel()).toBeNull()
  })

  it('leaves no model loaded when the device goes while the model sits idle', async () => {
    const { loadLocalModel, loadedLocalModel } = await fresh()
    await loadLocalModel(MODEL, () => undefined)

    const [worker] = FakeWorker.all
    worker.reply({ id: 0, kind: 'lost', message: 'Device was lost.' })

    expect(worker.terminated).toBe(true)
    expect(loadedLocalModel()).toBeNull()
  })

  it('tells the next question the GPU was lost when the duplicate check lost it', async () => {
    const { loadLocalModel, createProvider, embedder, GpuLost } = await fresh()
    await loadLocalModel(MODEL, () => undefined)
    FakeWorker.answer = (request) =>
      request.kind === 'embed' ? { kind: 'error', message: DEVICE_LOST_ERROR } : { kind: 'done', value: null }

    await expect(embedder.embed(['Why?'])).rejects.toBeInstanceOf(GpuLost)
    await expect(createProvider(MODEL).complete(request)).rejects.toBeInstanceOf(GpuLost)
  })

  it('says the GPU stopped responding when the device goes while the model loads', async () => {
    const { loadLocalModel, loadedLocalModel } = await fresh()
    FakeWorker.answer = (request) =>
      request.kind === 'load' ? { kind: 'error', message: DEVICE_LOST_ERROR } : { kind: 'done', value: null }

    await expect(loadLocalModel(MODEL, () => undefined)).rejects.toThrow(
      'The GPU stopped responding while loading the model. Close other GPU-heavy tabs or apps and try again, or use an OpenAI key.',
    )
    expect(loadedLocalModel()).toBeNull()
  })

  it('loads the model again on a fresh worker when asked to recover', async () => {
    const { loadLocalModel, createProvider, loadedLocalModel } = await fresh()
    await loadLocalModel(MODEL, () => undefined)
    FakeWorker.all[0].reply({ id: 0, kind: 'lost', message: 'Device was lost.' })
    FakeWorker.answer = (request) =>
      request.kind === 'generate'
        ? { kind: 'done', value: { text: '{"stem": "Why?"}', inputTokens: 1, outputTokens: 1, hitLimit: false } }
        : { kind: 'done', value: null }

    const provider = createProvider(MODEL)
    await provider.recover!()

    expect(FakeWorker.all).toHaveLength(2)
    expect(FakeWorker.all[1].received.map((sent) => sent.kind)).toEqual(['load'])
    expect(loadedLocalModel()).toBe(MODEL)
    await expect(provider.complete(request)).resolves.toMatchObject({ value: { stem: 'Why?' } })
  })
})
