// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../lib/storage/db'
import { saveEngineSettings } from '../state/engine'
import { Settings } from './Settings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Its own file because both in-browser runtimes are stand-ins here: each keeps
// its downloaded models in `downloaded`, as the browser's cache would, and the
// files of a download that stopped part way in `partial`.
const TUNED_9B = 'qwen35-9b-ftds-q4f16_1-v1'
const GEMMA = 'onnx-community/gemma-4-E4B-it-ONNX:q4f16'

const { downloaded, partial, failLoad, fakeRuntime } = vi.hoisted(() => {
  const downloaded = new Set<string>()
  const partial = new Set<string>()
  const failLoad = { value: false }
  const fakeRuntime = async () => {
    const { setLoadedLocalModel } = await import('../lib/llm/local-models')
    return {
      isModelCached: async (id: string) => downloaded.has(id),
      downloadBytes: async () => 5_000_000_000,
      gpuMemoryMB: () => null,
      async loadLocalModel(id: string) {
        if (failLoad.value) throw new Error('The GPU ran out of memory loading the model.')
        downloaded.add(id)
        setLoadedLocalModel(id, () => undefined)
      },
      unloadLocalModel: () => setLoadedLocalModel(null),
      async deleteCachedModel(id: string) {
        downloaded.delete(id)
        partial.delete(id)
      },
      createProvider: () => {
        throw new Error('not used')
      },
      embedder: { isCached: async () => true, downloadBytes: async () => null },
    }
  }
  return { downloaded, partial, failLoad, fakeRuntime }
})
vi.mock('../lib/llm/local', fakeRuntime)
vi.mock('../lib/llm/transformers', fakeRuntime)

let cleanup: (() => void) | null = null
beforeEach(async () => {
  downloaded.clear()
  partial.clear()
  failLoad.value = false
  await db.settings.clear()
  vi.stubGlobal('navigator', {
    ...navigator,
    gpu: {
      requestAdapter: async () => ({ features: new Set(['shader-f16']) }),
    },
  })
})
afterEach(async () => {
  cleanup?.()
  vi.unstubAllGlobals()
  ;(await import('../lib/llm/local-models')).setLoadedLocalModel(null)
})

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

async function render() {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<Settings section="engine" />))
  cleanup = () => {
    act(() => root.unmount())
    container.remove()
    cleanup = null
  }
  await settle()
  await settle()
  const button = (start: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(start))
  return { container, button }
}

describe('a teacher who had Gemma 4 E4B', () => {
  it('gets the tuned Qwen3.5 9B, and its download frees Gemma’s files', async () => {
    downloaded.add(GEMMA)
    const view = await render()
    expect(
      view.container.querySelector<HTMLInputElement>('input[name="local-model"]:checked')?.parentElement?.textContent,
    ).toContain('Qwen3.5 9B, tuned for questions')

    await act(async () => view.button('Download and load')!.click())
    await settle()

    expect([...downloaded]).toEqual([TUNED_9B])
    expect(view.container.textContent).toContain('Gemma 4 E4B’s downloaded files were deleted to free disk space.')
  })

  it('also frees what a stopped Gemma download left behind', async () => {
    partial.add(GEMMA)
    const view = await render()

    await act(async () => view.button('Download and load')!.click())
    await settle()

    expect([...partial]).toEqual([])
    expect([...downloaded]).toEqual([TUNED_9B])
  })

  it('keeps Gemma’s files when the tuned 9B does not load', async () => {
    downloaded.add(GEMMA)
    failLoad.value = true
    const view = await render()

    await act(async () => view.button('Download and load')!.click())
    await settle()

    expect([...downloaded]).toEqual([GEMMA])
  })

  it('keeps Gemma’s files when Gemma is the model the teacher picked', async () => {
    downloaded.add(GEMMA)
    await saveEngineSettings({ pickedLocalModel: 'gemma-4-e4b' })
    const view = await render()

    await act(async () => view.button('Load model')!.click())
    await settle()

    expect([...downloaded]).toEqual([GEMMA])
  })
})
