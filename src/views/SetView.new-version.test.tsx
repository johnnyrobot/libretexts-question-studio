// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { completeWithRetries, type LLMProvider } from '../lib/llm/types'
import { SAMPLE_DRAFTS } from '../lib/qti/fixtures'
import { db, type StoredItem } from '../lib/storage/db'
import { FakeLocks } from '../lib/storage/fixtures'
import { SetView } from './SetView'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Its own file because writing a new version needs a ready engine, stood in
// for here by a scripted one for the whole file (LT-201).
const NOT_LOADED = 'Load Gemma 4 E4B in Settings first (one-time download).'
const engine: { provider: LLMProvider | string } = { provider: NOT_LOADED }
vi.mock('../state/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state/engine')>()),
  createProvider: async () => engine.provider,
  createEmbedder: async () => null,
}))

const { item_type: _, ...essay } = SAMPLE_DRAFTS.find((d) => d.item_type === 'essay')!
void _
const KEY_NOTE = 'An automatic answer check disagrees with the answer key: it judged the statement false.'

// Writes one essay question titled "The new version" once the test lets it,
// or fails as told.
function scriptedEngine(fail?: Error) {
  let resume = () => {}
  const resumed = new Promise<void>((resolve) => (resume = resolve))
  engine.provider = {
    id: 'local',
    model: 'fake',
    complete: (request) =>
      completeWithRetries(request, async () => {
        await resumed
        request.signal?.throwIfAborted()
        if (fail) throw fail
        return { text: JSON.stringify({ ...essay, title: 'The new version', citation_paragraphs: [0] }), usage: null }
      }),
  }
  return { resume }
}

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  vi.unstubAllGlobals()
})

