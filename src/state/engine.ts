import { useLiveQuery } from 'dexie-react-hooks'
import {
  defaultLocalModel,
  loadedLocalModel,
  localModel,
  localRuntime,
  probeWebGPU,
  type LocalModel,
  type LocalModelKey,
} from '../lib/llm/local-models'
import { OpenAIProvider, type ReasoningEffort } from '../lib/llm/openai'
import type { Embedder, LLMProvider } from '../lib/llm/types'
import { getSessionKey } from '../lib/storage/secrets'
import { db, putSetting } from '../lib/storage/db'

export interface EngineSettings {
  provider: 'local' | 'openai'
  // The in-browser model the teacher picked; null is the best this GPU runs.
  pickedLocalModel: LocalModelKey | null
  localF16: boolean
  openaiModel: string
  effort: ReasoningEffort
  // Check OpenAI's answer keys too, at extra calls (the in-browser model
  // always checks them).
  answerCheck: boolean
  // Flag questions that repeat one already in the set (EmbeddingGemma 2).
  duplicateCheck: boolean
}

export const DEFAULT_ENGINE: EngineSettings = {
  provider: 'local',
  pickedLocalModel: null,
  localF16: true,
  openaiModel: 'gpt-6-luna',
  effort: 'high',
  answerCheck: true,
  duplicateCheck: true,
}

const KEY = 'engine'

// Settings saved before LT-237 hold `localModel` instead, written on every
// save. Gemma 4 E4B was the default then, so only Qwen3.5 4B there was a pick.
type StoredEngine = Partial<EngineSettings> & { localModel?: LocalModelKey }

function fromStored(stored: StoredEngine | undefined): EngineSettings {
  const { localModel: before, ...settings } = stored ?? {}
  return {
    ...DEFAULT_ENGINE,
    ...settings,
    pickedLocalModel:
      settings.pickedLocalModel !== undefined ? settings.pickedLocalModel : before === 'qwen3.5-4b' ? before : null,
  }
}

export function useEngineSettings(): EngineSettings {
  const row = useLiveQuery(() => db.settings.get(KEY), [])
  return fromStored(row?.value as StoredEngine | undefined)
}

export async function engineSettings(): Promise<EngineSettings> {
  return fromStored((await db.settings.get(KEY))?.value as StoredEngine | undefined)
}

export async function saveEngineSettings(update: Partial<EngineSettings>): Promise<void> {
  await putSetting(KEY, { ...(await engineSettings()), ...update })
}

// The picked model where this GPU runs it, otherwise the best one it runs.
export function chosenLocalModel(settings: EngineSettings): LocalModel {
  const picked = settings.pickedLocalModel ? localModel(settings.pickedLocalModel) : null
  if (picked && (settings.localF16 || !picked.f16Only)) return picked
  return localModel(defaultLocalModel(settings.localF16))
}

export function localModelId(settings: EngineSettings): string {
  return chosenLocalModel(settings).build(settings.localF16)
}

// Returns a ready provider, or a sentence telling the instructor what to do.
export async function createProvider(settings: EngineSettings): Promise<LLMProvider | string> {
  if (settings.provider === 'openai') {
    const key = getSessionKey()
    if (!key) return 'Add your OpenAI API key in Settings to generate with OpenAI.'
    return new OpenAIProvider({ apiKey: key, model: settings.openaiModel, effort: settings.effort })
  }
  const model = chosenLocalModel(settings)
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
