// The package's "main" points at a file it does not ship; use the ESM build.
import { ModelManager, ModelValidationStatus, Wllama } from '@wllama/wllama/esm/index.js'
import wasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url'
import { loadedLocalModel, setLoadedLocalModel, type GgufModel } from './local-models'
import {
  completeWithRetries,
  LLMError,
  retryTemperature,
  type Completion,
  type CompletionRequest,
  type CompletionUsage,
  type LLMProvider,
} from './types'

// GGUF models through wllama (llama.cpp compiled to WebAssembly, WebGPU when
// available, CPU otherwise). Used for models that have no prebuilt WebLLM
// build, such as MiniCPM5-2B. Weights are cached in the origin-private file
// system. Loaded on demand only.

const CONTEXT_WINDOW = 8192

let wllama: Wllama | null = null

function ggufUrl(model: GgufModel): string {
  return `https://huggingface.co/${model.repo}/resolve/main/${model.file}`
}

async function cachedModel(model: GgufModel) {
  const models = await new ModelManager().getModels({ includeInvalid: true })
  return models.find((m) => m.url === ggufUrl(model)) ?? null
}

export async function isGgufCached(model: GgufModel): Promise<boolean> {
  const found = await cachedModel(model)
  return found !== null && found.validate() === ModelValidationStatus.VALID
}

export async function deleteGgufModel(model: GgufModel): Promise<void> {
  unloadGgufModel()
  await (await cachedModel(model))?.remove()
}

export async function loadGgufModel(
  model: GgufModel,
  onProgress: (report: { progress: number; text: string }) => void,
): Promise<void> {
  if (wllama && loadedLocalModel() === model.id) return
  unloadGgufModel()
  const instance = new Wllama({ default: wasmUrl }, { suppressNativeLog: true, parallelDownloads: 3 })
  try {
    await instance.loadModelFromUrl(ggufUrl(model), {
      n_ctx: CONTEXT_WINDOW,
      progressCallback: ({ loaded, total }) =>
        onProgress({
          progress: total ? loaded / total : 0,
          text: `Downloading ${model.file}: ${(loaded / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`,
        }),
    })
    onProgress({ progress: 1, text: 'Model loaded.' })
    wllama = instance
    setLoadedLocalModel(model.id)
  } catch (error) {
    await instance.exit().catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    throw new LLMError(
      /quota|storage/i.test(message)
        ? 'The browser ran out of storage for the model. Free some disk space or choose a smaller model.'
        : `The model could not be loaded: ${message}`,
    )
  }
}

export function unloadGgufModel(): void {
  void wllama?.exit().catch(() => undefined)
  wllama = null
  if (loadedLocalModel()?.endsWith('.gguf')) setLoadedLocalModel(null)
}

export class GgufProvider implements LLMProvider {
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
    if (!wllama || loadedLocalModel() !== this.model) {
      throw new LLMError('The in-browser model is not loaded. Load it from Settings first.')
    }
    const stream = await wllama.createChatCompletion({
      stream: true,
      messages: [
        { role: 'system', content: request.system },
        {
          role: 'user',
          content: `${prompt}\n\nRespond ONLY with a JSON object that matches this JSON schema:\n${JSON.stringify(request.schema)}`,
        },
      ],
      // llama.cpp turns the schema into a grammar, so the output always parses.
      response_format: {
        type: 'json_schema',
        json_schema: { name: request.schemaName, schema: request.schema, strict: true },
      },
      chat_template_kwargs: { enable_thinking: false },
      temperature: retryTemperature(attempt),
      // MiniCPM's card: llama.cpp's default min_p can cause repetition loops.
      min_p: 0,
      max_tokens: request.maxOutputTokens ?? 1_800,
      abortSignal: request.signal,
    })
    let text = ''
    let finish: string | null | undefined
    let chunks = 0
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? ''
      finish = chunk.choices[0]?.finish_reason ?? finish
      if (++chunks % 16 === 0) request.onProgress?.({ kind: 'tokens', generated: chunks })
    }
    request.signal?.throwIfAborted()
    if (finish === 'length') {
      throw new LLMError('The in-browser model ran out of output space before finishing the JSON.')
    }
    return { text: text.replace(/^[\s\S]*?<\/think>/, ''), usage: null }
  }
}
