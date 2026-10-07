import { useLiveQuery } from 'dexie-react-hooks'
import {
  DEFAULT_LOCAL_MODEL,
  loadedLocalModel,
  localModel,
  localRuntime,
  probeWebGPU,
  type LocalModelKey,
} from '../lib/llm/local-models'
import { OpenAIProvider, type ReasoningEffort } from '../lib/llm/openai'
import type { Embedder, LLMProvider } from '../lib/llm/types'
import { getSessionKey } from '../lib/storage/secrets'
import { db, putSetting } from '../lib/storage/db'

export interface EngineSettings {
  provider: 'local' | 'openai'
  localModel: LocalModelKey
  localF16: boolean
  openaiModel: string
  effort: ReasoningEffort
  // Flag questions that repeat one already in the set (EmbeddingGemma 2).
  duplicateCheck: boolean
}

export const DEFAULT_ENGINE: EngineSettings = {
  provider: 'local',
  localModel: DEFAULT_LOCAL_MODEL,
  localF16: true,
  openaiModel: 'gpt-6-luna',
  effort: 'high',
  duplicateCheck: true,
}

const KEY = 'engine'

export function useEngineSettings(): EngineSettings {
  const row = useLiveQuery(() => db.settings.get(KEY), [])
  return { ...DEFAULT_ENGINE, ...((row?.value as Partial<EngineSettings>) ?? {}) }
}

export async function saveEngineSettings(update: Partial<EngineSettings>): Promise<void> {
  const current = ((await db.settings.get(KEY))?.value as Partial<EngineSettings>) ?? {}
  await putSetting(KEY, { ...DEFAULT_ENGINE, ...current, ...update })
}

export function localModelId(settings: EngineSettings): string {
  return localModel(settings.localModel).build(settings.localF16)
}

// Returns a ready provider, or a sentence telling the instructor what to do.
export async function createProvider(settings: EngineSettings): Promise<LLMProvider | string> {
  if (settings.provider === 'openai') {
    const key = getSessionKey()
    if (!key) return 'Add your OpenAI API key in Settings to generate with OpenAI.'
    return new OpenAIProvider({ apiKey: key, model: settings.openaiModel, effort: settings.effort })
  }
  const model = localModel(settings.localModel)
  const modelId = localModelId(settings)
  if (loadedLocalModel() !== modelId) return `Load ${model.label} in Settings first (one-time download).`
  return (await localRuntime(model)).createProvider(modelId)
}

// The duplicate check runs on this device whichever engine writes the
// questions. It is skipped where it cannot run, never in the way.
export async function createEmbedder(settings: EngineSettings): Promise<Embedder | null> {
  if (!settings.duplicateCheck || !(await probeWebGPU()).webgpu) return null
  return (await import('../lib/llm/transformers')).embedder
}
