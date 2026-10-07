import {
  EMBEDDER,
  loadedLocalModel,
  localModelOf,
  setLoadedLocalModel,
  unloadAnyLocalModel,
  type LoadProgress,
} from './local-models'
import {
  completeWithRetries,
  LLMError,
  retryTemperature,
  schemaInstruction,
  type Completion,
  type CompletionRequest,
  type CompletionUsage,
  type Embedder,
  type JsonSchema,
  type LLMProvider,
} from './types'

// In-browser generation with Transformers.js (WebGPU), for Gemma 4, which
// WebLLM has no build of. JSON is forced token by token with Hugging Face's
// structured-output package. The same worker runs EmbeddingGemma 2 for the
// duplicate check. Weights download once from Hugging Face into the Cache API
// and are reused. Only loaded on demand.

export interface ModelTarget {
  role: 'llm' | 'embedder'
  repo: string
  dtype: string
}

export interface GenerateRequest {
  system: string
  user: string
  schema: JsonSchema
  maxNewTokens: number
  temperature: number
  topP: number
  topK: number
}

export interface GenerateResult {
  text: string
  inputTokens: number
  outputTokens: number
  hitLimit: boolean
}

export type WorkerRequest =
  | { id: number; kind: 'status' | 'delete' | 'load'; target: ModelTarget }
  | { id: number; kind: 'unload-llm' | 'abort' }
  | { id: number; kind: 'generate'; request: GenerateRequest }
  | { id: number; kind: 'embed'; texts: string[] }

export type WorkerReply =
  | { id: number; kind: 'done'; value: unknown }
  | { id: number; kind: 'error'; message: string }
  | { id: number; kind: 'progress'; loaded: number; total: number }
  | { id: number; kind: 'tokens'; generated: number }

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onEvent?: (reply: WorkerReply) => void
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function ensureWorker(): Worker {
  if (worker) return worker
  const created = new Worker(new URL('./transformers.worker.ts', import.meta.url), { type: 'module' })
  created.onmessage = (event: MessageEvent<WorkerReply>) => {
    const message = event.data
    const entry = pending.get(message.id)
    if (!entry) return
    if (message.kind === 'done') {
      pending.delete(message.id)
      entry.resolve(message.value)
    } else if (message.kind === 'error') {
      pending.delete(message.id)
      entry.reject(new Error(message.message))
    } else {
      entry.onEvent?.(message)
    }
  }
  created.onerror = (event) => {
    event.preventDefault()
    resetWorker(`The model runtime stopped: ${event.message || 'unknown error'}`)
  }
  worker = created
  return created
}

function resetWorker(reason: string): void {
  worker?.terminate()
  worker = null
  statuses.clear()
  for (const entry of pending.values()) entry.reject(new LLMError(reason))
  pending.clear()
  if (localModelOf(loadedLocalModel() ?? '')?.runtime === 'transformers') setLoadedLocalModel(null)
}

function call<T>(request: Without<WorkerRequest, 'id'>, onEvent?: (reply: WorkerReply) => void): Promise<T> {
  const id = nextId++
  const target = ensureWorker()
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onEvent })
    target.postMessage({ ...request, id })
  })
}

function llmTarget(modelId: string): ModelTarget {
  const at = modelId.lastIndexOf(':')
  return { role: 'llm', repo: modelId.slice(0, at), dtype: modelId.slice(at + 1) }
}

const EMBEDDER_TARGET: ModelTarget = { role: 'embedder', repo: EMBEDDER.repo, dtype: EMBEDDER.dtype }

// Whether the files are in the browser cache, and their total size, read from
// Hugging Face. Remembered until a load or delete changes the answer.
const statuses = new Map<string, Promise<{ cached: boolean; bytes: number | null }>>()

function status(target: ModelTarget) {
  const key = `${target.repo}:${target.dtype}`
  let result = statuses.get(key)
  if (!result) {
    result = call<{ cached: boolean; bytes: number | null }>({ kind: 'status', target })
    result.catch(() => statuses.delete(key))
    statuses.set(key, result)
  }
  return result
}

function forgetStatus(target: ModelTarget) {
  statuses.delete(`${target.repo}:${target.dtype}`)
}

function progressHandler(onProgress?: (progress: LoadProgress) => void) {
  return (reply: WorkerReply) => {
    if (reply.kind !== 'progress' || !onProgress) return
    const value = reply.total ? reply.loaded / reply.total : 0
    onProgress({
      value,
      text:
        value >= 1
          ? 'Preparing the model on the GPU…'
          : `Loading ${(reply.loaded / 1e9).toFixed(2)} of ${(reply.total / 1e9).toFixed(2)} GB`,
    })
  }
}

// ------------------------------------------------------------ question writer

