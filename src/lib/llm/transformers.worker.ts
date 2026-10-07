import {
  AutoConfig,
  AutoModel,
  AutoModelForCausalLM,
  AutoTokenizer,
  env,
  ModelRegistry,
  StoppingCriteria,
  StoppingCriteriaList,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type ProgressInfo,
  type Tensor,
} from '@huggingface/transformers'
import { StructuredOutputProcessor, type ResponseFormat } from '@huggingface/transformers-structured-output'
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import type { GenerateRequest, GenerateResult, ModelTarget, WorkerReply, WorkerRequest } from './transformers'

// Transformers.js runs here so the UI thread stays responsive. It hosts the
// in-browser question writer (Gemma 4) and the duplicate check
// (EmbeddingGemma 2), one of each at most. GPU work runs one task at a time.

env.allowLocalModels = false
// Serve ONNX Runtime from the app instead of jsDelivr; Transformers.js keeps
// a copy in the Cache API, so it also works offline.
env.backends.onnx.wasm!.wasmPaths = { mjs: ortMjs, wasm: ortWasm }

interface Loaded {
  key: string
  model: PreTrainedModel
  tokenizer: PreTrainedTokenizer
}

let llm: Loaded | null = null
let embedder: Loaded | null = null
let abortRequested = false
let queue: Promise<unknown> = Promise.resolve()

const reply = (message: WorkerReply) => self.postMessage(message)

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (request.kind === 'abort') {
    abortRequested = true
    return
  }
  const run = () => handle(request)
  // Cache checks and deletes need no GPU and must not wait behind a generation.
  const task = request.kind === 'status' || request.kind === 'delete' ? run() : (queue = queue.then(run, run))
  task.then(
    (value) => reply({ id: request.id, kind: 'done', value }),
    (error: unknown) => reply({ id: request.id, kind: 'error', message: error instanceof Error ? error.message : String(error) }),
  )
}

async function handle(request: Exclude<WorkerRequest, { kind: 'abort' }>): Promise<unknown> {
  switch (request.kind) {
    case 'status': {
      const { repo, role } = request.target
      const options = await registryOptions(request.target)
      const [cache, sizes] = await Promise.all([
        role === 'llm'
          ? ModelRegistry.is_pipeline_cached_files('text-generation', repo, options)
          : ModelRegistry.is_cached_files(repo, options),
        filesOf(request.target).then((files) => fileSizes(repo, files)),
      ])
      const bytes = sizes.includes(null) ? null : (sizes as number[]).reduce((a, b) => a + b, 0)
      return { cached: cache.allCached, bytes }
    }
    case 'delete': {
      if (llm?.key === keyOf(request.target)) await unloadLlm()
      if (embedder?.key === keyOf(request.target)) await unloadEmbedder()
      const options = await registryOptions(request.target)
      if (request.target.role === 'llm') await ModelRegistry.clear_pipeline_cache('text-generation', request.target.repo, options)
      else await ModelRegistry.clear_cache(request.target.repo, options)
      return null
    }
    case 'load':
      return request.target.role === 'llm' ? loadLlm(request.id, request.target) : loadEmbedder(request.id, request.target)
    case 'unload-llm':
      return unloadLlm()
    case 'generate':
      return generate(request.id, request.request)
    case 'embed':
      return embed(request.texts)
  }
}

const keyOf = (target: ModelTarget) => `${target.repo}:${target.dtype}`

// EmbeddingGemma 2 is multimodal; with the vision and audio configs removed
// only its text model is downloaded and loaded.
const textConfigs = new Map<string, Promise<Awaited<ReturnType<typeof AutoConfig.from_pretrained>>>>()
function textOnlyConfig(repo: string) {
  let config = textConfigs.get(repo)
  if (!config) {
    config = AutoConfig.from_pretrained(repo).then((c) => {
      const record = c as unknown as Record<string, unknown>
      record.vision_config = null
      record.audio_config = null
      return c
    })
    textConfigs.set(repo, config)
  }
  return config
}

async function registryOptions(target: ModelTarget) {
  return target.role === 'llm'
    ? { dtype: target.dtype as 'q4' }
    : { dtype: target.dtype as 'q4', config: await textOnlyConfig(target.repo), include_processor: false }
}

async function filesOf(target: ModelTarget): Promise<string[]> {
  const options = await registryOptions(target)
  return target.role === 'llm'
    ? ModelRegistry.get_pipeline_files('text-generation', target.repo, options)
    : ModelRegistry.get_files(target.repo, options)
}

async function fileSizes(repo: string, files: string[]): Promise<(number | null)[]> {
  return Promise.all(
    files.map((file) =>
      ModelRegistry.get_file_metadata(repo, file).then(
        (meta) => (meta.exists ? (meta.size ?? null) : 0),
        () => null,
      ),
    ),
  )
}

// Reports bytes loaded across all of a model's files, from the network or cache.
async function progressReporter(id: number, target: ModelTarget) {
  const files = await filesOf(target)
  const sizes = await fileSizes(target.repo, files)
  const total = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0)
  const loaded = new Map<string, number>()
  let last = 0
  return (info: ProgressInfo) => {
    if (info.status !== 'progress' && info.status !== 'done') return
    loaded.set(info.file, info.status === 'done' ? (sizes[files.indexOf(info.file)] ?? 0) : info.loaded)
    const now = performance.now()
    if (now - last < 250 && info.status !== 'done') return
    last = now
    let sum = 0
    for (const bytes of loaded.values()) sum += bytes
    reply({ id, kind: 'progress', loaded: Math.min(sum, total), total })
  }
}

