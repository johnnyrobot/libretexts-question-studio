import {
  WebWorkerMLCEngine,
  deleteModelAllInfoInCache,
  hasModelInCache,
  prebuiltAppConfig,
  type AppConfig,
} from '@mlc-ai/web-llm'
import {
  completeWithRetries,
  GpuLost,
  LLMError,
  retryTemperature,
  schemaInstruction,
  type Completion,
  type CompletionRequest,
  type CompletionUsage,
  type LLMProvider,
} from './types'
import { loadedLocalModel, setLoadedLocalModel, unloadAnyLocalModel, type LoadProgress } from './local-models'
import type { GpuLostMessage } from './local.worker'

// In-browser generation with WebLLM (WebGPU), for Qwen3.5 4B. Qwen3.5 is
// Apache-2.0, ships prebuilt for WebLLM, and its hybrid attention keeps an 8K
// context cheap.
// Weights download once from Hugging Face into the Cache API and are reused.
// This module is ~6 MB with WebLLM, so it is only loaded on demand.

const CONTEXT_WINDOW = 8192

export const appConfig: AppConfig = { ...prebuiltAppConfig, cacheBackend: 'cache' }

export function gpuMemoryMB(modelId: string): number | null {
  return appConfig.model_list.find((m) => m.model_id === modelId)?.vram_required_MB ?? null
}

export function isModelCached(modelId: string): Promise<boolean> {
  return hasModelInCache(modelId, appConfig)
}

export function deleteCachedModel(modelId: string): Promise<void> {
  return deleteModelAllInfoInCache(modelId, appConfig)
}

// Exact bytes the browser will download, read from the model's shard index.
export async function downloadBytes(modelId: string): Promise<number | null> {
  const record = appConfig.model_list.find((m) => m.model_id === modelId)
  if (!record) return null
  try {
    const response = await fetch(`${record.model}/resolve/main/tensor-cache.json`)
    const index = (await response.json()) as { records: { nbytes: number }[] }
    return index.records.reduce((sum, r) => sum + r.nbytes, 0)
  } catch {
    return null
  }
}

let worker: Worker | null = null
let engine: WebWorkerMLCEngine | null = null
// Why the model is gone, until it is loaded again: a lost GPU takes it.
let lost: GpuLost | null = null

export async function loadLocalModel(modelId: string, onProgress: (progress: LoadProgress) => void): Promise<void> {
  if (engine && loadedLocalModel() === modelId) return
  unloadAnyLocalModel()
  unloadLocalModel()
  worker = new Worker(new URL('./local.worker.ts', import.meta.url), { type: 'module' })
  engine = new WebWorkerMLCEngine(worker, {
    appConfig,
    initProgressCallback: (report) => onProgress({ value: report.progress, text: report.text }),
  })
  // The worker's own lost report is not WebLLM's to read: it fails on message
  // kinds it does not know.
  const deliver = worker.onmessage
  worker.onmessage = function (this: Worker, event: MessageEvent<GpuLostMessage | unknown>) {
    if (isGpuLostMessage(event.data)) loseModel(event.data.message)
    else deliver?.call(this, event)
  }
  try {
    await engine.reload(modelId, { context_window_size: CONTEXT_WINDOW })
    lost = null
    setLoadedLocalModel(modelId, unloadLocalModel)
  } catch (error) {
    unloadLocalModel()
    throw new LLMError(describeLoadError(error))
  }
}

export function unloadLocalModel(): void {
  const wasLoaded = !!engine && loadedLocalModel() !== null
  worker?.terminate()
  worker = null
  engine = null
  if (wasLoaded) setLoadedLocalModel(null)
}

function isGpuLostMessage(data: unknown): data is GpuLostMessage {
  return (data as GpuLostMessage | null)?.kind === 'gpuLost'
}

// WebGPU lost the device (a driver reset, the GPU process restarting). WebLLM
// only logs it and disposes the model, so the model stops counting as loaded
// here and the next call says why instead of retrying.
function loseModel(detail: string): GpuLost {
  lost ??= new GpuLost(detail)
  if (engine && loadedLocalModel() !== null) setLoadedLocalModel(null)
  return lost
}

// WebLLM passes errors on from its worker as plain strings. Once the GPU is
// lost, WebLLM has disposed the model, and every call fails on the disposed
// objects or on the model no longer being there.
function asEngineError(error: unknown): unknown {
  if (typeof error === 'string' && /already been disposed|^ModelNotLoadedError/.test(error)) return loseModel(error)
  return error
}

export function createProvider(modelId: string): LLMProvider {
  return new LocalProvider(modelId)
}

function describeLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/quota|storage/i.test(message)) {
    return 'The browser ran out of storage for the model. Free some disk space and try again.'
  }
  if (/device.*lost|out of memory|OOM|allocation/i.test(message)) {
    return 'The GPU ran out of memory loading the model. Close other GPU-heavy tabs or apps, or use an OpenAI key.'
  }
  return `The model could not be loaded: ${message}`
}

export class LocalProvider implements LLMProvider {
  readonly id = 'local' as const
  readonly model: string

  constructor(modelId: string) {
    this.model = modelId
  }

  complete<T>(request: CompletionRequest<T>): Promise<Completion<T>> {
    return completeWithRetries(request, (prompt, attempt) => this.generate(request, prompt, attempt))
  }

  recover(onProgress: (progress: LoadProgress) => void = () => undefined): Promise<void> {
    return loadLocalModel(this.model, onProgress)
  }

  private async generate<T>(
    request: CompletionRequest<T>,
    prompt: string,
    attempt: number,
  ): Promise<{ text: string; usage: CompletionUsage | null }> {
    if (!engine || loadedLocalModel() !== this.model) {
      throw lost ?? new LLMError('The in-browser model is not loaded. Load it from Settings first.')
    }
    const active = engine
    const abort = () => active.interruptGenerate()
    request.signal?.addEventListener('abort', abort)
    try {
      const stream = await active.chat.completions.create({
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: schemaInstruction(prompt, request.schema) },
        ],
        response_format: { type: 'json_object', schema: JSON.stringify(request.schema) },
        extra_body: { enable_thinking: false },
        temperature: retryTemperature(attempt),
        top_p: 0.9,
        max_tokens: request.maxOutputTokens ?? 1_800,
      })
      let text = ''
      let finish: string | null | undefined
      let usage: CompletionUsage | null = null
      let chunks = 0
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta?.content ?? ''
        finish = chunk.choices[0]?.finish_reason ?? finish
        if (++chunks % 16 === 0) request.onProgress?.({ kind: 'tokens', generated: chunks })
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            reasoningTokens: 0,
          }
        }
      }
      request.signal?.throwIfAborted()
      if (finish === 'length') {
        // Usually a runaway repetition rather than a long answer: a math item
        // needs about 400 tokens. A hotter retry usually breaks the loop.
        throw new LLMError(
          'The response was cut off at the output limit before the JSON was finished. Keep every text field brief and do not repeat yourself.',
          true,
        )
      }
      // Drop any reasoning prefix the model emitted despite thinking being off.
      return { text: text.replace(/^[\s\S]*?<\/think>/, ''), usage }
    } catch (error) {
      throw lost ?? asEngineError(error)
    } finally {
      request.signal?.removeEventListener('abort', abort)
    }
  }
}
