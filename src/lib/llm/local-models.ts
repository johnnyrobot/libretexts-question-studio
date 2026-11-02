import { useSyncExternalStore } from 'react'
import type { LLMProvider } from './types'

// The lightweight half of the in-browser model support. The runtimes live in
// ./transformers.ts (Transformers.js, for Gemma 4 and EmbeddingGemma 2) and
// ./local.ts (WebLLM, for Qwen3.5) and are only imported when an instructor
// uses them. The tuned Qwen3.5 9B is the default where it runs, Gemma 4 E4B
// elsewhere (LT-237).

export type LocalModelKey = 'qwen3.5-9b-ftds' | 'gemma-4-e4b' | 'qwen3.5-4b'

export interface LocalModel {
  key: LocalModelKey
  label: string
  summary: string
  license: string
  runtime: 'transformers' | 'webllm'
  // The id the runtime knows the build by. GPUs without shader-f16 (e.g.
  // Firefox) need the build with 32-bit activations.
  build: (f16: boolean) => string
  // Has no 32-bit build, so it runs only on GPUs with shader-f16.
  f16Only?: boolean
  // A model whose downloaded files are freed once this one has loaded, so
  // nobody keeps two 5 GB models (LT-237).
  replaces?: LocalModelKey
}

export const LOCAL_MODELS: readonly LocalModel[] = [
  {
    // Qwen3.5 9B fine-tuned on DeepSeek V4.1 Flash's questions (LT-207),
    // served from this site, not Hugging Face (./local.ts).
    key: 'qwen3.5-9b-ftds',
    label: 'Qwen3.5 9B, tuned for questions',
    summary: 'Recommended. Fewer wrong answer keys. 5.1 GB download. Needs a GPU with 16-bit shader support.',
    license: 'Apache-2.0',
    runtime: 'webllm',
    build: () => 'qwen35-9b-ftds-q4f16_1-v1',
    f16Only: true,
    replaces: 'gemma-4-e4b',
  },
  {
    key: 'gemma-4-e4b',
    label: 'Gemma 4 E4B',
    summary: 'Writes questions faster, and runs on GPUs without 16-bit shader support. 4.9 GB download.',
    license: 'Apache-2.0',
    runtime: 'transformers',
    build: (f16) => `onnx-community/gemma-4-E4B-it-ONNX:${f16 ? 'q4f16' : 'q4'}`,
  },
  {
    key: 'qwen3.5-4b',
    label: 'Qwen3.5 4B',
    summary: 'Smaller download (2.4 GB) and less GPU memory.',
    license: 'Apache-2.0',
    runtime: 'webllm',
    build: (f16) => `Qwen3.5-4B-${f16 ? 'q4f16_1' : 'q4f32_1'}-MLC`,
  },
]

// The best model this GPU runs.
export function defaultLocalModel(f16: boolean): LocalModelKey {
  return f16 ? 'qwen3.5-9b-ftds' : 'gemma-4-e4b'
}

export function localModel(key: string): LocalModel {
  return LOCAL_MODELS.find((model) => model.key === key) ?? LOCAL_MODELS[0]
}

export function localModelOf(modelId: string): LocalModel | undefined {
  return LOCAL_MODELS.find((model) => model.build(true) === modelId || model.build(false) === modelId)
}

export function localModelLabel(modelId: string): string {
  return localModelOf(modelId)?.label ?? modelId
}

// EmbeddingGemma 2 (its 270M text part) flags questions that repeat one
// already in the set. It runs in the Transformers.js worker whichever engine
// writes the questions.
export const EMBEDDER = {
  label: 'EmbeddingGemma 2',
  repo: 'onnx-community/embeddinggemma-2-ONNX',
  dtype: 'q4',
  license: 'Apache-2.0',
}

export interface LoadProgress {
  value: number
  text: string
}

// What Settings and the engine need from either runtime module.
export interface LocalRuntime {
  isModelCached(modelId: string): Promise<boolean>
  downloadBytes(modelId: string): Promise<number | null>
  gpuMemoryMB(modelId: string): number | null
  loadLocalModel(modelId: string, onProgress: (progress: LoadProgress) => void): Promise<void>
  unloadLocalModel(): void
  deleteCachedModel(modelId: string): Promise<void>
  createProvider(modelId: string): LLMProvider
}

export function localRuntime(model: LocalModel): Promise<LocalRuntime> {
  return model.runtime === 'webllm' ? import('./local') : import('./transformers')
}

// Deletes the downloaded files of the model `model` replaces, both builds,
// and returns its label if either was fully downloaded. Every build is
// deleted, since a download that stopped part way still left files. Call it
// only once `model` has loaded, so a failed download never leaves a teacher
// with neither.
export async function freeReplacedModel(model: LocalModel): Promise<string | null> {
  if (!model.replaces) return null
  const replaced = localModel(model.replaces)
  const runtime = await localRuntime(replaced)
  const builds = [...new Set([replaced.build(true), replaced.build(false)])]
  const cached = await Promise.all(builds.map((build) => runtime.isModelCached(build).catch(() => false)))
  for (const build of builds) await runtime.deleteCachedModel(build)
  return cached.includes(true) ? replaced.label : null
}

export interface GpuSupport {
  webgpu: boolean
  f16: boolean
  reason: string | null
}

export async function probeWebGPU(): Promise<GpuSupport> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
  if (!gpu) {
    return {
      webgpu: false,
      f16: false,
      reason: 'This browser does not support WebGPU. Use a recent Chrome, Edge, or Safari 26, or use an OpenAI key.',
    }
  }
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return { webgpu: false, f16: false, reason: 'WebGPU is available but no compatible GPU was found.' }
    return { webgpu: true, f16: adapter.features.has('shader-f16'), reason: null }
  } catch {
    return { webgpu: false, f16: false, reason: 'WebGPU could not be initialised on this device.' }
  }
}

// Which model (if any) is loaded on the GPU right now, observable from React.
// Only one is loaded at a time: loading one first frees the other.
let loaded: string | null = null
let unloadLoaded: (() => void) | null = null
const listeners = new Set<() => void>()

export function loadedLocalModel(): string | null {
  return loaded
}

export function setLoadedLocalModel(modelId: string | null, unload: (() => void) | null = null): void {
  loaded = modelId
  unloadLoaded = modelId ? unload : null
  listeners.forEach((listener) => listener())
}

export function unloadAnyLocalModel(): void {
  unloadLoaded?.()
  if (loaded) setLoadedLocalModel(null)
}

export function useLoadedLocalModel(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => loaded,
  )
}
