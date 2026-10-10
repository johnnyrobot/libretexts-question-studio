import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SAMPLE_DRAFTS } from '../qti/fixtures'
import { completeWithRetries, LLMError, repairLatexEscapes, type CompletionRequest, type Embedder, type LLMProvider } from '../llm/types'
import { db, type StoredSource } from '../storage/db'
import { checkWorkedExample } from '../math/spec'
import {
  bareLatexToMath,
  blankedDraft,
  bracketsToDelimiters,
  cleanReviewNotes,
  controlsToBackslashes,
  dollarsToDelimiters,
  fillIn,
  givenAway,
  planUnits,
  repairDraft,
  runGeneration,
  sameAnswer,
  stripParagraphMentions,
  stripSourceClaims,
  stripSourceReferences,
  symbolsToMath,
  withFinalValue,
  WordIndex,
} from './pipeline'
import { checkModelDraft, parseDraft, type DraftOf, type ItemType } from './schema'

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
  // The answer check's answers, one list per call; after that it agrees with
  // the fixture's key.
  keyAnswers: number[][] = []
  // The blank check's answers and the words offered for a new blank; after
  // them it fills in the fixture's key.
  blankAnswers: string[] = []
  blankWords: string[][] = []
  // The true/false check's answers; after them it agrees with the fixture.
  trueFalseAnswers: boolean[] = []

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
      if (request.schemaName === 'key_check') {
        const type = prompt.includes('select-all') ? 'multiple_answers' : 'multiple_choice'
        const fixture = SAMPLE_DRAFTS.find((d): d is DraftOf<'multiple_choice' | 'multiple_answers'> => d.item_type === type)!
        const answers = this.keyAnswers.shift() ?? fixture.choices.flatMap((c, i) => (c.correct ? [i + 1] : []))
        return { text: JSON.stringify({ working: '1 wrong: …', answers }), usage: null }
      }
      if (request.schemaName === 'blank_check') {
        return { text: JSON.stringify({ answer: this.blankAnswers.shift() ?? 'chlorophyll' }), usage: null }
      }
      if (request.schemaName === 'blank_choice') {
        return { text: JSON.stringify({ words: this.blankWords.shift() ?? ['pigment'] }), usage: null }
      }
      if (request.schemaName === 'true_false_check') {
        return { text: JSON.stringify({ working: 'true: …', answer: this.trueFalseAnswers.shift() ?? true }), usage: null }
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
    expect(result).toEqual({ created: 4, skipped: 0, errors: [] })
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

  it('starts a question afresh when every attempt fails the checks', async () => {
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    const prompts: string[] = []
    const { item_type: _, ...fixture } = SAMPLE_DRAFTS.find((d) => d.item_type === 'true_false')!
    void _
    provider.complete = (request) =>
      request.schemaName === 'true_false_item'
        ? completeWithRetries(request, async (prompt) => {
            prompts.push(prompt)
            const payload = prompts.length <= 3 ? { title: 'x' } : { ...fixture, citation_paragraphs: [0] }
            return { text: JSON.stringify(payload), usage: null }
          })
        : original(request)
    const result = await runGeneration('set-1', source, { itemTypes: ['true_false'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result).toEqual({ created: 1, skipped: 0, errors: [] })
    expect(prompts).toHaveLength(4)
    // The fresh start does not carry the first round's errors.
    expect(prompts[2]).toContain('previous response was rejected')
    expect(prompts[3]).not.toContain('previous response was rejected')
  })

  it('leaves out a question that fails in every round, without an error, and keeps going', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    let attempts = 0
    provider.complete = (request) =>
      request.schemaName === 'true_false_item'
        ? completeWithRetries(request, async () => {
            attempts++
            return { text: '{"title":"x"}', usage: null }
          })
        : original(request)
    const result = await runGeneration('set-1', source, { itemTypes: ['true_false', 'essay'], perPage: 2, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result).toEqual({ created: 1, skipped: 1, errors: [] })
    // Three rounds of three attempts.
    expect(attempts).toBe(9)
    expect(warn.mock.calls[0][1]).toMatch(/did not return a valid true_false_item/)
    warn.mockRestore()
  })

  it('starts the search for concepts afresh too', async () => {
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    let rounds = 0
    provider.complete = (request) =>
      request.schemaName === 'concept_batch' && ++rounds === 1
        ? completeWithRetries(request, async () => ({ text: '{"concepts":[]}', usage: null }))
        : original(request)
    const result = await runGeneration('set-1', source, { itemTypes: ['essay'], perPage: 2, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result).toEqual({ created: 2, skipped: 0, errors: [] })
    expect(rounds).toBe(2)
  })

  it('sends back concepts labelled only with their kind, such as "Concept"', async () => {
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    const prompts: string[] = []
    provider.complete = (request) =>
      request.schemaName === 'concept_batch'
        ? completeWithRetries(request, async (prompt) => {
            prompts.push(prompt)
            const label = prompts.length === 1 ? 'Concept' : 'Gas exchange'
            return { text: JSON.stringify({ concepts: [{ label, description: 'What plants take in', source_paragraphs: [0], quantitative: false }] }), usage: null }
          })
        : original(request)
    await runGeneration('set-1', source, { itemTypes: ['essay'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('label "Concept" says what kind of concept it is')
    const [item] = await db.items.where('setId').equals('set-1').toArray()
    expect(item.draft.concept_label).toBe('Gas exchange')
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
    expect(result).toEqual({ created: 1, skipped: 0, errors: [] })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('write multiplication explicitly')
    const [item] = await db.items.where('setId').equals('set-1').toArray()
    expect(item.draft.item_type).toBe('math')
  })

  it('sends back a draft with a stray symbol where the model meant LaTeX', async () => {
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    const prompts: string[] = []
    provider.complete = (request) =>
      request.schemaName === 'fill_in_blank_item'
        ? completeWithRetries(request, async (prompt) => {
            prompts.push(prompt)
            const { item_type: _, ...fixture } = SAMPLE_DRAFTS.find((d) => d.item_type === 'fill_in_blank')!
            void _
            const explanation = prompts.length === 1 ? 'It captures light energy (ℰ).' : 'It captures light energy \\(E\\).'
            return { text: JSON.stringify({ ...fixture, explanation, citation_paragraphs: [0] }), usage: null }
          })
        : original(request)
    const result = await runGeneration('set-1', source, { itemTypes: ['fill_in_blank'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result.created).toBe(1)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('"ℰ" stands where a symbol or formula should be')
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
    expect(result).toEqual({ created: 1, skipped: 0, errors: [] })
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
    expect(result).toEqual({ created: 1, skipped: 0, errors: [] })
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

  it('checks multiple-choice, select-all, true/false and fill-in-the-blank keys on the in-browser model only', async () => {
    const local = new FakeProvider('local')
    const types: ItemType[] = ['multiple_choice', 'multiple_answers', 'true_false', 'fill_in_blank', 'essay']
    const plan = { itemTypes: types, perPage: 5, reviewPass: false }
    await runGeneration('set-1', source, plan, local, new AbortController().signal, callbacks)
    expect(local.calls.filter((c) => c !== 'concept_batch')).toEqual([
      'multiple_choice_item',
      'key_check',
      'multiple_answers_item',
      'key_check',
      'true_false_item',
      'true_false_check',
      'fill_in_blank_item',
      'blank_check',
      'essay_item',
    ])
    const items = await db.items.where('setId').equals('set-1').toArray()
    expect(items.every((i) => i.critique.length === 0)).toBe(true)
    const openai = new FakeProvider('openai')
    await runGeneration('set-1', source, plan, openai, new AbortController().signal, callbacks)
    expect(openai.calls.filter((c) => /_check$|^blank_choice$/.test(c))).toEqual([])
  })

  it('blanks another word when the check fills the blank differently, keeping the sentence', async () => {
    const run = async (blankAnswers: string[], blankWords: string[][]) => {
      await db.items.clear()
      const provider = new FakeProvider('local')
      provider.blankAnswers = blankAnswers
      provider.blankWords = blankWords
      const plan = { itemTypes: ['fill_in_blank'] as ItemType[], perPage: 1, reviewPass: false }
      await runGeneration('set-1', source, plan, provider, new AbortController().signal, callbacks)
      const [item] = await db.items.where('setId').equals('set-1').toArray()
      return { calls: provider.calls.filter((c) => c !== 'concept_batch'), item, draft: item.draft as DraftOf<'fill_in_blank'> }
    }
    // The first word offered is filled differently too; the second passes.
    const fixed = await run(['chloroplast', 'absorbs', 'green'], [['captures', 'green']])
    expect(fixed.calls).toEqual(['fill_in_blank_item', 'blank_check', 'blank_choice', 'blank_check', 'blank_check'])
    expect(fixed.draft.stem).toBe('The ____ pigment that captures light is called chlorophyll.')
    expect(fixed.draft.answer).toBe('green')
    expect(fixed.draft.alternates).toEqual([])
    expect(fixed.item.critique).toEqual([])
    // No word offered is in the sentence: the question stays, with a note.
    const unfixed = await run(['chloroplast'], [['photosynthesis']])
    expect(unfixed.calls).toEqual(['fill_in_blank_item', 'blank_check', 'blank_choice'])
    expect(unfixed.draft.answer).toBe('chlorophyll')
    expect(unfixed.item.critique).toEqual([
      'An automatic check filled the blank with “chloroplast”, not “chlorophyll”: students may give an answer other than the key and be marked wrong.',
    ])
  })

  it('drops the reviewer’s notes on a blank that is replaced', async () => {
    const run = async (blankAnswers: string[]) => {
      await db.items.clear()
      const provider = new FakeProvider('local')
      provider.blankAnswers = blankAnswers
      provider.blankWords = [['green']]
      const original = provider.complete.bind(provider)
      provider.complete = (request) =>
        request.schemaName === 'item_review'
          ? completeWithRetries(request, async (prompt) => {
              const draft = JSON.parse(prompt.slice(prompt.indexOf('<draft>') + 7, prompt.indexOf('</draft>')))
              return { text: JSON.stringify({ issues: ['Chloroplast fits the blank too.'], revised: draft }), usage: null }
            })
          : original(request)
      const plan = { itemTypes: ['fill_in_blank'] as ItemType[], perPage: 1, reviewPass: true }
      await runGeneration('set-1', source, plan, provider, new AbortController().signal, callbacks)
      const [item] = await db.items.where('setId').equals('set-1').toArray()
      return item
    }
    // The check fills in "chloroplast", so "green" is blanked instead.
    const moved = await run(['chloroplast', 'green'])
    expect((moved.draft as DraftOf<'fill_in_blank'>).answer).toBe('green')
    expect(moved.critique).toEqual([])
    const kept = await run([])
    expect((kept.draft as DraftOf<'fill_in_blank'>).answer).toBe('chlorophyll')
    expect(kept.critique).toEqual(['Chloroplast fits the blank too.'])
  })

  it('drops a reviewer note that repeats the problem it was sent back with', async () => {
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    let attempts = 0
    provider.complete = (request) =>
      request.schemaName === 'item_review'
        ? completeWithRetries(request, async (prompt) => {
            const draft = JSON.parse(prompt.slice(prompt.indexOf('<draft>') + 7, prompt.indexOf('</draft>')))
            attempts++
            // First a revision that gives the answer away, then the draft as
            // it was, listing that problem.
            const revised = attempts === 1 ? { ...draft, stem: `${draft.stem} (${draft.answer})` } : draft
            const issues = attempts === 1 ? [] : [`The stem gives the answer away: "${draft.answer}" already appears in it.`, 'The stem could name the pigment.']
            return { text: JSON.stringify({ issues, revised }), usage: null }
          })
        : original(request)
    await runGeneration('set-1', source, { itemTypes: ['fill_in_blank'], perPage: 1, reviewPass: true }, provider, new AbortController().signal, callbacks)
    const [item] = await db.items.where('setId').equals('set-1').toArray()
    expect(attempts).toBe(2)
    expect(item.critique).toEqual(['The stem could name the pigment.'])
  })

  it('blanks a word instead of a number key on the in-browser model', async () => {
    const provider = new FakeProvider('local')
    provider.blankAnswers = ['680 nm', 'red']
    provider.blankWords = [['680 nm', 'red']]
    const original = provider.complete.bind(provider)
    provider.complete = (request) =>
      request.schemaName === 'fill_in_blank_item'
        ? completeWithRetries(request, async () => {
            const { item_type: _, ...fixture } = SAMPLE_DRAFTS.find((d) => d.item_type === 'fill_in_blank')!
            void _
            const draft = { ...fixture, stem: 'Chlorophyll absorbs red light of about ____.', answer: '680 nm', alternates: [], citation_paragraphs: [0] }
            return { text: JSON.stringify(draft), usage: null }
          })
        : original(request)
    await runGeneration('set-1', source, { itemTypes: ['fill_in_blank'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    const [item] = await db.items.where('setId').equals('set-1').toArray()
    const draft = item.draft as DraftOf<'fill_in_blank'>
    expect(draft.stem).toBe('Chlorophyll absorbs ____ light of about 680 nm.')
    expect(draft.answer).toBe('red')
    expect(item.critique).toEqual([])
  })

  it('skips a new blank the textbook gives away, unless the key is one students cannot type', async () => {
    // This textbook nearly always writes "green" before "pigment".
    const texts = ['Chlorophyll is a green pigment.', 'A green pigment absorbs red light.', 'The green pigment reflects green light.', 'Leaves hold a green pigment.']
    let start = 0
    const paragraphs = texts.map((text, index) => {
      const paragraph = { index, text, start, end: start + text.length }
      start += text.length + 2
      return paragraph
    })
    const pigments: StoredSource = { ...source, pages: [{ ...source.pages[0], paragraphs }] }
    const run = async (draft: Partial<DraftOf<'fill_in_blank'>>, blankAnswers: string[], blankWords: string[][]) => {
      await db.items.clear()
      const provider = new FakeProvider('local')
      provider.blankAnswers = blankAnswers
      provider.blankWords = blankWords
      const original = provider.complete.bind(provider)
      provider.complete = (request) =>
        request.schemaName === 'fill_in_blank_item'
          ? completeWithRetries(request, async () => {
              const { item_type: _, ...fixture } = SAMPLE_DRAFTS.find((d) => d.item_type === 'fill_in_blank')!
              void _
              return { text: JSON.stringify({ ...fixture, ...draft, citation_paragraphs: [0] }), usage: null }
            })
          : original(request)
      await runGeneration('set-1', pigments, { itemTypes: ['fill_in_blank'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
      const [item] = await db.items.where('setId').equals('set-1').toArray()
      // The draft call is replaced above, so only the checks are counted.
      return { calls: provider.calls.filter((c) => c !== 'concept_batch'), draft: item.draft as DraftOf<'fill_in_blank'> }
    }
    // "The green ____" is not checked; the next word is.
    const skipped = await run({}, ['chloroplast', 'captures'], [['pigment', 'captures']])
    expect(skipped.calls).toEqual(['blank_check', 'blank_choice', 'blank_check'])
    expect(skipped.draft.stem).toBe('The green pigment that ____ light is called chlorophyll.')
    // An easy blank still replaces a number key.
    const typed = await run({ stem: 'The green pigment absorbs light of about ____.', answer: '680 nm', alternates: [] }, ['680 nm', 'pigment'], [['pigment']])
    expect(typed.calls).toEqual(['blank_check', 'blank_choice', 'blank_check'])
    expect(typed.draft.stem).toBe('The green ____ absorbs light of about 680 nm.')
    expect(typed.draft.answer).toBe('pigment')
    // A function word is skipped without a check.
    const filler = await run({ stem: 'Each green pigment that ____ light is called chlorophyll.', answer: 'captures', alternates: [] }, ['absorbs', 'chlorophyll'], [['Each', 'chlorophyll']])
    expect(filler.calls).toEqual(['blank_check', 'blank_choice', 'blank_check'])
    expect(filler.draft.stem).toBe('Each green pigment that captures light is called ____.')
  })

  it('sends back a fill-in-the-blank key that is only a function word', async () => {
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    const prompts: string[] = []
    provider.complete = (request) =>
      request.schemaName === 'fill_in_blank_item'
        ? completeWithRetries(request, async (prompt) => {
            prompts.push(prompt)
            const { item_type: _, ...fixture } = SAMPLE_DRAFTS.find((d) => d.item_type === 'fill_in_blank')!
            void _
            const broken = { stem: 'The green pigment ____ called chlorophyll.', answer: 'is', alternates: [] }
            return { text: JSON.stringify({ ...fixture, ...(prompts.length === 1 ? broken : {}), citation_paragraphs: [0] }), usage: null }
          })
        : original(request)
    const result = await runGeneration('set-1', source, { itemTypes: ['fill_in_blank'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result.created).toBe(1)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('"is" is a function word, not a term')
  })

  it('takes up to five new blanks, dropping an empty or overlong one', async () => {
    const provider = new FakeProvider('local')
    provider.blankAnswers = ['chloroplast', 'captures']
    provider.blankWords = [[' ', 'x'.repeat(90), 'leaf', 'photosynthesis', 'captures']]
    await runGeneration('set-1', source, { itemTypes: ['fill_in_blank'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(provider.calls.filter((c) => c !== 'concept_batch')).toEqual(['fill_in_blank_item', 'blank_check', 'blank_choice', 'blank_check'])
    const [item] = await db.items.where('setId').equals('set-1').toArray()
    expect((item.draft as DraftOf<'fill_in_blank'>).answer).toBe('captures')
  })

  it('notes a true/false key the check disagrees with, without sending it back', async () => {
    const provider = new FakeProvider('local')
    provider.trueFalseAnswers = [false]
    await runGeneration('set-1', source, { itemTypes: ['true_false'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(provider.calls.filter((c) => c !== 'concept_batch')).toEqual(['true_false_item', 'true_false_check'])
    const [item] = await db.items.where('setId').equals('set-1').toArray()
    expect((item.draft as DraftOf<'true_false'>).answer).toBe(true)
    expect(item.critique).toEqual(['An automatic answer check disagrees with the answer key: it judged the statement false.'])
  })

  it('asks the reviewer to fix a fill-in-the-blank answer students cannot type exactly, and notes it if it stays', async () => {
    const run = async (reviewPass: boolean) => {
      await db.items.clear()
      const provider = new FakeProvider('openai')
      const original = provider.complete.bind(provider)
      const reviews: string[] = []
      provider.complete = (request) => {
        if (request.schemaName === 'item_review') {
          reviews.push(request.prompt)
          // A reviewer that lists the problem without fixing it.
          return completeWithRetries(request, async (prompt) => {
            const draft = JSON.parse(prompt.slice(prompt.indexOf('<draft>') + 7, prompt.indexOf('</draft>')))
            const issues = ['The answer 680 nm is a number, not a word.', 'The stem could name the pigment.']
            return { text: JSON.stringify({ issues, revised: draft }), usage: null }
          })
        }
        if (request.schemaName !== 'fill_in_blank_item') return original(request)
        return completeWithRetries(request, async (prompt) => {
          const { item_type: _, ...fixture } = SAMPLE_DRAFTS.find((d) => d.item_type === 'fill_in_blank')!
          void _
          const citation_paragraphs = [...prompt.matchAll(/\[paragraph (\d+)\]/g)].map((m) => Number(m[1]))
          const draft = { ...fixture, stem: 'Chlorophyll absorbs red light of about ____.', answer: '680 nm', alternates: [], citation_paragraphs }
          return { text: JSON.stringify(draft), usage: null }
        })
      }
      const plan = { itemTypes: ['fill_in_blank'] as ItemType[], perPage: 1, reviewPass }
      const result = await runGeneration('set-1', source, plan, provider, new AbortController().signal, callbacks)
      const [item] = await db.items.where('setId').equals('set-1').toArray()
      return { result, reviews, critique: item.critique }
    }
    const note = 'Students must type the answer exactly, and "680 nm" is a number, symbol or equation that many will type differently, so they would be marked wrong.'
    // The reviewer changes nothing, so the answer stays and the instructor is told
    // once: its own note about the same answer is dropped.
    const reviewed = await run(true)
    expect(reviewed.result.created).toBe(1)
    expect(reviewed.reviews[0]).toContain(`${note} Fix this without listing it`)
    expect(reviewed.critique).toEqual(['The stem could name the pigment.', note])
    const unreviewed = await run(false)
    expect(unreviewed.reviews).toEqual([])
    expect(unreviewed.critique).toEqual([note])
  })

  it('keeps the question as it is when the answer check cannot run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = new FakeProvider('local')
    const original = provider.complete.bind(provider)
    provider.complete = (request) =>
      request.schemaName === 'key_check' ? completeWithRetries(request, async () => ({ text: '{"working": "x", "answers": []}', usage: null })) : original(request)
    const result = await runGeneration('set-1', source, { itemTypes: ['multiple_choice'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result).toEqual({ created: 1, skipped: 0, errors: [] })
    const [item] = await db.items.where('setId').equals('set-1').toArray()
    expect(item.critique).toEqual([])
    expect(warn).toHaveBeenCalledWith('Answer check unavailable:', expect.anything())
    warn.mockRestore()
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
    // Not started afresh either: the instructor has to load the model.
    const notLoaded = await run(new LLMError('The in-browser model is not loaded.'))
    expect(notLoaded.result).toEqual({ created: 0, skipped: 0, errors: ['The in-browser model is not loaded.'] })
    expect(notLoaded.prompts).toHaveLength(1)
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = new FakeProvider()
    const original = provider.complete.bind(provider)
    const prompts: string[] = []
    provider.complete = (request) =>
      request.schemaName === 'essay_item'
        ? completeWithRetries(request, async (prompt) => {
            prompts.push(prompt)
            const { item_type: _, ...payload } = SAMPLE_DRAFTS.find((d) => d.item_type === 'essay')!
            void _
            return { text: JSON.stringify({ ...payload, citation_paragraphs: [7] }), usage: null }
          })
        : original(request)
    const result = await runGeneration('set-1', source, { itemTypes: ['essay'], perPage: 1, reviewPass: false }, provider, new AbortController().signal, callbacks)
    expect(result).toEqual({ created: 0, skipped: 1, errors: [] })
    expect(prompts[1]).toMatch(/citation_paragraphs 7/)
    warn.mockRestore()
  })
})

describe('fill-in-the-blank checks', () => {
  const draft = { ...SAMPLE_DRAFTS.find((d) => d.item_type === 'fill_in_blank')! } as DraftOf<'fill_in_blank'>

  it('treats case, articles, punctuation and plurals as the same answer', () => {
    expect(sameAnswer('Systems', 'the system.')).toBe(true)
    expect(sameAnswer('forces', 'force')).toBe(true)
    expect(sameAnswer('masses', 'mass')).toBe(true)
    expect(sameAnswer('\\(F_{net}\\)', 'F_{net}')).toBe(true)
    expect(sameAnswer('objects', 'systems')).toBe(false)
    expect(sameAnswer("Newton's third law of motion", "Newton's Third Law")).toBe(false)
  })

  it('fills the blank in, writing a word the key repeats once', () => {
    expect(fillIn('An ____ force acts between elements of the system.', 'internal force')).toBe('An internal force acts between elements of the system.')
    expect(fillIn('Acceleration is ____ to the net force.', 'proportional to')).toBe('Acceleration is proportional to the net force.')
    expect(fillIn('w = mg = (1.0 kg) (____).', '9.8 m/s^2')).toBe('w = mg = (1.0 kg) (9.8 m/s^2).')
    expect(fillIn('Forces come in ____.', 'pairs')).toBe('Forces come in pairs.')
  })

  it('blanks a word that is in the prose exactly once, keeping its case', () => {
    const sentence = 'The Green pigment that captures \\(green\\) light is called chlorophyll.'
    expect(blankedDraft(draft, sentence, 'green')).toBeNull()
    const ok = blankedDraft(draft, 'The Green pigment that captures light is called chlorophyll.', 'green')
    expect(ok?.stem).toBe('The ____ pigment that captures light is called chlorophyll.')
    expect(ok?.answer).toBe('Green')
    // Not in the sentence, the old key, a number, too long, or a function word.
    expect(blankedDraft(draft, 'The pigment is called chlorophyll.', 'leaf')).toBeNull()
    expect(blankedDraft(draft, 'Each pigment captures light.', 'Each')).toBeNull()
    expect(blankedDraft(draft, 'The down quark is the lighter one.', 'down')?.answer).toBe('down')
    expect(blankedDraft(draft, 'The pigment is called chlorophyll.', 'chlorophyll')).toBeNull()
    expect(blankedDraft(draft, 'The pigment absorbs 680 nm light.', '680 nm')).toBeNull()
    expect(blankedDraft(draft, 'Its weight is 9.8 N.', 'N')).toBeNull()
    expect(blankedDraft(draft, 'The pigment that captures light in plants is green.', 'captures light in plants')).toBeNull()
  })
})

describe('givenAway', () => {
  const textbook = new WordIndex([
    'The net external force is the sum of all external forces. A net external force causes acceleration.',
    'When the net external force is zero, the acceleration is zero. Forces always occur in pairs.',
  ])
  const none = new WordIndex([])

  it('flags a word the textbook nearly always writes next to the blank', () => {
    expect(textbook.count(['net', 'external'])).toBe(3)
    expect(givenAway('A larger net external ____ gives a larger acceleration.', 'force', textbook)).toBe(true)
    expect(givenAway('Forces always occur in ____.', 'pairs', textbook)).toBe(false)
  })

  it('leaves out the copy of the sentence the question comes from', () => {
    const page = ['Friction opposes motion between surfaces.', 'In summary, friction opposes motion.', 'Friction: a force that opposes motion.']
    expect(givenAway('Friction opposes ____ between surfaces.', 'motion', new WordIndex(page))).toBe(false)
    expect(givenAway('Friction opposes ____ between surfaces.', 'motion', new WordIndex([...page, 'Static friction opposes motion too.']))).toBe(true)
  })

  it('reads the question and the textbook the same way', () => {
    // Curly and straight apostrophes, and a blank before "'s".
    const newton = new WordIndex(Array(4).fill('Newton’s second law relates force and acceleration.'))
    expect(givenAway('____ second law of motion relates force, mass and acceleration.', "Newton's", newton)).toBe(true)
    expect(givenAway("By ____'s second law, the acceleration depends on the net force.", 'Newton', newton)).toBe(true)
    // Math is not counted as words.
    const net = new WordIndex([
      'The net external force on a system is written \\(F_{\\text{net}}\\).',
      'A net external force causes acceleration, so \\(F_{\\text{net}} = ma\\).',
      'If the net external force is zero, \\(F_{\\text{net}} = 0\\).',
      'The net external force and \\(F_{\\text{net}}\\) are the same.',
    ])
    expect(givenAway('If there is no net ____ on the system, its velocity stays constant.', 'external force', net)).toBe(true)
    // A plural is the same word.
    expect(givenAway('Both walls exert normal ____ on the block.', 'forces', new WordIndex(Array(4).fill('The normal force acts on the block.')))).toBe(true)
    // A phrase does not run on across math or from one paragraph to the next.
    expect(new WordIndex(['the net', 'force']).count(['net', 'force'])).toBe(0)
    expect(new WordIndex(['the net \\(x\\) force']).count(['net', 'force'])).toBe(0)
  })

  it('flags a word whose opposite the sentence contrasts with it', () => {
    expect(givenAway('An ____ force acts from outside the system, while an internal force acts within it.', 'external', none)).toBe(true)
    expect(givenAway('An ____ acts from outside the system, while an internal force acts within it.', 'external force', none)).toBe(true)
    expect(givenAway('____ forces act between molecules, while intramolecular forces act within one.', 'intermolecular', none)).toBe(true)
    expect(givenAway('A uniform field is the same everywhere, but a ____ field varies.', 'nonuniform', none)).toBe(true)
    expect(givenAway('Kinetic energy is conserved in an ____ collision but not in an inelastic one.', 'elastic', none)).toBe(true)
    // Not opposites, or not contrasted.
    expect(givenAway('The ____ of a spring is proportional to the tension in it, not to its length.', 'extension', none)).toBe(false)
    expect(givenAway('Heat ____ between two bodies causes a change in temperature.', 'exchange', none)).toBe(false)
    expect(givenAway('An ____ force and an internal force act on the cart.', 'external', none)).toBe(false)
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

  it('also removes "the context provided" and "the provided information", only where a clause ends', () => {
    expect(stripSourceReferences('Which statements describe the relationship based on the context provided? Select all that apply.')).toBe(
      'Which statements describe the relationship? Select all that apply.',
    )
    expect(stripSourceReferences('Mass is constant. Based on the provided information, which statement is true?')).toBe(
      'Mass is constant. Which statement is true?',
    )
    expect(stripSourceReferences('The force, according to the text, is internal.')).toBe('The force is internal.')
    const kept = 'A larger force gives a larger acceleration, as shown in the context of the two children pushing the wagon.'
    expect(stripSourceReferences(kept)).toBe(kept)
  })
})

describe('stripSourceClaims', () => {
  it('writes a reported clause or quotation as the claim itself', () => {
    expect(stripSourceClaims('The source states that the net force causes acceleration.')).toBe('The net force causes acceleration.')
    // Also the textbook, as stripParagraphMentions writes it for "Paragraph 10 explicitly states".
    expect(stripSourceClaims('The textbook explicitly states, "Mass is constant."')).toBe('Mass is constant.')
    expect(stripSourceClaims('Mass is constant. The text explicitly states that weight varies.')).toBe('Mass is constant. Weight varies.')
    expect(stripSourceClaims('The text explicitly states, "An internal force acts between elements of the system."')).toBe(
      'An internal force acts between elements of the system.',
    )
    expect(stripSourceClaims('The excerpt states: "forces always occur in pairs".')).toBe('Forces always occur in pairs.')
    expect(stripSourceClaims("The source states, 'Each problem needs its own system.' The answer is internal.")).toBe(
      'Each problem needs its own system. The answer is internal.',
    )
    expect(stripSourceClaims('The text states that forces are internal. It also explicitly states that friction is external.')).toBe(
      'Forces are internal. Friction is external.',
    )
    expect(stripSourceClaims('The text states that mass does not vary, while weight does and does depend on gravity.')).toBe(
      'Mass does not vary, while weight does and does depend on gravity.',
    )
    expect(stripSourceClaims('The text states that \\(F_{prof}\\) is internal.')).toBe('\\(F_{prof}\\) is internal.')
    expect(stripSourceClaims('The text states that forces add. It also explicitly states, "Experiments confirm this."')).toBe(
      'Forces add. Experiments confirm this.',
    )
    expect(stripSourceClaims('The text states that these are internal. It also states that \\(F_{foot}\\) acts on the floor, not on the cart.')).toBe(
      'These are internal. \\(F_{foot}\\) acts on the floor, not on the cart.',
    )
  })

  it('makes the source the textbook where the claim cannot stand alone', () => {
    expect(stripSourceClaims('The text states that a larger force produces a larger acceleration, not that they are equal.')).toBe(
      'The textbook states that a larger force produces a larger acceleration, not that they are equal.',
    )
    expect(stripSourceClaims('The source explicitly states the relationship for weight: w = mg.')).toBe(
      'The textbook explicitly states the relationship for weight: w = mg.',
    )
    expect(stripSourceClaims('The text of the law is short.')).toBe('The text of the law is short.')
    expect(stripSourceClaims('The text states that a larger force gives a larger acceleration, but does not say how much.')).toBe(
      'The textbook states that a larger force gives a larger acceleration, but does not say how much.',
    )
    expect(stripSourceClaims('The text states that the net force equals ma, and provides the equation F = ma.')).toBe(
      'The textbook states that the net force equals ma, and provides the equation F = ma.',
    )
    expect(stripSourceClaims('The text states that motion changes, and that a force causes it.')).toBe(
      'The textbook states that motion changes, and that a force causes it.',
    )
    // A quotation that is not the whole rest of the sentence, or holds another one.
    expect(stripSourceClaims('The text states, "Mass is matter (how much “stuff”)" and later, "Mass is constant."')).toBe(
      'The textbook states, "Mass is matter (how much “stuff”)" and later, "Mass is constant."',
    )
    expect(stripSourceClaims('It states that mass is constant.')).toBe('It states that mass is constant.')
  })
})

describe('withFinalValue', () => {
  const math = SAMPLE_DRAFTS.find((d) => d.item_type === 'math') as DraftOf<'math'>

  it('ends an explanation that never gives the result with {{answer}} and the units', () => {
    const draft = { ...math, answer_formula: 'f_net / m', units: 'm/s^2', explanation: 'Acceleration is the net force divided by the mass: a = F_net / m' }
    expect(withFinalValue(draft).explanation).toBe(
      'Acceleration is the net force divided by the mass: a = F_net / m. With these numbers, the answer is {{answer}} m/s².',
    )
    // The math still compiles with the sentence added.
    expect(() => parseDraft('math', { ...withFinalValue(math), explanation: withFinalValue({ ...math, explanation: 'Divide.' }).explanation })).not.toThrow()
  })

  it('leaves one that shows {{answer}} or the answer formula', () => {
    const withAnswer = { ...math, explanation: 'Rate is {{v}} / {{t}} = {{answer}}.' }
    expect(withFinalValue(withAnswer)).toBe(withAnswer)
    const withFormula = { ...math, explanation: `Rate is {{ ${math.answer_formula} }} mL/min.` }
    expect(withFinalValue(withFormula)).toBe(withFormula)
  })
})

describe('stripParagraphMentions', () => {
  it('rewrites the paragraph citations Gemma 4 E4B wrote into explanations', () => {
    const cases: [string, string][] = [
      [
        'Paragraph 21 explicitly states that the acceleration of a system is inversely proportional to its mass.',
        'The textbook explicitly states that the acceleration of a system is inversely proportional to its mass.',
      ],
      ['Paragraph 24 and 26 both state the equation F_net = ma.', 'The textbook states the equation F_net = ma.'],
      [
        'The question asks for the formula, and paragraph 19 provides the formula: a = F_net / m.',
        'The question asks for the formula, and the textbook provides the formula: a = F_net / m.',
      ],
      ['The source states in paragraph 21 that acceleration is inversely proportional to mass.', 'The source states that acceleration is inversely proportional to mass.'],
      ['The source states in paragraph 21: "The acceleration of a system is …"', 'The source states: "The acceleration of a system is …"'],
      ['The source states in paragraph 19, "Newton’s second law is …"', 'The source states, "Newton’s second law is …"'],
      [
        'The text states that acceleration is inversely proportional to the mass of the system, as shown in paragraphs 14 and 21.',
        'The text states that acceleration is inversely proportional to the mass of the system.',
      ],
      [
        'acting on a system (Paragraph 10, 21), and that this is shown by \\(a \\propto F_{net}\\) (Paragraph 12).',
        'acting on a system, and that this is shown by \\(a \\propto F_{net}\\).',
      ],
      ['using the proportionality [paragraph 12] and explicitly states, "the net external force" [paragraph 13].', 'using the proportionality and explicitly states, "the net external force".'],
    ]
    for (const [text, expected] of cases) expect(stripParagraphMentions(text)).toBe(expected)
  })

  it('keeps sentences whole when the citation leads or interrupts them', () => {
    expect(stripParagraphMentions('As stated in paragraph 3, mass does not change with location.')).toBe('Mass does not change with location.')
    expect(stripParagraphMentions('According to paragraph 7, the net force is zero.')).toBe('The net force is zero.')
    expect(stripParagraphMentions('Mass stays the same; as noted in paragraph 3, weight does not.')).toBe('Mass stays the same; weight does not.')
    expect(stripParagraphMentions('Acceleration, as stated in paragraph 21, is inversely proportional to mass.')).toBe(
      'Acceleration is inversely proportional to mass.',
    )
    expect(stripParagraphMentions('This relationship is described in paragraph 21.')).toBe('This relationship is described in the textbook.')
  })

  it('leaves other text alone', () => {
    for (const text of ['Each paragraph of a lab report has one idea.', 'Mass is constant.']) expect(stripParagraphMentions(text)).toBe(text)
  })

  it('lets a draft that cites paragraphs pass the checks through repairDraft', () => {
    const { item_type: _, ...fib } = SAMPLE_DRAFTS.find((d) => d.item_type === 'fill_in_blank')!
    void _
    const explanation = 'Paragraph 21 explicitly states that the acceleration of a system is inversely proportional to its mass.'
    expect(() => checkModelDraft(parseDraft('fill_in_blank', { ...fib, explanation }))).toThrow(/paragraph numbers/)
    const repaired = parseDraft('fill_in_blank', repairDraft('fill_in_blank', { ...fib, explanation }))
    expect(() => checkModelDraft(repaired)).not.toThrow()
    expect(repaired.explanation).toBe('The textbook explicitly states that the acceleration of a system is inversely proportional to its mass.')
  })
})

// Gives each distinct text its own direction, so equal texts have similarity 1
// and different ones 0.
function fakeEmbedder(failLoad = false): Embedder & { texts: string[] } {
  const seen: string[] = []
  return {
    model: 'fake-embedder',
    texts: seen,
    load: async () => {
      if (failLoad) throw new Error('offline')
    },
    embed: async (texts) =>
      texts.map((text) => {
        seen.push(text)
        const vector = new Float32Array(16)
        vector[[...new Set(seen)].indexOf(text)] = 1
        return vector
      }),
  }
}

describe('duplicate check', () => {
  it('notes a question whose stem repeats one already in the set', async () => {
    const mc = SAMPLE_DRAFTS.find((d) => d.item_type === 'multiple_choice')!
    await db.items.add({
      id: 'old',
      setId: 'set-1',
      position: 0,
      status: 'approved',
      draft: mc,
      sourcePageIndex: 0,
      critique: [],
      createdAt: 0,
      updatedAt: 0,
    })
    const embedder = fakeEmbedder()
    const plan = { itemTypes: ['multiple_choice', 'essay'] as ItemType[], perPage: 2, reviewPass: false }
    await runGeneration('set-1', source, plan, new FakeProvider(), new AbortController().signal, callbacks, embedder)
    const items = await db.items.where('setId').equals('set-1').sortBy('position')
    const notes = items.slice(1).map((i) => i.critique.filter((note) => note.startsWith('Very similar')))
    // Positions continue the type rotation from the existing item: essay, then multiple choice.
    expect(items.slice(1).map((i) => i.draft.item_type)).toEqual(['essay', 'multiple_choice'])
    expect(notes[0]).toEqual([])
    expect(notes[1]).toHaveLength(1)
    expect(notes[1][0]).toContain(mc.stem.slice(0, 40))
  })

  it('still writes the questions when the check cannot load', async () => {
    const plan = { itemTypes: ['multiple_choice'] as ItemType[], perPage: 2, reviewPass: false }
    const result = await runGeneration('set-1', source, plan, new FakeProvider(), new AbortController().signal, callbacks, fakeEmbedder(true))
    expect(result).toEqual({ created: 2, skipped: 0, errors: [] })
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

  it('lowercases capitalised variable names everywhere they are used', () => {
    // As Gemma 4 E4B named it in the end-to-end test, failing all three tries.
    const draft = {
      ...math,
      stem: 'A net force of {{F_net}} N acts on a {{m}} kg cart, so \\(F_{net} = ma\\). What is its acceleration?',
      explanation: 'Acceleration is net force over mass: {{F_net}} N / {{m}} kg = {{F_net/m}} m/s², or {{answer}} m/s².',
      variables: [
        { name: 'F_net', min: 10, max: 100, step: 5 },
        { name: 'm', min: 2, max: 20, step: 1 },
      ],
      constraints: ['F_net > m'],
      answer_formula: 'F_net / m',
      units: 'm/s²',
      worked_example: { values: [{ name: 'F_net', value: 20 }, { name: '{{m}}', value: 4 }], working: '20 N / 4 kg = 5 m/s²', answer: 5 },
    }
    expect(() => parseDraft('math', draft)).toThrow(/F_net/)
    const repaired = repairDraft('math', draft) as typeof draft
    expect(repaired.variables.map((v) => v.name)).toEqual(['f_net', 'm'])
    expect(repaired.answer_formula).toBe('f_net / m')
    expect(repaired.constraints).toEqual(['f_net > m'])
    // TeX outside the placeholders is the question's own text.
    expect(repaired.stem).toBe('A net force of {{f_net}} N acts on a {{m}} kg cart, so \\(F_{net} = ma\\). What is its acceleration?')
    expect(repaired.explanation).toBe('Acceleration is net force over mass: {{f_net}} N / {{m}} kg = {{f_net/m}} m/s², or {{answer}} m/s².')
    expect(repaired.worked_example.values.map((v) => v.name)).toEqual(['f_net', '{{m}}'])
    const parsed = parseDraft('math', repaired)
    expect(() => checkWorkedExample(parsed as DraftOf<'math'>, repaired.worked_example)).not.toThrow()
  })

  it('lowercases a use that differs from a declared name only in case', () => {
    const repaired = repairDraft('math', { ...math, answer_formula: 'V / T', stem: 'A leaf releases {{V}} mL in {{t}} minutes. What is the rate?' }) as typeof math
    expect(repaired.answer_formula).toBe('v / t')
    expect(repaired.stem).toBe('A leaf releases {{v}} mL in {{t}} minutes. What is the rate?')
  })

  it('leaves names that would collide or become reserved for the error message', () => {
    const collide = { ...math, variables: [{ name: 'M', min: 1, max: 9, step: 1 }, { name: 'm', min: 1, max: 9, step: 1 }], answer_formula: 'M / m' }
    expect(repairDraft('math', collide)).toBe(collide)
    const reserved = { ...math, variables: [{ name: 'E', min: 1, max: 9, step: 1 }], answer_formula: 'E * 2' }
    expect(repairDraft('math', reserved)).toBe(reserved)
  })
})

describe('dollarsToDelimiters', () => {
  it('turns $ and $$ math into the \\( \\) and \\[ \\] that ADAPT renders', () => {
    // As Gemma 4 E4B wrote them.
    expect(dollarsToDelimiters('the formula $\\bar{v}=\\frac{\\Delta x}{t}$? Select all')).toBe(
      'the formula \\(\\bar{v}=\\frac{\\Delta x}{t}\\)? Select all',
    )
    expect(dollarsToDelimiters('position is $x_0$ at time $t_0$.')).toBe('position is \\(x_0\\) at time \\(t_0\\).')
    expect(dollarsToDelimiters('$$v = {{d}} / {{t}}$$')).toBe('\\[v = {{d}} / {{t}}\\]')
  })

  it('leaves prices and escaped dollars alone', () => {
    for (const text of ['It costs $5 and $10.', 'between $5-$10', 'from $3.50 to $4', 'a \\$ sign and $x\\$']) {
      expect(dollarsToDelimiters(text)).toBe(text)
    }
  })

  it('applies to prose fields but not formulas, names or units', () => {
    const draft = { stem: 'Find $v$.', answer_formula: 'd / t', units: '$', choices: [{ text: '$2t$', feedback: null }] }
    expect(repairDraft('multiple_choice', draft)).toEqual({ ...draft, stem: 'Find \\(v\\).', choices: [{ text: '\\(2t\\)', feedback: null }] })
  })
})

describe('symbolsToMath', () => {
  it('writes one-letter symbols with a subscript as math, as Gemma 4 E4B wrote them in plain text', () => {
    expect(symbolsToMath('The forces F_prof and F_{cart} are internal.')).toBe('The forces \\(F_{prof}\\) and \\(F_{cart}\\) are internal.')
    expect(symbolsToMath('a = F_net/m')).toBe('a = \\(F_{net}\\)/m')
    expect(symbolsToMath('F_{wall on feet}')).toBe('\\(F_{\\text{wall on feet}}\\)')
  })

  it('leaves math, placeholders, longer names and plain words alone', () => {
    for (const text of ['so \\(F_{net} = ma\\).', 'A force of {{f_net}} N', 'the max_speed setting', 'snake_case', 'no symbols']) {
      expect(symbolsToMath(text)).toBe(text)
    }
  })

  it('applies to what students read, but not to titles, names, formulas or units', () => {
    const { item_type: _, ...fib } = SAMPLE_DRAFTS.find((d) => d.item_type === 'fill_in_blank')!
    void _
    const repaired = repairDraft('fill_in_blank', { ...fib, title: 'Finding F_net', stem: 'F_net acts on the ____.', answer: 'F_floor' }) as typeof fib
    expect(repaired.title).toBe('Finding F_net')
    expect(repaired.stem).toBe('\\(F_{net}\\) acts on the ____.')
    expect(repaired.answer).toBe('\\(F_{floor}\\)')
    const math = repairDraft('math', mathPayload({ answer_formula: 'v / t', units: 'mL_min' })) as ReturnType<typeof mathPayload>
    expect(math.units).toBe('mL_min')
    expect(math.worked_example.values.map((v) => v.name)).toEqual(['v', 't'])
  })
})

describe('bracketsToDelimiters', () => {
  it('restores the delimiters of display math copied without them', () => {
    // As Gemma 4 E4B copied it from College Physics 4.3.
    expect(bracketsToDelimiters('is given by [a = \\dfrac{F_{net}}{m}. \\nonumber ], which')).toBe(
      'is given by \\[a = \\dfrac{F_{net}}{m}. \\nonumber \\], which',
    )
  })

  it('leaves dropdown blanks, plain brackets and existing math alone', () => {
    for (const text of [
      'The cart [a1] because the force [b2].',
      'Pick a value in [0, 1] [see the table].',
      'So \\[ x \\in [0, 1] \\] and \\(y\\).',
      'A force of [{{f}} N] acts.',
    ]) {
      expect(bracketsToDelimiters(text)).toBe(text)
    }
  })

  it('runs before plain-text symbols are wrapped, through repairDraft', () => {
    const draft = { stem: 'Use [a = \\dfrac{F_{net}}{m}] here.', choices: [] }
    expect(repairDraft('multiple_choice', draft)).toEqual({ ...draft, stem: 'Use \\[a = \\dfrac{F_{net}}{m}\\] here.' })
  })
})

describe('bareLatexToMath', () => {
  it('wraps a text that is only a formula', () => {
    expect(bareLatexToMath('x = x_0 + \\bar{v} t')).toBe('\\(x = x_0 + \\bar{v} t\\)')
    expect(bareLatexToMath('a \\propto F_{net}')).toBe('\\(a \\propto F_{net}\\)')
    expect(bareLatexToMath('{{m}} \\times {{a}} = {{answer}}.')).toBe('\\({{m}} \\times {{a}} = {{answer}}\\).')
    expect(bareLatexToMath('9.8 \\text{ m/s}^2')).toBe('\\(9.8 \\text{ m/s}^2\\)')
  })

  it('writes the commands as characters inside a sentence', () => {
    // As Gemma 4 E4B wrote it in an explanation.
    expect(bareLatexToMath('Plugging in the values: w = (1.0 kg) \\times (9.8 m/s^2) = 9.8 N.')).toBe(
      'Plugging in the values: w = (1.0 kg) × (9.8 m/s^2) = 9.8 N.',
    )
    expect(bareLatexToMath('An \\alpha particle has speed \\bar{v} and \\dfrac{1}{2} m v^2 \\text{ J}.')).toBe(
      'An α particle has speed v̄ and 1/2 m v^2 J.',
    )
    expect(bareLatexToMath('So \\(a \\propto F\\) and a \\propto 1/m here.')).toBe('So \\(a \\propto F\\) and a ∝ 1/m here.')
    expect(bareLatexToMath('Use \\unknowncommand here.')).toBe('Use \\unknowncommand here.')
    // Text-mode spellings of characters, as Gemma 4 E4B wrote them.
    expect(bareLatexToMath('So 9.80 m/s\\textasciicircum{}2, F\\textsubscript{net}, 10\\textsuperscript{3}, a\\textunderscore b, \\textbf{net} and \\textsuperscript{n+1}.')).toBe(
      'So 9.80 m/s^2, F_net, 10^3, a_b, net and ^{n+1}.',
    )
  })

  it('never wraps titles, and leaves text without commands alone', () => {
    expect(bareLatexToMath('a \\propto F', true)).toBe('a ∝ F')
    for (const text of ['F_{net} = ma', 'Mass is constant.', 'Already \\(x \\times y\\).']) expect(bareLatexToMath(text)).toBe(text)
  })

  it('runs before plain-text symbols are wrapped, through repairDraft', () => {
    const draft = { title: 'Using \\Delta x', stem: 'Pick one.', choices: [{ text: 'x = x_0 + \\bar{v} t', feedback: null }] }
    expect(repairDraft('multiple_choice', draft)).toEqual({
      ...draft,
      title: 'Using Δ x',
      choices: [{ text: '\\(x = x_0 + \\bar{v} t\\)', feedback: null }],
    })
  })
})

describe('controlsToBackslashes', () => {
  it('restores \\to, \\ne and \\nu read as JSON escapes, but only inside math', () => {
    // The model wrote "$F_{A \to B}$"; \t is a tab in JSON.
    expect(controlsToBackslashes(`If A exerts $F_{A ${'\t'}o B}$ on B, then B exerts $F_{B ${'\t'}o A}$ on A.`)).toBe(
      'If A exerts $F_{A \\to B}$ on B, then B exerts $F_{B \\to A}$ on A.',
    )
    expect(controlsToBackslashes(`so \\(x ${'\n'}e y\\) and \\[${'\n'}u = 5\\] and $$a ${'\t'}o b$$`)).toBe('so \\(x \\ne y\\) and \\[\\nu = 5\\] and $$a \\to b$$')
    // In prose the same characters are a line break or a tab before a word.
    for (const text of ['The constants are:\ne = 2.718 and\nu = 3.', 'Choice 1 is right.\nChoice 2 is wrong.', 'F_net = m * a\nF_net = 50', 'from a\to b', '\n\nThe end.']) {
      expect(controlsToBackslashes(text)).toBe(text)
    }
    // Unambiguous commands get their backslash back before the JSON is parsed
    // (repairLatexEscapes), and then read as characters.
    const parsed = JSON.parse(repairLatexEscapes('{"stem": "The weight is 9.80 m/s\\textasciicircum{}2 and F\\textsubscript{net} = ma, so \\frac{F}{m}."}'))
    expect(parsed.stem).toContain('\\textsubscript{net}')
    expect(repairDraft('multiple_choice', parsed)).toEqual({ stem: 'The weight is 9.80 m/s^2 and \\(F_{net}\\) = ma, so F/m.' })
  })

  it('restores the backslash of math delimiters that came out as control characters', () => {
    // As gpt-6-luna wrote them under OpenAI's strict JSON output.
    expect(controlsToBackslashes('gives \f(\\frac{ {{f}} }{ {{m}} } = {{answer}}\f).')).toBe('gives \\(\\frac{ {{f}} }{ {{m}} } = {{answer}}\\).')
    expect(controlsToBackslashes('acceleration: \u0005(w = mg\u0005), with \u0005(g\u0005)')).toBe('acceleration: \\(w = mg\\), with \\(g\\)')
    expect(controlsToBackslashes('by acceleration: \u0002\\( {{m}} \\times {{a}} \\)')).toBe('by acceleration: \\( {{m}} \\times {{a}} \\)')
  })

  it('leaves tabs, newlines and other text alone', () => {
    for (const text of ['line one\n(two)', 'a\t[b]', 'plain (text) and \\(x\\)']) expect(controlsToBackslashes(text)).toBe(text)
  })

  it('applies to prose fields through repairDraft', () => {
    const draft = { stem: 'Find \f(v\f).', answer_formula: 'd / t', choices: [{ text: '\u0005(2t\u0005)', feedback: null }] }
    expect(repairDraft('multiple_choice', draft)).toEqual({ ...draft, stem: 'Find \\(v\\).', choices: [{ text: '\\(2t\\)', feedback: null }] })
  })
})

describe('cleanReviewNotes', () => {
  it('drops notes about the app’s side of things, as Gemma 4 E4B wrote them', () => {
    const notes = [
      'The concept_label is too long.',
      'The question type is implied but not explicitly stated in the final output structure.',
      'The revised question must integrate the feedback into the choice structure as required by the prompt rules, not as separate feedback fields.',
      'The citation does not cover the explanation.',
      'The explanation was redundant and did not add value to the question.',
      'The explanation is not strictly necessary for the student to answer the question.',
      "The choice 'Mass only' is a weak distractor because the source never links acceleration to mass alone.",
    ]
    expect(cleanReviewNotes(notes)).toEqual([notes[6]])
  })

  it('drops notes that a wrong choice is wrong or not in the source, unless they name a real problem', () => {
    const mc = SAMPLE_DRAFTS.find((d) => d.item_type === 'multiple_choice')!
    const [wrong, alsoWrong] = mc.choices.filter((c) => !c.correct).map((c) => c.text)
    const right = mc.choices.find((c) => c.correct)!.text
    const notes = [
      `The choice '${wrong}' is not supported by the source text.`,
      `The choice '${alsoWrong}' is incorrect because the source says otherwise.`,
      `The choice '${wrong}' is incorrect, but it is too obvious to tempt anyone.`,
      `The choice '${right}' is not supported by the source text.`,
    ]
    expect(cleanReviewNotes(notes, mc)).toEqual([notes[2], notes[3]])
    // Without the draft the choices are unknown, so nothing is dropped for this.
    expect(cleanReviewNotes(notes)).toEqual(notes)
  })

  it('keeps subject words that look like app words, and writes field names as words', () => {
    const notes = [
      "The choice 'Electric fields do work on charges' is also true.",
      "The choice 'Power output doubles' is not supported by the source.",
      'The stem gives the answer away.',
      'The model_answer omits the second key point.',
      'The model_answer omits the second key point.',
      'The explanation contradicts the source about the direction of friction.',
    ]
    expect(cleanReviewNotes(notes)).toEqual([notes[0], notes[1], notes[2], 'The model answer omits the second key point.', notes[5]])
  })
})
