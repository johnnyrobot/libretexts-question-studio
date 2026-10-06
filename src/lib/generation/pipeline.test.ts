import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { SAMPLE_DRAFTS } from '../qti/fixtures'
import { completeWithRetries, LLMError, type CompletionRequest, type LLMProvider } from '../llm/types'
import { db, type StoredSource } from '../storage/db'
import { planUnits, repairDraft, runGeneration, stripSourceReferences } from './pipeline'
import type { DraftOf, ItemType } from './schema'

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

// A math draft as the model returns it: the fixture (v / t) plus the example
// it worked by hand.
const mathPayload = (patch: Record<string, unknown> = {}) => {
  const { item_type: _, ...payload } = SAMPLE_DRAFTS.find((d) => d.item_type === 'math')!
  void _
  const worked_example = { values: [{ name: 'v', value: 6 }, { name: 't', value: 12 }], working: '6 mL / 12 min = 0.5 mL/min', answer: 0.5 }
  return { ...payload, worked_example, ...patch }
}

// Answers concept prompts with one concept and item prompts with the fixture
// of the requested type, citing the paragraphs the prompt shows; optionally
// returns broken JSON first.
class FakeProvider implements LLMProvider {
  readonly id: LLMProvider['id']
  readonly model = 'fake'
  calls: string[] = []
  breakFirst = new Set<string>()

  constructor(id: LLMProvider['id'] = 'openai') {
    this.id = id
  }

