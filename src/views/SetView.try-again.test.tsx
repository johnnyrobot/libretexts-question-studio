// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVICE_LOST_ERROR } from '../lib/llm/fixtures'
import { completeWithRetries, type LLMProvider } from '../lib/llm/types'
import { SAMPLE_DRAFTS } from '../lib/qti/fixtures'
import { db } from '../lib/storage/db'
import { FakeLocks } from '../lib/storage/fixtures'
import { startGeneration } from '../state/generation'
import { SetView } from './SetView'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Its own file because a run a lost GPU stopped is kept in memory (LT-236).
const { item_type: _, ...essay } = SAMPLE_DRAFTS.find((d) => d.item_type === 'essay')!
void _

// Writes essay questions on the in-browser engine; once one is written, the
// GPU is lost on every call until the test fixes it. Reloading the model
// waits until the test lets it finish.
function flakyGpu() {
  let written = 0
  const gpu = { fixed: false, reloaded: () => {} }
  const provider: LLMProvider = {
    id: 'local',
    model: 'fake',
    recover: () => (gpu.fixed ? new Promise<void>((resolve) => (gpu.reloaded = resolve)) : Promise.resolve()),
    complete: (request) =>
      completeWithRetries(request, async () => {
        if (request.schemaName === 'concept_batch') {
          const concept = { label: 'Light', description: 'What leaves capture', source_paragraphs: [0], quantitative: false }
          return { text: JSON.stringify({ concepts: [concept] }), usage: null }
        }
        if (written && !gpu.fixed) throw new Error(DEVICE_LOST_ERROR)
        written++
        return { text: JSON.stringify({ ...essay, citation_paragraphs: [0] }), usage: null }
      }),
  }
  return { provider, gpu }
}

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  vi.unstubAllGlobals()
})

beforeEach(async () => {
  vi.stubGlobal('navigator', { ...navigator, locks: new FakeLocks() })
  await Promise.all([db.items.clear(), db.sets.clear(), db.sources.clear(), db.settings.clear()])
  await db.sources.put({
    id: 's', kind: 'page', title: 'Leaves', library: 'bio', url: null, license: null, createdAt: 1,
    pages: [{ title: 'Leaves', url: null, pageId: '1', paragraphs: [{ index: 0, text: 'Leaves capture light.', start: 0, end: 21 }] }],
  })
  await db.sets.put({
    id: 'set', title: 'Leaf quiz', sourceId: 's', provider: 'local', model: 'm', status: 'generating', error: null,
    requested: { itemTypes: ['essay'], count: 3, reviewPass: false }, createdAt: 1, updatedAt: 1,
  })
})

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

async function render() {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<SetView setId="set" tab="review" />))
  cleanup = () => {
    act(() => root.unmount())
    container.remove()
    cleanup = null
  }
  await settle()
  await settle()
  const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) ?? null
  return { container, button }
}

describe('a run a lost GPU stopped', () => {
  it('offers Try again, which counts the questions already written and writes the rest', async () => {
    const { provider, gpu } = flakyGpu()
    const source = (await db.sources.get('s'))!
    await startGeneration('set', source, { itemTypes: ['essay'], perPage: 3, reviewPass: false }, provider)
    const view = await render()
    expect(view.container.querySelector('.dismissible')?.textContent).toContain('The questions written so far were kept.')

    gpu.fixed = true
    await act(async () => view.button('Try again')!.click())
    await settle()
    // While the model loads again, the run counts the question it kept.
    expect(view.container.querySelector('.run-card')?.textContent).toContain('1 of 3 questions written')

    gpu.reloaded()
    for (let wait = 0; wait < 40 && view.container.querySelector('.run-card'); wait++) await settle()
    expect(view.container.querySelectorAll('li.item')).toHaveLength(3)
    expect(view.button('Try again')).toBeNull()
  })

  it('keeps Try again after the message is dismissed', async () => {
    const { provider } = flakyGpu()
    const source = (await db.sources.get('s'))!
    await startGeneration('set', source, { itemTypes: ['essay'], perPage: 3, reviewPass: false }, provider)
    const view = await render()
    await act(async () => view.button('Dismiss')!.click())
    await settle()
    expect(view.button('Dismiss')).toBeNull()
    expect(view.button('Try again')).not.toBeNull()
  })
})
