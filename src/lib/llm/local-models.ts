import { useSyncExternalStore } from 'react'

// The lightweight half of the in-browser model support. The runtime lives in
// ./local.ts (WebLLM, ~6 MB) and is only imported when an instructor uses it.
// Qwen3.5 4B is the only in-browser model the app offers (see docs/research.md).

export const LOCAL_MODEL = { label: 'Qwen3.5 4B', base: 'Qwen3.5-4B', license: 'Apache-2.0' }

// The id WebLLM knows the model by. GPUs without shader-f16 (e.g. Firefox)
// need the f32-activation build.
export function localModelId(f16: boolean): string {
  return `${LOCAL_MODEL.base}-${f16 ? 'q4f16_1' : 'q4f32_1'}-MLC`
}

export function localModelLabel(modelId: string): string {
  return modelId.startsWith(`${LOCAL_MODEL.base}-`) ? LOCAL_MODEL.label : modelId
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
