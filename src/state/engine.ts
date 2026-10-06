import { useLiveQuery } from 'dexie-react-hooks'
import {
  DEFAULT_LOCAL_MODEL,
  LOCAL_MODELS,
  loadedLocalModel,
  localModelId as idFor,
  type LocalModelKey,
} from '../lib/llm/local-models'
import { OpenAIProvider, type ReasoningEffort } from '../lib/llm/openai'
import type { LLMProvider } from '../lib/llm/types'
import { getSessionKey } from '../lib/storage/secrets'
import { db, putSetting } from '../lib/storage/db'

export interface EngineSettings {
  provider: 'local' | 'openai'
  localModel: LocalModelKey
  localF16: boolean
  openaiModel: string
  effort: ReasoningEffort
}

export const DEFAULT_ENGINE: EngineSettings = {
  provider: 'local',
  localModel: DEFAULT_LOCAL_MODEL,
  localF16: true,
  openaiModel: 'gpt-6-luna',
  effort: 'high',
}

const KEY = 'engine'

export function useEngineSettings(): EngineSettings {
  const row = useLiveQuery(() => db.settings.get(KEY), [])
  const settings = { ...DEFAULT_ENGINE, ...((row?.value as Partial<EngineSettings>) ?? {}) }
  if (!(settings.localModel in LOCAL_MODELS)) settings.localModel = DEFAULT_LOCAL_MODEL
  return settings
}

export async function saveEngineSettings(update: Partial<EngineSettings>): Promise<void> {
  const current = ((await db.settings.get(KEY))?.value as Partial<EngineSettings>) ?? {}
  await putSetting(KEY, { ...DEFAULT_ENGINE, ...current, ...update })
}

export function localModelId(settings: EngineSettings): string {
  return idFor(settings.localModel, settings.localF16)
}

// Returns a ready provider, or a sentence telling the instructor what to do.
export async function createProvider(settings: EngineSettings): Promise<LLMProvider | string> {
  if (settings.provider === 'openai') {
    const key = getSessionKey()
    if (!key) return 'Add your OpenAI API key in Settings to generate with OpenAI.'
    return new OpenAIProvider({ apiKey: key, model: settings.openaiModel, effort: settings.effort })
  }
  const modelId = localModelId(settings)
  if (loadedLocalModel() !== modelId) return 'Load the in-browser model in Settings first (one-time download).'
  if (LOCAL_MODELS[settings.localModel].runtime === 'gguf') {
    const { GgufProvider } = await import('../lib/llm/local-gguf')
    return new GgufProvider(modelId)
  }
  const { LocalProvider } = await import('../lib/llm/local')
  return new LocalProvider(modelId)
}
