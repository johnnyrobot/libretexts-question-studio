import { useSyncExternalStore } from 'react'

// The lightweight half of the in-browser model support. The runtimes live in
// ./local.ts (WebLLM, ~6 MB, for models with prebuilt WebGPU builds such as
// Qwen3.5) and ./local-gguf.ts (wllama / llama.cpp, for GGUF-only models such
// as MiniCPM5), and are only imported when an instructor uses them.

export type LocalModelKey = 'qwen3.5-2b' | 'minicpm5-2b' | 'qwen3.5-4b' | 'qwen3.5-9b'

export interface WebLLMModel {
  runtime: 'webllm'
  base: string
}

export interface GgufModel {
  runtime: 'gguf'
  id: string
  repo: string
  file: string
  bytes: number
  vramMB: number
}

export type LocalModelInfo = { label: string; note: string; license: string } & (WebLLMModel | GgufModel)

export const LOCAL_MODELS: Record<LocalModelKey, LocalModelInfo> = {
  'qwen3.5-2b': {
    label: 'Qwen3.5 2B',
    note: 'Smallest and fastest. Weakest distractors; more questions fail validation and are skipped.',
    license: 'Apache-2.0',
    runtime: 'webllm',
    base: 'Qwen3.5-2B',
  },
  'minicpm5-2b': {
    label: 'MiniCPM5 2B',
    note: 'Newer 2B model (Sept 2026) that benchmarks near 4B models on knowledge and reasoning. Runs through llama.cpp, so it also works without WebGPU (slowly).',
    license: 'Apache-2.0',
    runtime: 'gguf',
    id: 'MiniCPM5-2B-Q4_K_M.gguf',
    repo: 'openbmb/MiniCPM5-2B-GGUF',
    file: 'MiniCPM5-2B-Q4_K_M.gguf',
    bytes: 1_560_000_000,
    vramMB: 2_300,
  },
  'qwen3.5-4b': {
    label: 'Qwen3.5 4B',
    note: 'Recommended for most computers with 8 GB+ of memory.',
    license: 'Apache-2.0',
    runtime: 'webllm',
    base: 'Qwen3.5-4B',
  },
  'qwen3.5-9b': {
    label: 'Qwen3.5 9B',
    note: 'Best in-browser quality. Strong GPUs or Apple silicon with 16 GB+.',
    license: 'Apache-2.0',
    runtime: 'webllm',
    base: 'Qwen3.5-9B',
  },
}

export const DEFAULT_LOCAL_MODEL: LocalModelKey = 'qwen3.5-4b'

// The id the runtime knows the model by. WebLLM models without shader-f16
// (e.g. Firefox) need the f32-activation build.
export function localModelId(key: LocalModelKey, f16: boolean): string {
  const info = LOCAL_MODELS[key] ?? LOCAL_MODELS[DEFAULT_LOCAL_MODEL]
  return info.runtime === 'gguf' ? info.id : `${info.base}-${f16 ? 'q4f16_1' : 'q4f32_1'}-MLC`
}

export function localModelLabel(modelId: string): string {
  const match = Object.values(LOCAL_MODELS).find((info) =>
    info.runtime === 'gguf' ? info.id === modelId : modelId.startsWith(`${info.base}-`),
  )
  return match?.label ?? modelId
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
let loaded: string | null = null
const listeners = new Set<() => void>()

export function loadedLocalModel(): string | null {
  return loaded
}

export function setLoadedLocalModel(modelId: string | null): void {
  loaded = modelId
  listeners.forEach((listener) => listener())
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
