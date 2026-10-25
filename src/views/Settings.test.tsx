// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../lib/storage/db'
import { saveEngineSettings } from '../state/engine'
import { Settings } from './Settings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let cleanup: (() => void) | null = null
afterEach(() => cleanup?.())
beforeEach(() => db.settings.clear())

// Lets the settings, which load from IndexedDB, reach the page.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

async function render() {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<Settings section="engine" />))
  cleanup = () => {
    act(() => root.unmount())
    container.remove()
  }
  await settle()
  const checkbox = (label: string) =>
    [...container.querySelectorAll('label')].find((l) => l.textContent?.includes(label))?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  return { checkbox }
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