export async function isModelCached(modelId: string): Promise<boolean> {
  return (await status(llmTarget(modelId))).cached
}

export async function downloadBytes(modelId: string): Promise<number | null> {
  return (await status(llmTarget(modelId)).catch(() => null))?.bytes ?? null
}

// Transformers.js gives no estimate, and the page cannot measure it.
export function gpuMemoryMB(): number | null {
  return null
}

export async function loadLocalModel(modelId: string, onProgress: (progress: LoadProgress) => void): Promise<void> {
  if (loadedLocalModel() === modelId) return
  unloadAnyLocalModel()
  const target = llmTarget(modelId)
  try {
    await call({ kind: 'load', target }, progressHandler(onProgress))
    setLoadedLocalModel(modelId, unloadLocalModel)
  } catch (error) {
    throw new LLMError(describeLoadError(error))
  } finally {
    forgetStatus(target)
  }
}

export function unloadLocalModel(): void {
  if (localModelOf(loadedLocalModel() ?? '')?.runtime !== 'transformers') return
  setLoadedLocalModel(null)
  if (worker) void call({ kind: 'unload-llm' }).catch(() => undefined)
}

export async function deleteCachedModel(modelId: string): Promise<void> {
  const target = llmTarget(modelId)
  if (loadedLocalModel() === modelId) setLoadedLocalModel(null)
  await call({ kind: 'delete', target })
  forgetStatus(target)
}

function describeLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/quota|storage/i.test(message)) {
    return 'The browser ran out of storage for the model. Free some disk space and try again.'
  }
  if (/device.*lost|out of memory|OOM|allocat/i.test(message)) {
    return 'The GPU ran out of memory loading the model. Close other GPU-heavy tabs or apps, or use an OpenAI key.'
  }
  return `The model could not be loaded: ${message}`
}

export function createProvider(modelId: string): LLMProvider {
  return new TransformersProvider(modelId)
}

export class TransformersProvider implements LLMProvider {
  readonly id = 'local' as const
  readonly model: string

  constructor(modelId: string) {
    this.model = modelId
  }

  complete<T>(request: CompletionRequest<T>): Promise<Completion<T>> {
    return completeWithRetries(request, (prompt, attempt) => this.generate(request, prompt, attempt))
  }

  private async generate<T>(
    request: CompletionRequest<T>,
    prompt: string,
    attempt: number,
  ): Promise<{ text: string; usage: CompletionUsage | null }> {
    if (loadedLocalModel() !== this.model || !worker) {
      throw new LLMError('The in-browser model is not loaded. Load it from Settings first.')
    }
    const active = worker
    const abort = () => active.postMessage({ id: 0, kind: 'abort' })
    request.signal?.addEventListener('abort', abort)
    try {
      const result = await call<GenerateResult>(
        {
          kind: 'generate',
          request: {
            system: request.system,
            user: schemaInstruction(prompt, request.schema),
            schema: request.schema,
            maxNewTokens: request.maxOutputTokens ?? 1_800,
            temperature: retryTemperature(attempt),
            topP: 0.9,
            // Google's recommended sampling for Gemma 4.
            topK: 64,
          },
        },
        (reply) => {
          if (reply.kind === 'tokens') request.onProgress?.({ kind: 'tokens', generated: reply.generated })
        },
      )
      request.signal?.throwIfAborted()
      if (result.hitLimit) {
        throw new LLMError(
          'The response was cut off at the output limit before the JSON was finished. Keep every text field brief and do not repeat yourself.',
          true,
        )
      }
      return {
        // Drop a thinking channel the model opened despite thinking being off.
        text: result.text.replace(/^[\s\S]*?<channel\|>/, ''),
        usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, reasoningTokens: 0 },
      }
    } finally {
      request.signal?.removeEventListener('abort', abort)
    }
  }
}

// ------------------------------------------------------------ duplicate check

export const embedder: Embedder & {
  isCached(): Promise<boolean>
  downloadBytes(): Promise<number | null>
  deleteCached(): Promise<void>
} = {
  model: EMBEDDER.repo,
  isCached: async () => (await status(EMBEDDER_TARGET)).cached,
  downloadBytes: async () => (await status(EMBEDDER_TARGET).catch(() => null))?.bytes ?? null,
  async load(onProgress) {
    try {
      await call({ kind: 'load', target: EMBEDDER_TARGET }, progressHandler(onProgress))
    } finally {
      forgetStatus(EMBEDDER_TARGET)
    }
  },
  embed: (texts) => call<Float32Array[]>({ kind: 'embed', texts }),
  async deleteCached() {
    await call({ kind: 'delete', target: EMBEDDER_TARGET })
    forgetStatus(EMBEDDER_TARGET)
  },
}