beforeEach(async () => {
  engine.provider = NOT_LOADED
  vi.stubGlobal('navigator', { ...navigator, locks: new FakeLocks() })
  await Promise.all([db.items.clear(), db.sets.clear(), db.sources.clear(), db.settings.clear()])
  await db.sources.put({
    id: 's', kind: 'page', title: 'Leaves', library: 'bio', url: null, license: null, createdAt: 1,
    pages: [{ title: 'Leaves', url: null, pageId: '1', paragraphs: [{ index: 0, text: 'Leaves capture light.', start: 0, end: 21 }] }],
  })
  await db.sets.put({
    id: 'set', title: 'Leaf quiz', sourceId: 's', provider: 'local', model: 'm', status: 'complete', error: null,
    requested: { itemTypes: ['essay'], count: 2, reviewPass: false }, createdAt: 1, updatedAt: 1,
  })
  const question = (id: string, position: number, title: string): StoredItem => ({
    id, setId: 'set', position, status: 'approved', sourcePageIndex: 0, critique: ['A note on the current version'],
    draft: { ...SAMPLE_DRAFTS.find((d) => d.item_type === 'essay')!, title },
    concept: { label: 'Light', description: 'What leaves capture', source_paragraphs: [0], quantitative: false },
    createdAt: 1, updatedAt: 1,
  })
  await db.items.bulkPut([question('item', 0, 'The current version'), question('other', 1, 'Another question')])
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
  // The source loads once the set has.
  await settle()
  await settle()
  const card = (index = 0) => container.querySelectorAll<HTMLElement>('li.item')[index]
  const button = (label: string, index = 0) =>
    [...card(index).querySelectorAll('button')].find((b) => b.textContent?.trim() === label) ?? null
  const press = async (label: string, index = 0) => {
    await act(async () => button(label, index)!.click())
    await settle()
  }
  // What the card has announced to a screen reader most recently.
  const announced = (index = 0) => card(index).querySelector('.new-version-status')?.textContent || null
  // The run's database work takes longer than one settle.
  const finished = async () => {
    for (let wait = 0; wait < 40 && card().querySelector('.new-version-run'); wait++) await settle()
  }
  return { container, card, button, press, announced, finished }
}

describe('writing a new version of a question', () => {
  it('drafts it while showing progress, then shows it beside the current one until one is kept', async () => {
    const { resume } = scriptedEngine()
    const view = await render()
    await view.press('Write a new version')
    expect(view.announced()).toMatch(/^Writing a/)
    expect(view.card().querySelector('progress')).not.toBeNull()
    expect(view.button('Cancel')).not.toBeNull()
    resume()
    await view.finished()
    expect(view.announced()).toBe('A new version is ready. Compare it with the current one, then keep one.')
    expect(view.card().querySelector('progress')).toBeNull()
    const pending = view.card().querySelector('.new-version')!
    expect(pending.textContent).toContain('The new version')
    // Until it is chosen, the question is the current version, export included.
    expect((await db.items.get('item'))?.draft.title).toBe('The current version')
    expect(view.card().querySelector('h2')?.textContent).toContain('The current version')
  })

  // A keyboard user waiting on Cancel would lose focus with it.
  it('moves focus from Cancel to the new version once it is written', async () => {
    const { resume } = scriptedEngine()
    const view = await render()
    await view.press('Write a new version')
    act(() => view.button('Cancel')!.focus())
    resume()
    await view.finished()
    expect(document.activeElement?.id).toBe('new-version-item')
  })

  // Once on the question, focus stays where the instructor takes it.
  it('moves focus from Cancel to the question when the draft fails, and leaves it there', async () => {
    const { resume } = scriptedEngine(new Error('The model stopped.'))
    const view = await render()
    await view.press('Write a new version')
    act(() => view.button('Cancel')!.focus())
    resume()
    await view.finished()
    expect(document.activeElement?.id).toBe('item-item')
    act(() => view.button('Write a new version', 1)!.focus())
    // Written in another tab, or restored from a backup.
    const current = await db.items.get('item')
    await db.items.update('item', { newVersion: { draft: current!.draft, critique: [], concept: current!.concept!, createdAt: 2 } })
    await settle()
    expect(view.card().querySelector('.new-version')).not.toBeNull()
    expect(document.activeElement).toBe(view.button('Write a new version', 1))
  })

  it('makes the new version the question, to review again, when it is kept', async () => {
    const { resume } = scriptedEngine()
    const view = await render()
    await view.press('Write a new version')
    resume()
    await view.finished()
    await view.press('Keep the new version')
    const item = await db.items.get('item')
    expect(item).toMatchObject({ status: 'draft', draft: { title: 'The new version' } })
    expect(item?.newVersion).toBeUndefined()
    expect(view.card().querySelector('.new-version')).toBeNull()
    expect(view.announced()).toBe('Kept the new version. Review it before you export.')
    expect(document.activeElement?.id).toBe('item-item')
  })

  // The run's last status outlives it, but a card shown afresh has nothing to say.
  it('says nothing old when the question is shown again after a choice', async () => {
    const { resume } = scriptedEngine()
    let view = await render()
    await view.press('Write a new version')
    resume()
    await view.finished()
    await view.press('Keep the new version')
    cleanup?.()
    view = await render()
    expect(view.announced()).toBeNull()
  })

  // Kept, it needs review again, so it leaves a list of approved questions.
  it('moves focus to the next question when the kept version leaves the list shown', async () => {
    const { resume } = scriptedEngine()
    const view = await render()
    const approvedTab = [...view.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.startsWith('Approved'))!
    await act(async () => approvedTab.click())
    await view.press('Write a new version')
    resume()
    await view.finished()
    await view.press('Keep the new version')
    expect((await db.items.get('item'))?.status).toBe('draft')
    expect(document.activeElement?.id).toBe('item-other')
  })

  it('leaves the question as it was when the current version is kept', async () => {
    const { resume } = scriptedEngine()
    const view = await render()
    await view.press('Write a new version')
    resume()
    await view.finished()
    await view.press('Keep the current version')
    const item = await db.items.get('item')
    expect(item).toMatchObject({ status: 'approved', draft: { title: 'The current version' }, critique: ['A note on the current version'] })
    expect(item?.newVersion).toBeUndefined()
    expect(view.announced()).toBe('Kept the current version.')
    expect(document.activeElement?.id).toBe('item-item')
  })

  it('keeps the current version when cancelled', async () => {
    const { resume } = scriptedEngine()
    const view = await render()
    await view.press('Write a new version')
    await view.press('Cancel')
    resume()
    await view.finished()
    expect(view.announced()).toBe('Stopped. The current version is kept.')
    expect(view.card().querySelector('.new-version')).toBeNull()
    expect((await db.items.get('item'))?.newVersion).toBeUndefined()
    expect(document.activeElement?.id).toBe('item-item')
  })

  it('keeps the current version when the draft fails, and says why', async () => {
    const { resume } = scriptedEngine(new Error('The model stopped.'))
    const view = await render()
    await view.press('Write a new version')
    resume()
    await view.finished()
    expect(view.announced()).toMatch(/^Couldn’t write a new version: .* The current version is kept\.$/)
    expect(view.card().querySelector('.new-version')).toBeNull()
    expect((await db.items.get('item'))?.draft.title).toBe('The current version')
  })

  it('says what to do when the engine is not ready, and writes nothing', async () => {
    const view = await render()
    await view.press('Write a new version')
    expect(view.announced()).toBe(NOT_LOADED)
    expect((await db.items.get('item'))?.newVersion).toBeUndefined()
  })

  it('writes one new version at a time', async () => {
    const { resume } = scriptedEngine()
    const view = await render()
    await view.press('Write a new version')
    expect(view.button('Write a new version', 1)?.disabled).toBe(true)
    resume()
    await view.finished()
    expect(view.button('Write a new version', 1)?.disabled).toBe(false)
  })

  it('still shows a new version waiting after the page is left, with its own notes', async () => {
    const current = await db.items.get('item')
    await db.items.update('item', {
      newVersion: { draft: { ...current!.draft, title: 'The new version' }, critique: [KEY_NOTE, 'A reviewer note'], concept: current!.concept!, createdAt: 2 },
    })
    const view = await render()
    const pending = view.card().querySelector<HTMLElement>('.new-version')!
    expect(pending.textContent).toContain('The new version')
    expect([...pending.querySelectorAll('.key-check li')].map((li) => li.textContent)).toEqual([KEY_NOTE])
    expect(pending.querySelector('.critique')?.textContent).toContain('A reviewer note')
    // The current version is approved, so its own reasons sit in its Notes.
    expect(view.card().querySelector(':scope > .key-check')).toBeNull()
    // Choose first: no second new version is written over this one.
    expect(view.button('Write a new version')).toBeNull()
  })
})
