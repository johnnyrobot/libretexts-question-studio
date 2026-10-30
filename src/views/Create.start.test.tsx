// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../lib/storage/db'
import { Create } from './Create'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Its own file because starting a set needs a ready engine, stood in for here
// for the whole file, and the run itself is not what is checked.
vi.mock('../state/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state/engine')>()),
  createProvider: async () => ({ id: 'local', model: 'fake', complete: async () => ({ text: '{}', usage: null }) }),
  createEmbedder: async () => null,
}))
vi.mock('../state/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state/generation')>()),
  startGeneration: async () => {},
}))

let cleanup: (() => void) | null = null
afterEach(() => cleanup?.())

beforeEach(async () => {
  await Promise.all([db.sets.clear(), db.sources.clear(), db.settings.clear()])
  await db.sources.put({
    id: 'source-1', kind: 'page', title: 'Leaves', library: 'bio', url: null, license: null,
    pages: [{ title: 'Leaves', url: null, pageId: '1', paragraphs: [] }], createdAt: 0,
  })
})

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)))

async function startSet(untick?: string) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<Create sourceId="source-1" />))
  cleanup = () => {
    act(() => root.unmount())
    container.remove()
  }
  await settle()
  if (untick) {
    act(() => [...container.querySelectorAll('label')].find((l) => l.textContent?.startsWith(untick))!.querySelector('input')!.click())
    await settle()
  }
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Write'))!.click())
  await settle()
  const [set] = await db.sets.toArray()
  return set
}

// A new version of a question is checked as the first one was (LT-201).
describe('the checks a set is written with', () => {
  it('records the second-pass review as on by default', async () => {
    expect((await startSet()).requested).toMatchObject({ reviewPass: true })
  })

  it('records the second-pass review as off when it is turned off', async () => {
    expect((await startSet('Second-pass review')).requested).toMatchObject({ reviewPass: false })
  })
})
