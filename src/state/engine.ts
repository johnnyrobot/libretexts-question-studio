import { useLiveQuery } from 'dexie-react-hooks'
import { loadedLocalModel, localModelId as idFor } from '../lib/llm/local-models'
import { OpenAIProvider, type ReasoningEffort } from '../lib/llm/openai'
import type { LLMProvider } from '../lib/llm/types'
import { getSessionKey } from '../lib/storage/secrets'
import { db, putSetting } from '../lib/storage/db'

export interface EngineSettings {
  provider: 'local' | 'openai'
  localF16: boolean
  openaiModel: string
  effort: ReasoningEffort
}

export const DEFAULT_ENGINE: EngineSettings = {
  provider: 'local',
  localF16: true,
  openaiModel: 'gpt-6-luna',
  effort: 'high',
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
  return idFor(settings.localF16)
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
  const { LocalProvider } = await import('../lib/llm/local')
  return new LocalProvider(modelId)
}