  complete<T>(request: CompletionRequest<T>) {
    return completeWithRetries(request, async (prompt) => {
      this.calls.push(request.schemaName)
      if (this.breakFirst.delete(request.schemaName)) return { text: '{"oops":', usage: null }
      if (request.schemaName === 'item_review') {
        // A reviewer with nothing to change.
        const draft = JSON.parse(prompt.slice(prompt.indexOf('<draft>') + 7, prompt.indexOf('</draft>')))
        return { text: JSON.stringify({ issues: [], revised: draft }), usage: null }
      }
      if (request.schemaName === 'concept_batch') {
        return {
          text: JSON.stringify({
            concepts: [{ label: 'Inputs', description: 'What plants take in', source_paragraphs: [0, 1, 99], quantitative: true }],
          }),
          usage: null,
        }
      }
      const type = request.schemaName.replace(/_item$/, '') as ItemType
      const { item_type: _, ...fixture } = SAMPLE_DRAFTS.find((d) => d.item_type === type)!
      void _
      const citation_paragraphs = [...prompt.matchAll(/\[paragraph (\d+)\]/g)].map((m) => Number(m[1]))
      const payload = type === 'math' ? mathPayload() : fixture
      return { text: JSON.stringify({ ...payload, citation_paragraphs }), usage: null }
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
            const broken = first ? mathPayload({ answer_formula: '2v / t' }) : mathPayload()
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
    expect(item.critique[0]).toMatch(/math \(randomized numbers\) question was requested, but no quantitative content was found on this page/)
  })

  it('writes a math question from numbers elsewhere on the page when its section has none', async () => {
    // Two sections under the 40,000-character budget; the one question goes
    // to the longer first one, which has no numbers.
    const paragraphs = source.pages[0].paragraphs.map((p, i) => ({ ...p, text: p.text.repeat(i ? 400 : 800) }))
    const long = { ...source, pages: [{ ...source.pages[0], paragraphs }] }
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    const conceptPrompts: string[] = []
    provider.complete = (request) =>
      request.schemaName === 'concept_batch'
        ? completeWithRetries(request, async (prompt) => {
            conceptPrompts.push(prompt)
            const second = prompt.includes('[paragraph 1]')
            const concept = second
              ? { label: 'Oxygen release rate', description: 'Volume of oxygen per minute', source_paragraphs: [1], quantitative: true }
              : { label: 'Inputs', description: 'What plants take in', source_paragraphs: [0], quantitative: false }
            return { text: JSON.stringify({ concepts: [concept] }), usage: null }
          })
        : original(request)
    const result = await runGeneration('set-1', long, { itemTypes: ['math'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result).toEqual({ created: 1, failures: [] })
    expect(conceptPrompts).toHaveLength(2)
    expect(conceptPrompts[0]).toContain('All of the questions will be calculations')
    const [item] = await db.items.where('setId').equals('set-1').toArray()
    expect(item.draft.item_type).toBe('math')
    expect(item.draft.concept_label).toBe('Oxygen release rate')
    expect(item.draft.citation_paragraphs).toEqual([1])
    expect(item.critique).toEqual([])
  })

  it('rejects a math draft whose formula disagrees with its own worked example', async () => {
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    const prompts: string[] = []
    provider.complete = (request) =>
      request.schemaName === 'math_item'
        ? completeWithRetries(request, async (prompt, attempt) => {
            prompts.push(prompt)
            // (v + 2) / t written without its parentheses.
            const patch = { answer_formula: attempt === 1 ? 'v + 2 / t' : '(v + 2) / t' }
            const worked_example = { values: [{ name: 'v', value: 6 }, { name: 't', value: 4 }], working: '(6 + 2) / 4 = 2', answer: 2 }
            return { text: JSON.stringify(mathPayload({ ...patch, worked_example })), usage: null }
          })
        : original(request)
    const result = await runGeneration('set-1', source, { itemTypes: ['math'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result).toEqual({ created: 1, failures: [] })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('"v + 2 / t" gives 6.5, but worked_example.answer is 2')
    const [item] = await db.items.where('setId').equals('set-1').toArray()
    const draft = item.draft as DraftOf<'math'>
    expect(draft.answer_formula).toBe('(v + 2) / t')
    expect(draft).not.toHaveProperty('worked_example')
  })

  it('skips the review pass for math questions on the in-browser model only', async () => {
    const local = new FakeProvider('local')
    await runGeneration('set-1', source, { itemTypes: ['math', 'essay'], perPage: 2, reviewPass: true }, local, new AbortController().signal, callbacks)
    expect(local.calls.filter((c) => c !== 'concept_batch')).toEqual(['math_item', 'essay_item', 'item_review'])
    const openai = new FakeProvider('openai')
    await runGeneration('set-1', source, { itemTypes: ['math'], perPage: 1, reviewPass: true }, openai, new AbortController().signal, callbacks)
    expect(openai.calls).toContain('item_review')
  })

  it('retries a response cut off at the output limit, but not other engine errors', async () => {
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
              return { text: JSON.stringify(mathPayload()), usage: null }
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

  it('lets the reviewer reword a math question but not change what it computes', async () => {
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    const { item_type: _, ...math } = SAMPLE_DRAFTS.find((d) => d.item_type === 'math')!
    void _
    provider.complete = (request) =>
      request.schemaName === 'item_review'
        ? completeWithRetries(request, async () => ({
            text: JSON.stringify({
              issues: ['The parentheses in the formula are redundant.'],
              revised: { ...math, title: 'Reworded title', answer_formula: 'v + t / 2', tolerance_percent: 5 },
            }),
            usage: null,
          }))
        : original(request)
    const result = await runGeneration('set-1', source, { itemTypes: ['math'], perPage: 1, reviewPass: true }, provider, new AbortController().signal, callbacks)
    expect(result.created).toBe(1)
    const [item] = await db.items.where('setId').equals('set-1').toArray()
    const draft = item.draft as DraftOf<'math'>
    expect(draft.title).toBe('Reworded title')
    expect(draft.answer_formula).toBe(math.answer_formula)
    expect(draft.tolerance_percent).toBe(math.tolerance_percent)
    expect(item.critique).toContain('The parentheses in the formula are redundant.')
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
    // but is kept for calculation questions to borrow from.
    expect(plans.map((p) => p.unit.paragraphs.length)).toEqual([3, 3, 3, 1])
    expect(plans.map((p) => p.count)).toEqual([2, 2, 1, 0])
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

  it('gives a zero step the largest round step that keeps ten or more values', () => {
    const variables = [
      { name: 't', min: 0.5, max: 3, step: 0 },
      { name: 'u', min: 0.5, max: 10, step: 0 },
      { name: 'v', min: 10, max: 200, step: 0 },
      { name: 'w', min: 10, max: 100, step: 5 },
    ]
    const repaired = repairDraft('math', { ...math, variables }) as typeof math
    expect(repaired.variables.map((v) => v.step)).toEqual([0.1, 0.5, 10, 5])
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
