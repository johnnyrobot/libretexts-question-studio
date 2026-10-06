import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { SAMPLE_DRAFTS } from '../qti/fixtures'
import { completeWithRetries, LLMError, type CompletionRequest, type LLMProvider } from '../llm/types'
import { db, type StoredSource } from '../storage/db'
import { planUnits, repairDraft, runGeneration, stripSourceReferences } from './pipeline'
import type { ItemType } from './schema'

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
      paragraphs: [
        { index: 0, text: 'Plants absorb carbon dioxide and water.', start: 0, end: 39 },
        { index: 1, text: 'Chlorophyll captures light energy and releases oxygen.', start: 41, end: 95 },
      ],
    },
  ],
}

// Answers concept prompts with one concept and item prompts with the fixture
// of the requested type; optionally returns broken JSON first.
class FakeProvider implements LLMProvider {
  readonly id = 'openai' as const
  readonly model = 'fake'
  calls: string[] = []
  breakFirst = new Set<string>()

  complete<T>(request: CompletionRequest<T>) {
    return completeWithRetries(request, async (prompt) => {
      this.calls.push(request.schemaName)
      if (this.breakFirst.delete(request.schemaName)) return { text: '{"oops":', usage: null }
      if (request.schemaName === 'concept_batch') {
        return {
          text: JSON.stringify({
            concepts: [{ label: 'Inputs', description: 'What plants take in', source_paragraphs: [0, 1, 99], quantitative: true }],
          }),
          usage: null,
        }
      }
      const type = request.schemaName.replace(/_item$/, '') as ItemType
      const { item_type: _, ...payload } = SAMPLE_DRAFTS.find((d) => d.item_type === type)!
      void _
      void prompt
      return { text: JSON.stringify(payload), usage: null }
    })
  }
}

const callbacks = { onStatus: () => {}, onItem: () => {}, onProgress: () => {} }

beforeEach(async () => {
  await db.items.clear()
  await db.sets.clear()
  await db.sets.add({
    id: 'set-1',
    title: 'Test',
    sourceId: 'src-1',
    provider: 'openai',
    model: 'fake',
    status: 'generating',
    error: null,
    requested: { itemTypes: [], count: 0 },
    createdAt: 0,
    updatedAt: 0,
  })
})

