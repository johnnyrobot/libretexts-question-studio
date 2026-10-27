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
class TabLocks {
  private held = new Map<string, Promise<void>>()

  async request<T>(name: string, ...args: [(lock: object | null) => Promise<T>] | [{ ifAvailable?: boolean }, (lock: object | null) => Promise<T>]) {
    const [options, callback] = args.length === 1 ? [{}, args[0]] : args
    if (options.ifAvailable && this.held.has(name)) return callback(null)
    while (this.held.has(name)) await this.held.get(name)
    let release = () => {}
    this.held.set(name, new Promise((resolve) => (release = resolve)))
    try {
      return await callback({ name, mode: 'exclusive' })
    } finally {
      this.held.delete(name)
      release()
    }
  }
}

describe('markInterruptedSets', () => {
  // As on an http address other than localhost, where no tab can tell.
  it('marks every set still generating as interrupted without Web Locks', async () => {
    vi.stubGlobal('navigator', {})
    await markInterruptedSets()
    expect((await db.sets.get('set-1'))?.status).toBe('cancelled')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks a set that no tab is generating as interrupted', async () => {
    vi.stubGlobal('navigator', { locks: new TabLocks() })
    await markInterruptedSets()
    const set = await db.sets.get('set-1')
    expect(set?.status).toBe('cancelled')
    expect(set?.error).toBe('Interrupted when the app was closed. Questions written before that were kept.')
  })

  // A second tab, opened from a page link for instance, runs this on load (LT-74).
  it('leaves a set alone while a tab is still generating it', async () => {
    vi.stubGlobal('navigator', { locks: new TabLocks() })
    const { item_type: _, ...essay } = SAMPLE_DRAFTS.find((d) => d.item_type === 'essay')!
    void _
    let started = () => {}
    const writing = new Promise<void>((resolve) => (started = resolve))
    let finish = () => {}
    const finished = new Promise<void>((resolve) => (finish = resolve))
    // Writes one essay question once the test lets it.
    const provider: LLMProvider = {
      id: 'local',
      model: 'fake',
      complete: (request) =>
        completeWithRetries(request, async () => {
          if (request.schemaName === 'concept_batch') {
            started()
            await finished
            const concept = { label: 'Inputs', description: 'What plants take in', source_paragraphs: [0], quantitative: false }
            return { text: JSON.stringify({ concepts: [concept] }), usage: null }
          }
          return { text: JSON.stringify({ ...essay, citation_paragraphs: [0] }), usage: null }
        }),
    }
    const generation = startGeneration('set-1', source, { itemTypes: ['essay'], perPage: 1, reviewPass: false }, provider)
    await writing
    await markInterruptedSets()
    expect(await db.sets.get('set-1')).toMatchObject({ status: 'generating', error: null })
    finish()
    await generation
    expect(await db.sets.get('set-1')).toMatchObject({ status: 'complete', error: null })
  })
})
