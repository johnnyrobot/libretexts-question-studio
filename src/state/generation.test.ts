import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVICE_LOST_ERROR } from '../lib/llm/fixtures'
import { SAMPLE_DRAFTS } from '../lib/qti/fixtures'
import { completeWithRetries, type LLMProvider } from '../lib/llm/types'
import { db, type StoredSource } from '../lib/storage/db'
import { markInterruptedSets, startGeneration } from './generation'

const source: StoredSource = {
  id: 'src-1',
  kind: 'page',
  title: 'Photosynthesis',
  library: 'bio',
  url: 'https://bio.libretexts.org/x',
  license: null,
  createdAt: 0,
  pages: [
    {
      title: 'Photosynthesis',
      url: null,
      pageId: '1',
      paragraphs: [{ index: 0, text: 'Plants absorb carbon dioxide and water.', start: 0, end: 39 }],
    },
  ],
}

beforeEach(async () => {
  await db.items.clear()
  await db.sets.clear()
  await db.sets.add({
    id: 'set-1',
    title: 'Test',
    sourceId: 'src-1',
    provider: 'local',
    model: 'fake',
    status: 'generating',
    error: null,
    requested: { itemTypes: [], count: 0 },
    createdAt: 0,
    updatedAt: 0,
  })
})

describe('startGeneration', () => {
  it('reports a lost GPU as such, never as answers that failed the checks', async () => {
    let calls = 0
    // The in-browser engine as the worker reports a lost device to it.
    const provider: LLMProvider = {
      id: 'local',
      model: 'fake',
      complete: (request) =>
        completeWithRetries(request, async () => {
          calls++
          throw new Error(DEVICE_LOST_ERROR)
        }),
    }
    await startGeneration('set-1', source, { itemTypes: ['multiple_choice'], perPage: 1, reviewPass: false }, provider)
    const set = await db.sets.get('set-1')
    expect(set?.status).toBe('failed')
    expect(set?.error).toBe('The GPU stopped responding while writing questions. Reload the model in Settings, or close other GPU-heavy tabs, and try again.')
    expect(calls).toBe(1)
  })

  it('says the questions written before a lost GPU were kept', async () => {
    const { item_type: _, ...essay } = SAMPLE_DRAFTS.find((d) => d.item_type === 'essay')!
    void _
    let written = 0
    // Writes one essay question, then loses the GPU.
    const provider: LLMProvider = {
      id: 'local',
      model: 'fake',
      complete: (request) =>
        completeWithRetries(request, async () => {
          if (request.schemaName === 'concept_batch') {
            const concept = { label: 'Inputs', description: 'What plants take in', source_paragraphs: [0], quantitative: false }
            return { text: JSON.stringify({ concepts: [concept] }), usage: null }
          }
          if (written++) throw new Error(DEVICE_LOST_ERROR)
          return { text: JSON.stringify({ ...essay, citation_paragraphs: [0] }), usage: null }
        }),
    }
    await startGeneration('set-1', source, { itemTypes: ['essay'], perPage: 2, reviewPass: false }, provider)
    const set = await db.sets.get('set-1')
    expect(await db.items.where('setId').equals('set-1').count()).toBe(1)
    expect(set?.status).toBe('failed')
    expect(set?.error).toBe(
      'The GPU stopped responding while writing questions. The questions written so far were kept. Reload the model in Settings, or close other GPU-heavy tabs, and try again.',
    )
  })
})

// Web Locks as a browser shares them between an origin's tabs, exclusive mode
// only; Node has none.
class FakeLocks {
  private held = new Map<string, { released: Promise<void>; release: () => void }>()

  async request<T>(name: string, ...args: [(lock: object | null) => Promise<T>] | [{ ifAvailable?: boolean }, (lock: object | null) => Promise<T>]) {
    const [options, callback] = args.length === 1 ? [{}, args[0]] : args
    if (options.ifAvailable && this.held.has(name)) return callback(null)
    while (this.held.has(name)) await this.held.get(name)!.released
    let release = () => {}
    const hold = { released: new Promise<void>((resolve) => (release = resolve)), release: () => release() }
    this.held.set(name, hold)
    try {
      return await callback({ name, mode: 'exclusive' })
    } finally {
      if (this.held.get(name) === hold) this.held.delete(name)
      hold.release()
    }
  }

  // As a browser does when a tab closes: every lock it held is let go.
  closeTab() {
    for (const [name, hold] of this.held) {
      this.held.delete(name)
      hold.release()
    }
  }
}

// Starts writing set-1, one essay question, and pauses once the run is under
// way until the test lets it go on.
async function startPausedGeneration() {
  const { item_type: _, ...essay } = SAMPLE_DRAFTS.find((d) => d.item_type === 'essay')!
  void _
  let started = () => {}
  const hasStarted = new Promise<void>((resolve) => (started = resolve))
  let resume = () => {}
  const resumed = new Promise<void>((resolve) => (resume = resolve))
  const provider: LLMProvider = {
    id: 'local',
    model: 'fake',
    complete: (request) =>
      completeWithRetries(request, async () => {
        if (request.schemaName === 'concept_batch') {
          started()
          await resumed
          const concept = { label: 'Inputs', description: 'What plants take in', source_paragraphs: [0], quantitative: false }
          return { text: JSON.stringify({ concepts: [concept] }), usage: null }
        }
        return { text: JSON.stringify({ ...essay, citation_paragraphs: [0] }), usage: null }
      }),
  }
  const finished = startGeneration('set-1', source, { itemTypes: ['essay'], perPage: 1, reviewPass: false }, provider)
  await hasStarted
  return { resume, finished }
}

describe('markInterruptedSets', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // As on an http address other than localhost, where no tab can tell.
  it('marks every set still generating as interrupted without Web Locks', async () => {
    vi.stubGlobal('navigator', {})
    await markInterruptedSets()
    expect((await db.sets.get('set-1'))?.status).toBe('cancelled')
  })

  it('marks a set that no tab is generating as interrupted', async () => {
    vi.stubGlobal('navigator', { locks: new FakeLocks() })
    await markInterruptedSets()
    const set = await db.sets.get('set-1')
    expect(set?.status).toBe('cancelled')
    expect(set?.error).toBe('Interrupted when the app was closed. Questions written before that were kept.')
  })

  // A second tab, opened from a page link for instance, runs this on load (LT-74).
  it('leaves a set alone while a tab is still generating it', async () => {
    vi.stubGlobal('navigator', { locks: new FakeLocks() })
    const generation = await startPausedGeneration()
    await markInterruptedSets()
    expect(await db.sets.get('set-1')).toMatchObject({ status: 'generating', error: null })
    generation.resume()
    await generation.finished
    // The second tab, waiting on the lock, finds the set finished.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await db.sets.get('set-1')).toMatchObject({ status: 'complete', error: null })
  })

  it('marks the set as interrupted once the tab generating it closes', async () => {
    const locks = new FakeLocks()
    vi.stubGlobal('navigator', { locks })
    const generation = await startPausedGeneration()
    await markInterruptedSets()
    locks.closeTab()
    await vi.waitFor(async () => expect((await db.sets.get('set-1'))?.status).toBe('cancelled'))
    // Lets the paused run end, so later tests can start one.
    generation.resume()
    await generation.finished
  })
})
