import {
  WebWorkerMLCEngine,
  deleteModelAllInfoInCache,
  hasModelInCache,
  prebuiltAppConfig,
  type AppConfig,
  type InitProgressReport,
} from '@mlc-ai/web-llm'
import {
  completeWithRetries,
  LLMError,
  retryTemperature,
  type Completion,
  type CompletionRequest,
  type CompletionUsage,
  type LLMProvider,
} from './types'
import { loadedLocalModel, setLoadedLocalModel } from './local-models'

// In-browser generation with WebLLM (WebGPU). Qwen3.5 is Apache-2.0, ships
// prebuilt for WebLLM, and its hybrid attention keeps an 8K context cheap.
// Weights download once from Hugging Face into the Cache API and are reused.
// This module is ~6 MB with WebLLM, so it is only loaded on demand.

const CONTEXT_WINDOW = 8192

export const appConfig: AppConfig = { ...prebuiltAppConfig, cacheBackend: 'cache' }

export function vramRequiredMB(modelId: string): number | null {
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

export async function loadLocalModel(
  modelId: string,
  onProgress: (report: InitProgressReport) => void,
): Promise<void> {
  if (engine && loadedLocalModel() === modelId) return
  unloadLocalModel()
  worker = new Worker(new URL('./local.worker.ts', import.meta.url), { type: 'module' })
  engine = new WebWorkerMLCEngine(worker, { appConfig, initProgressCallback: onProgress })
  try {
    await engine.reload(modelId, { context_window_size: CONTEXT_WINDOW })
    setLoadedLocalModel(modelId)
  } catch (error) {
    unloadLocalModel()
    throw new LLMError(describeLoadError(error))
  }
}

export function unloadLocalModel(): void {
  worker?.terminate()
  worker = null
  engine = null
  setLoadedLocalModel(null)
}

function describeLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/quota|storage/i.test(message)) {
    return 'The browser ran out of storage for the model. Free some disk space or choose a smaller model.'
  }
  if (/device.*lost|out of memory|OOM|allocation/i.test(message)) {
    return 'The GPU ran out of memory loading this model. Choose a smaller model.'
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

  private async generate<T>(
    request: CompletionRequest<T>,
    prompt: string,
    attempt: number,
  ): Promise<{ text: string; usage: CompletionUsage | null }> {
    if (!engine || loadedLocalModel() !== this.model) {
      throw new LLMError('The in-browser model is not loaded. Load it from Settings first.')
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
          {
            role: 'user',
            // Grammar-constrained JSON still needs the model told to answer in JSON,
            // otherwise it can stall emitting whitespace.
            content: `${prompt}\n\nRespond ONLY with a JSON object that matches this JSON schema:\n${JSON.stringify(request.schema)}`,
          },
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
        throw new LLMError('The in-browser model ran out of output space before finishing the JSON.')
      }
      // Drop any reasoning prefix the model emitted despite thinking being off.
      return { text: text.replace(/^[\s\S]*?<\/think>/, ''), usage }
    } finally {
      request.signal?.removeEventListener('abort', abort)
    }
  }
}
