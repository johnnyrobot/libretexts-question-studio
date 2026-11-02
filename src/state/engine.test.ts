import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, putSetting } from '../lib/storage/db'
import { engineSettings, localModelId, saveEngineSettings } from './engine'

const TUNED_9B = 'qwen35-9b-ftds-q4f16_1-v1'
const GEMMA_F16 = 'onnx-community/gemma-4-E4B-it-ONNX:q4f16'
const GEMMA_F32 = 'onnx-community/gemma-4-E4B-it-ONNX:q4'

// Settings as the app stored them before LT-237: every save wrote the model,
// so the old default, Gemma 4 E4B, was written whether or not it was picked.
const saved = (localModel: string) => ({
  provider: 'local',
  localModel,
  localF16: true,
  openaiModel: 'gpt-6-luna',
  effort: 'high',
  answerCheck: true,
  duplicateCheck: true,
})

beforeEach(() => db.settings.clear())

describe('which in-browser model writes the questions', () => {
  it('is the tuned Qwen3.5 9B on a GPU with 16-bit shaders', async () => {
    expect(localModelId(await engineSettings())).toBe(TUNED_9B)
  })

  it('is Gemma 4 E4B, the 32-bit build, on a GPU without them', async () => {
    await saveEngineSettings({ localF16: false })
    expect(localModelId(await engineSettings())).toBe(GEMMA_F32)
  })

  it('moves a teacher who had the old default to the tuned 9B', async () => {
    await putSetting('engine', saved('gemma-4-e4b'))
    expect(localModelId(await engineSettings())).toBe(TUNED_9B)
  })

  it('keeps Qwen3.5 4B for a teacher who picked it before, through later saves', async () => {
    await putSetting('engine', saved('qwen3.5-4b'))
    await saveEngineSettings({ localF16: true })
    expect(localModelId(await engineSettings())).toBe('Qwen3.5-4B-q4f16_1-MLC')
  })

  it('keeps Gemma 4 E4B once a teacher picks it', async () => {
    await saveEngineSettings({ pickedLocalModel: 'gemma-4-e4b' })
    expect(localModelId(await engineSettings())).toBe(GEMMA_F16)
  })

  it('falls back to Gemma 4 E4B when the picked tuned 9B cannot run on this GPU', async () => {
    await saveEngineSettings({
      pickedLocalModel: 'qwen3.5-9b-ftds',
      localF16: false,
    })
    expect(localModelId(await engineSettings())).toBe(GEMMA_F32)
  })
})