async function loadLlm(id: number, target: ModelTarget): Promise<null> {
  if (llm?.key === keyOf(target)) return null
  await unloadLlm()
  const progress_callback = await progressReporter(id, target)
  const tokenizer = await AutoTokenizer.from_pretrained(target.repo)
  const model = await AutoModelForCausalLM.from_pretrained(target.repo, {
    dtype: target.dtype as 'q4f16',
    device: 'webgpu',
    progress_callback,
  })
  // Builds the structured-output tables for this vocabulary now (about half a
  // second for Gemma's 262k tokens) instead of in the first question.
  StructuredOutputProcessor.warmup(tokenizer)
  llm = { key: keyOf(target), model, tokenizer }
  return null
}

async function unloadLlm(): Promise<null> {
  const current = llm
  llm = null
  await current?.model.dispose()
  return null
}

async function loadEmbedder(id: number, target: ModelTarget): Promise<null> {
  if (embedder?.key === keyOf(target)) return null
  await unloadEmbedder()
  const progress_callback = await progressReporter(id, target)
  const [config, tokenizer] = await Promise.all([textOnlyConfig(target.repo), AutoTokenizer.from_pretrained(target.repo)])
  const model = await AutoModel.from_pretrained(target.repo, {
    config,
    dtype: target.dtype as 'q4',
    device: 'webgpu',
    progress_callback,
  })
  embedder = { key: keyOf(target), model, tokenizer }
  return null
}

async function unloadEmbedder(): Promise<null> {
  const current = embedder
  embedder = null
  await current?.model.dispose()
  return null
}

// Counts generated tokens for the progress display and stops on request.
class StepWatcher extends StoppingCriteria {
  private readonly id: number
  steps = 0

  constructor(id: number) {
    super()
    this.id = id
  }

  _call(inputIds: number[][]): boolean[] {
    if (++this.steps % 16 === 0) reply({ id: this.id, kind: 'tokens', generated: this.steps })
    return inputIds.map(() => abortRequested)
  }
}

// The structured-output package cannot enforce a string `pattern` while
// generating and refuses schemas that have one; zod checks them afterwards,
// like the length limits.
function withoutPatterns(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutPatterns)
  if (!node || typeof node !== 'object') return node
  return Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'pattern').map(([key, value]) => [key, withoutPatterns(value)]))
}

async function generate(id: number, request: GenerateRequest): Promise<GenerateResult> {
  if (!llm) throw new Error('The in-browser model is not loaded.')
  abortRequested = false
  const { model, tokenizer } = llm
  const prompt = tokenizer.apply_chat_template(
    [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    { tokenize: false, add_generation_prompt: true, enable_thinking: false } as never,
  ) as unknown as string
  const inputs = tokenizer(prompt, { add_special_tokens: false })
  const inputTokens = (inputs.input_ids as Tensor).dims.at(-1)!
  const watcher = new StepWatcher(id)
  const stopping = new StoppingCriteriaList()
  stopping.push(watcher)
  const output = (await model.generate({
    ...inputs,
    max_new_tokens: request.maxNewTokens,
    do_sample: true,
    temperature: request.temperature,
    top_p: request.topP,
    top_k: request.topK,
    logits_processor: new StructuredOutputProcessor(tokenizer, {
      type: 'json_schema',
      json_schema: withoutPatterns(request.schema) as Extract<ResponseFormat, { type: 'json_schema' }>['json_schema'],
    }),
    stopping_criteria: stopping,
  } as never)) as Tensor
  const generated = output.slice(null, [inputTokens, output.dims[1]])
  const ids = generated.tolist()[0] as (number | bigint)[]
  const eos = [model.generation_config?.eos_token_id ?? []].flat().map(Number)
  return {
    text: tokenizer.decode(ids.map(Number), { skip_special_tokens: true }),
    inputTokens,
    outputTokens: ids.length,
    hitLimit: !abortRequested && ids.length >= request.maxNewTokens && !eos.includes(Number(ids.at(-1))),
  }
}

// Embeds in batches small enough for WebGPU's dispatch limits (the model card
// warns past about 2,700 padded tokens). Returns unit vectors.
async function embed(texts: string[]): Promise<Float32Array[]> {
  if (!embedder) throw new Error('The duplicate check model is not loaded.')
  const { model, tokenizer } = embedder
  const lengths = texts.map((text) => tokenizer.encode(text).length)
  const order = texts.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b])
  const out: Float32Array[] = new Array(texts.length)
  for (let i = 0; i < order.length; ) {
    const batch = [order[i]]
    while (i + batch.length < order.length && lengths[order[i + batch.length]] * (batch.length + 1) <= 2000) {
      batch.push(order[i + batch.length])
    }
    const inputs = tokenizer(
      batch.map((k) => texts[k]),
      { padding: true, truncation: true, max_length: 2048 },
    )
    const { sentence_embedding } = (await model(inputs)) as { sentence_embedding: Tensor }
    const data = sentence_embedding.data as Float32Array
    const width = sentence_embedding.dims.at(-1)!
    batch.forEach((k, row) => {
      const vector = Float32Array.from(data.subarray(row * width, (row + 1) * width))
      const norm = Math.hypot(...vector) || 1
      for (let j = 0; j < vector.length; j++) vector[j] /= norm
      out[k] = vector
    })
    i += batch.length
  }
  return out
}