describe('runGeneration', () => {
  it('rotates through the requested types and saves each validated item', async () => {
    const provider = new FakeProvider()
    const types: ItemType[] = ['multiple_choice', 'true_false', 'matching']
    const result = await runGeneration('set-1', source, { itemTypes: types, perPage: 4, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result).toEqual({ created: 4, failures: [] })
    const items = await db.items.where('setId').equals('set-1').sortBy('position')
    expect(items.map((i) => i.draft.item_type)).toEqual(['multiple_choice', 'true_false', 'matching', 'multiple_choice'])
    expect(items.every((i) => i.status === 'draft' && i.draft.concept_label === 'Inputs')).toBe(true)
  })

  it('feeds validation errors back to the model and recovers', async () => {
    const provider = new FakeProvider()
    provider.breakFirst.add('multiple_choice_item')
    const result = await runGeneration('set-1', source, { itemTypes: ['multiple_choice'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result.created).toBe(1)
    expect(provider.calls).toEqual(['concept_batch', 'multiple_choice_item', 'multiple_choice_item'])
  })

  it('records a failure for an item that never validates and keeps going', async () => {
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    provider.complete = (request) =>
      request.schemaName === 'true_false_item'
        ? completeWithRetries(request, async () => ({ text: '{"title":"x"}', usage: null }))
        : original(request)
    const result = await runGeneration('set-1', source, { itemTypes: ['true_false', 'essay'], perPage: 2, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result.created).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatch(/true false/)
  })

  it('sends math spec errors back to the model with the reason', async () => {
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    const prompts: string[] = []
    let first = true
    provider.complete = (request) =>
      request.schemaName === 'math_item'
        ? completeWithRetries(request, async (prompt) => {
            prompts.push(prompt)
            const { item_type: _, ...payload } = SAMPLE_DRAFTS.find((d) => d.item_type === 'math')!
            void _
            const broken = first ? { ...payload, answer_formula: '2v / t' } : payload
            first = false
            return { text: JSON.stringify(broken), usage: null }
          })
        : original(request)
    const result = await runGeneration('set-1', source, { itemTypes: ['math'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result).toEqual({ created: 1, failures: [] })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('write multiplication explicitly')
    const [item] = await db.items.where('setId').equals('set-1').toArray()
    expect(item.draft.item_type).toBe('math')
  })

  it('writes another type when math is requested for a section without numbers', async () => {
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    provider.complete = (request) =>
      request.schemaName === 'concept_batch'
        ? completeWithRetries(request, async () => ({
            text: JSON.stringify({ concepts: [{ label: 'Inputs', description: 'What plants take in', source_paragraphs: [0], quantitative: false }] }),
            usage: null,
          }))
        : original(request)
    const result = await runGeneration('set-1', source, { itemTypes: ['math', 'essay'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result.created).toBe(1)
    const [item] = await db.items.where('setId').equals('set-1').toArray()
    expect(item.draft.item_type).toBe('essay')
    expect(item.critique[0]).toMatch(/math \(randomized numbers\) question was requested/)
  })

  it('retries a response cut off at the output limit, but not other engine errors', async () => {
    const mathPayload = () => {
      const { item_type: _, ...payload } = SAMPLE_DRAFTS.find((d) => d.item_type === 'math')!
      void _
      return JSON.stringify(payload)
    }
    const run = async (failure: LLMError) => {
      await db.items.clear()
      const provider = new FakeProvider()
      const original = provider.complete.bind(provider)
      const prompts: string[] = []
      provider.complete = (request) =>
        request.schemaName === 'math_item'
          ? completeWithRetries(request, async (prompt, attempt) => {
              prompts.push(prompt)
              if (attempt === 1) throw failure
              return { text: mathPayload(), usage: null }
            })
          : original(request)
      const result = await runGeneration('set-1', source, { itemTypes: ['math'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
      return { result, prompts }
    }
    const cutOff = await run(new LLMError('The response was cut off at the output limit.', true))
    expect(cutOff.result.created).toBe(1)
    expect(cutOff.prompts[1]).toContain('cut off at the output limit')
    const notLoaded = await run(new LLMError('The in-browser model is not loaded.'))
    expect(notLoaded.result.created).toBe(0)
    expect(notLoaded.prompts).toHaveLength(1)
    expect(notLoaded.result.failures[0]).toMatch(/not loaded/)
  })

  it('rejects citations outside the section shown to the model', async () => {
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    provider.complete = (request) =>
      request.schemaName === 'essay_item'
        ? completeWithRetries(request, async () => {
            const { item_type: _, ...payload } = SAMPLE_DRAFTS.find((d) => d.item_type === 'essay')!
            void _
            return { text: JSON.stringify({ ...payload, citation_paragraphs: [7] }), usage: null }
          })
        : original(request)
    const result = await runGeneration('set-1', source, { itemTypes: ['essay'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result.created).toBe(0)
    expect(result.failures[0]).toMatch(/citation_paragraphs 7/)
  })
})

describe('planUnits', () => {
  // Each paragraph also costs ~16 characters for its "[paragraph N]" label.
  it('splits long pages into budget-sized sections and spreads questions by length', () => {
    const paragraphs = Array.from({ length: 10 }, (_, index) => ({ index, text: 'x'.repeat(1_000), start: 0, end: 1_000 }))
    const plans = planUnits({ ...source, pages: [{ ...source.pages[0], paragraphs }] }, 5, 3_100)
    // 3+3+3+1 paragraphs; the short last section gets none of the 5 questions
    // and is dropped.
    expect(plans.map((p) => p.unit.paragraphs.length)).toEqual([3, 3, 3])
    expect(plans.map((p) => p.count)).toEqual([2, 2, 1])
  })
})

describe('stripSourceReferences', () => {
  it('removes references to "the text" that students never saw', () => {
    expect(stripSourceReferences('Which statement best defines mass according to the provided text?')).toBe(
      'Which statement best defines mass?',
    )
    expect(stripSourceReferences('According to the text, mass is constant.')).toBe('Mass is constant.')
    expect(stripSourceReferences('The textbook says nothing odd.')).toBe('The textbook says nothing odd.')
    expect(stripSourceReferences('Match each term to its definition as found in the source text.')).toBe(
      'Match each term to its definition.',
    )
  })
})

describe('repairDraft', () => {
  const { item_type: _, ...math } = SAMPLE_DRAFTS.find((d) => d.item_type === 'math')!
  void _

  it('uses a 1% tolerance when a model marks inexact answers exact', () => {
    expect(repairDraft('math', { ...math, tolerance_percent: 0 })).toEqual({ ...math, tolerance_percent: 1 })
  })

  it('leaves exact answers, other mistakes and other types alone', () => {
    const exact = { ...math, answer_formula: 'v + t', tolerance_percent: 0 }
    expect(repairDraft('math', exact)).toBe(exact)
    const broken = { ...math, answer_formula: '2v / t', tolerance_percent: 0 }
    expect(repairDraft('math', broken)).toBe(broken)
    const numerical = { tolerance: 0 }
    expect(repairDraft('numerical', numerical)).toBe(numerical)
  })
})
