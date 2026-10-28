// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../lib/storage/db'
import { FakeLocks } from '../lib/storage/fixtures'
import { saveEngineSettings } from '../state/engine'
import { Settings, type SettingsSection } from './Settings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let cleanup: (() => void) | null = null
afterEach(() => cleanup?.())
beforeEach(() => db.settings.clear())

// Lets the settings, which load from IndexedDB, reach the page.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

async function render(section: SettingsSection = 'engine') {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<Settings section={section} />))
  cleanup = () => {
    act(() => root.unmount())
    container.remove()
  }
  await settle()
  const checkbox = (label: string) =>
    [...container.querySelectorAll('label')].find((l) => l.textContent?.includes(label))?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!
  return { checkbox, button, container }
}

describe('OpenAI settings', () => {
  it('checks answer keys by default, and saves the choice to turn it off', async () => {
    await saveEngineSettings({ provider: 'openai' })
    const { checkbox } = await render()
    const answerCheck = checkbox('Check answer keys (uses extra API calls)')
    expect(answerCheck?.checked).toBe(true)
    await act(async () => answerCheck!.click())
    await settle()
    expect((await db.settings.get('engine'))?.value).toMatchObject({ answerCheck: false })
    expect(answerCheck?.checked).toBe(false)
  })
})

describe('Delete everything', () => {
  const locks = new FakeLocks()
  afterEach(async () => {
    locks.closeTab()
    vi.unstubAllGlobals()
    await db.sets.clear()
  })

  // A tab writing a set holds its lock (LT-74); clearing under it would leave
  // its questions orphaned (LT-89).
  it('refuses while a set is being written, naming it on the page', async () => {
    vi.stubGlobal('navigator', { locks })
    vi.stubGlobal('confirm', () => true)
    await db.sets.put({
      id: 'set', title: 'Leaf quiz', sourceId: 's', provider: 'local', model: 'm', status: 'generating', error: null,
      requested: { itemTypes: [], count: 1 }, createdAt: 1, updatedAt: 1,
    })
    void locks.request('generation:set', () => new Promise(() => {}))
    const { button, container } = await render('data')
    act(() => button('Delete all question sets and saved pages').click())
    await settle()
    expect(container.textContent).toContain('“Leaf quiz” is still being written. Delete everything once its questions are written.')
    expect(await db.sets.count()).toBe(1)
  })
})
