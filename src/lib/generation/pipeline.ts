import { z } from 'zod'
import { withPageNumbers } from '../content/normalize'
import { NoValidResponse, type Embedder, type LLMProvider, type ProgressEvent } from '../llm/types'
import { CONSTANT_NAMES, FUNCTION_NAMES } from '../math/expr'
import { formatUnits } from '../math/format'
import { checkWorkedExample, VARIABLE_NAME } from '../math/spec'
import { db, newId, type StoredItem, type StoredSource } from '../storage/db'
import {
  blankCheckPrompt,
  conceptPrompt,
  draftPrompt,
  KEY_CHECK_SYSTEM,
  keyCheckPrompt,
  reblankPrompt,
  reviewPrompt,
  SYSTEM_PROMPT,
  trueFalseCheckPrompt,
  type Concept,
  type SourceUnit,
} from './prompts'
import {
  BLANK_RUN,
  checkModelDraft,
  checkSymbols,
  formatIssues,
  ITEM_SCHEMAS,
  ITEM_TYPE_LABELS,
  MATH_WORDING_SCHEMA,
  llmSchemaFor,
  parseDraft,
  toLlmSchema,
  typedAnswerProblem,
  WORKED_EXAMPLE_SCHEMA,
  type DraftOf,
  type ItemType,
  type QuestionDraft,
} from './schema'

// Port of assessment-ai's GenerationPipeline for the browser: concepts are
// extracted per source section, one item is drafted per concept, and an
// optional reviewer pass critiques and revises it. Every item is saved to
// IndexedDB the moment it validates, so a closed tab loses nothing finished.

export interface GenerationPlan {
  itemTypes: ItemType[]
  perPage: number
  reviewPass: boolean
}

export interface GenerationResult {
  created: number
  // Questions left out because the model's answers failed the checks in every
  // round. The instructor is not told: there is nothing they could do.
  skipped: number
  // Engine errors, such as a model that is not loaded, one for each question
  // they left out. These the instructor can act on.
  errors: string[]
}

export interface GenerationCallbacks {
  onStatus: (message: string) => void
  onItem: (item: StoredItem) => void
  onProgress: (done: number, total: number) => void
  onModelEvent?: (event: ProgressEvent) => void
}

// How much source text one call may carry. The in-browser model has an 8K
// token window shared by prompt, schema, and answer.
const SOURCE_BUDGET: Record<LLMProvider['id'], number> = { local: 5_500, openai: 40_000 }

const QUANTITATIVE_TYPES = new Set<ItemType>(['numerical', 'math'])

const conceptBatch = (max: number) =>
  z.object({
    concepts: z
      .array(
        z.object({
          label: z.string().trim().min(2).max(160),
          description: z.string().trim().min(2).max(500),
          source_paragraphs: z.array(z.int().min(0)).min(1).max(12),
          quantitative: z.boolean(),
        }),
      )
      .min(1)
      .max(max),
  })

export interface UnitPlan {
  pageIndex: number
  unit: SourceUnit
  count: number
}

// Splits each page into sections that fit the model's budget and spreads the
// page's questions across them in proportion to their length. Sections that
// get no questions are kept: a calculation question can borrow from them.
export function planUnits(source: StoredSource, perPage: number, budget: number): UnitPlan[] {
  const plans: UnitPlan[] = []
  source.pages.forEach((page, pageIndex) => {
    const units: SourceUnit[] = []
    let current: [number, string][] = []
    let size = 0
    for (const paragraph of withPageNumbers(page.paragraphs, page.title)) {
      const text = paragraph.text.length > budget ? paragraph.text.slice(0, budget) : paragraph.text
      if (size + text.length > budget && current.length) {
        units.push({ pageTitle: page.title, paragraphs: current })
        current = []
        size = 0
      }
      current.push([paragraph.index, text])
      size += text.length + 16
    }
    if (current.length) units.push({ pageTitle: page.title, paragraphs: current })

    const lengths = units.map((u) => u.paragraphs.reduce((sum, [, t]) => sum + t.length, 0))
    const total = lengths.reduce((a, b) => a + b, 0) || 1
    const counts = lengths.map((length) => Math.floor((perPage * length) / total))
    // Hand out the remainder to the longest sections first.
    let remaining = perPage - counts.reduce((a, b) => a + b, 0)
    const order = lengths.map((length, i) => [length, i] as const).sort((a, b) => b[0] - a[0])
    for (let k = 0; remaining > 0; k = (k + 1) % order.length, remaining--) counts[order[k][1]]++
    units.forEach((unit, i) => plans.push({ pageIndex, unit, count: counts[i] }))
  })
  return plans
}

// A question whose answers fail the checks on every attempt is started afresh,
// up to twice. Each attempt is shown the last one's error, and small models
// tend to repeat the same mistake; a new conversation drops it. Writing failed
// questions again this way by hand wrote 2 of 2 (Gemma 4 E4B, 2026-10-06). It
// does not help a mistake the model makes every time on a concept: one question
// in a 2026-10-07 run failed all 9 attempts the same way.
const ROUNDS = 3

async function withFreshStarts<T>(run: (round: number) => Promise<T>): Promise<T> {
  for (let round = 1; ; round++) {
    try {
      return await run(round)
    } catch (error) {
      if (round === ROUNDS || !(error instanceof NoValidResponse)) throw error
    }
  }
}

// EmbeddingGemma 2 told reworded duplicates from distinct questions apart with
// AUC 0.99 on 54 questions from College Physics 2.3; at this cosine it found
// 85% of the duplicates at 91% precision. One page, so the cut-off is provisional.
export const DUPLICATE_SIMILARITY = 0.94

// The set's question stems as embeddings, to find the closest to a new one.
export class StemIndex {
  private readonly embedder: Embedder
  private readonly stems: string[] = []
  private readonly vectors: Float32Array[] = []

  constructor(embedder: Embedder) {
    this.embedder = embedder
  }

  async addAll(stems: string[]): Promise<void> {
    if (!stems.length) return
    this.vectors.push(...(await this.embedder.embed(stems)))
    this.stems.push(...stems)
  }

  // Adds the stem and returns the most similar one that was already there.
  async add(stem: string): Promise<{ stem: string; similarity: number } | null> {
    const [vector] = await this.embedder.embed([stem])
    let best: { stem: string; similarity: number } | null = null
    this.vectors.forEach((other, i) => {
      let similarity = 0
      for (let k = 0; k < vector.length; k++) similarity += vector[k] * other[k]
      if (!best || similarity > best.similarity) best = { stem: this.stems[i], similarity }
    })
    this.stems.push(stem)
    this.vectors.push(vector)
    return best
  }
}

export async function runGeneration(
  setId: string,
  source: StoredSource,
  plan: GenerationPlan,
  provider: LLMProvider,
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
  embedder: Embedder | null = null,
): Promise<GenerationResult> {
  const units = planUnits(source, plan.perPage, SOURCE_BUDGET[provider.id])
  const textbook = new WordIndex(source.pages.flatMap((page) => page.paragraphs.map((p) => p.text)))
  const total = units.reduce((sum, u) => sum + u.count, 0)
  const existing = await db.items.where('setId').equals(setId).sortBy('position')
  const stems = existing.map((item) => item.draft.stem)
  let position = existing.length
  let done = 0
  let created = 0
  let skipped = 0
  const errors: string[] = []
  const leaveOut = (error: unknown, count: number) => {
    if (error instanceof NoValidResponse) {
      skipped += count
      console.warn(`Left out ${count} question(s):`, error.message)
    } else {
      for (let k = 0; k < count; k++) errors.push(message(error))
    }
  }
  callbacks.onProgress(0, total)

  // The duplicate check is a convenience: if it cannot load, questions are
  // still written, just not checked.
  let duplicates: StemIndex | null = null
  if (embedder) {
    callbacks.onStatus('Loading the duplicate check…')
    try {
      await embedder.load((progress) => callbacks.onModelEvent?.({ kind: 'status', message: progress.text }))
      duplicates = new StemIndex(embedder)
      await duplicates.addAll(stems)
    } catch (error) {
      if (signal.aborted) throw error
      duplicates = null
      console.warn('Duplicate check unavailable:', error)
    }
  }

  // Types are assigned up front so each section's concept prompt knows how
  // many calculation questions it has to supply.
  let typeCursor = existing.length
  const slotTypes = units.map((u) => Array.from({ length: u.count }, () => plan.itemTypes[typeCursor++ % plan.itemTypes.length]))

  // Each section's concepts are extracted once, when first needed.
  const extracted = new Map<UnitPlan, Promise<Concept[]>>()
  const conceptsOf = (index: number, status: string): Promise<Concept[]> => {
    const target = units[index]
    let concepts = extracted.get(target)
    if (!concepts) {
      callbacks.onStatus(status)
      const calculations = slotTypes[index].filter((t) => QUANTITATIVE_TYPES.has(t)).length
      // A section without questions of its own is only searched for numbers.
      concepts = withFreshStarts(() =>
        target.count
          ? extractConcepts(provider, target.unit, target.count, calculations, signal, callbacks)
          : extractConcepts(provider, target.unit, 2, 2, signal, callbacks),
      )
      extracted.set(target, concepts)
    }
    return concepts
  }

  // A calculation question needs numbers in the source; without them small
  // models invent nonsense. It takes the least-used quantitative concept,
  // looking first in its own section and then in the nearest other sections of
  // the same page, which are only extracted while no unused one is found.
  const uses = new Map<Concept, number>()
  const findQuantitative = async (index: number): Promise<{ concept: Concept; unit: UnitPlan } | null> => {
    const { pageIndex, unit } = units[index]
    const nearest = units
      .map((_, k) => k)
      .filter((k) => units[k].pageIndex === pageIndex)
      .sort((a, b) => Math.abs(a - index) - Math.abs(b - index))
    let best: { concept: Concept; unit: UnitPlan; uses: number } | null = null
    for (const k of nearest) {
      let concepts: Concept[]
      try {
        concepts = await conceptsOf(k, `Looking elsewhere in “${unit.pageTitle}” for numbers to calculate with…`)
      } catch (error) {
        if (signal.aborted) throw error
        continue
      }
      for (const concept of concepts.filter((c) => c.quantitative)) {
        const count = uses.get(concept) ?? 0
        if (!best || count < best.uses) best = { concept, unit: units[k], uses: count }
      }
      if (best?.uses === 0) break
    }
    if (best) uses.set(best.concept, best.uses + 1)
    return best
  }

  for (const [index, current] of units.entries()) {
    if (!current.count) continue
    signal.throwIfAborted()
    let concepts: Concept[]
    try {
      concepts = await conceptsOf(index, `Finding concepts in “${current.unit.pageTitle}”…`)
    } catch (error) {
      if (signal.aborted) throw error
      leaveOut(error, current.count)
      done += current.count
      callbacks.onProgress(done, total)
      continue
    }

    for (let j = 0; j < current.count; j++) {
      signal.throwIfAborted()
      let concept = concepts[j % concepts.length]
      let itemType = slotTypes[index][j]
      // The section the question is written from.
      let unit = current.unit
      const notes: string[] = []
      if (QUANTITATIVE_TYPES.has(itemType)) {
        const found = await findQuantitative(index)
        if (found) {
          concept = found.concept
          unit = found.unit.unit
        } else {
          const requested = ITEM_TYPE_LABELS[itemType].toLowerCase()
          itemType = plan.itemTypes.find((t) => !QUANTITATIVE_TYPES.has(t)) ?? 'multiple_choice'
          notes.push(
            `A ${requested} question was requested, but no quantitative content was found on this page, so a ${itemType.replace(/_/g, ' ')} question was written instead.`,
          )
        }
      }
      const allowed = new Set(unit.paragraphs.map(([i]) => i))
      const kind = itemType.replace(/_/g, ' ')
      callbacks.onStatus(`Writing a ${kind} question on “${concept.label}”…`)
      try {
        let draft = await withFreshStarts((round) => {
          if (round > 1) callbacks.onStatus(`Starting the ${kind} question on “${concept.label}” over…`)
          return draftItem(provider, unit, concept, itemType, stems.slice(-12), allowed, signal, callbacks)
        })
        let critique: string[] = notes
        let reviewNotes: string[] = []
        // On the in-browser model the reviewer may only reword a math question
        // (see keepComputation), and its notes on them were mostly false claims
        // about placeholder format, so the ~20 s review is skipped.
        const review = plan.reviewPass && !(provider.id === 'local' && draft.item_type === 'math')
        if (review) {
          callbacks.onStatus(`Reviewing “${draft.title}”…`)
          try {
            const reviewed = await reviewItem(provider, unit, concept, draft, allowed, signal, callbacks, [], typedAnswerProblem(draft))
            draft = reviewed.draft
            reviewNotes = reviewed.issues
            critique = [...notes, ...reviewed.issues]
          } catch (error) {
            if (signal.aborted) throw error
            critique = [...notes, `Automatic review could not complete (${message(error)}); the unreviewed draft was kept.`]
          }
        }
        if (provider.id === 'local') {
          const checked = await verifyAnswerKey(provider, unit, concept, draft, allowed, signal, callbacks, textbook)
          // A new blank makes it another question than the one the reviewer
          // read, and its notes were nearly all about the old blank, such as
          // "The correct answer '9.8 N' contains a number and unit…" on a key
          // that is now "weight": 8 of the 9 notes on the 10 of 30 questions
          // given a new blank (2026-10-09). The new blank has passed the check.
          if (draft.item_type === 'fill_in_blank' && checked.draft !== draft) {
            critique = critique.filter((note) => !reviewNotes.includes(note))
          }
          draft = checked.draft
          critique = [...critique, ...checked.notes]
        }
        draft = finalize(draft, concept)
        const typed = typedAnswerProblem(draft)
        if (typed && draft.item_type === 'fill_in_blank') {
          // The reviewer, told about it, tends to list it too, in its own words.
          const answer = draft.answer.toLowerCase()
          critique = [...critique.filter((note) => !note.toLowerCase().includes(answer)), typed]
        }
        const similar = await duplicates?.add(draft.stem).catch(() => null)
        if (similar && similar.similarity >= DUPLICATE_SIMILARITY) {
          critique = [...critique, `Very similar to another question in this set: “${clip(similar.stem, 140)}”`]
        }
        const now = Date.now()
        const item: StoredItem = {
          id: newId(),
          setId,
          position: position++,
          status: 'draft',
          draft,
          sourcePageIndex: current.pageIndex,
          critique,
          createdAt: now,
          updatedAt: now,
        }
        await db.items.add(item)
        await db.sets.update(setId, { updatedAt: now })
        stems.push(draft.stem)
        created++
        callbacks.onItem(item)
      } catch (error) {
        if (signal.aborted) throw error
        leaveOut(error, 1)
      }
      callbacks.onProgress(++done, total)
    }
  }
  return { created, skipped, errors }
}

// The label is what the instructor sees on every question. Gemma 4 E4B once
// labelled a section's concepts "Calculation", "Concept" and "Concept", and
// the test runs that reused those concepts put the labels on 6 of 30 questions.
const GENERIC_LABEL =
  /^(?:(?:key|main|core|basic|important)\s+)?(?:concepts?|calculations?|topics?|ideas?|definitions?|relationships?|formulas?|equations?|examples?|principles?|facts?|laws?|processes?|terms?|applications?|problems?)(?:\s*\d+)?$/i

export async function extractConcepts(
  provider: LLMProvider,
  unit: SourceUnit,
  count: number,
  calculations: number,
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
): Promise<Concept[]> {
  const allowed = new Set(unit.paragraphs.map(([index]) => index))
  const schema = conceptBatch(Math.max(1, count))
  const result = await provider.complete({
    system: SYSTEM_PROMPT,
    prompt: conceptPrompt(unit, count, calculations),
    schemaName: 'concept_batch',
    schema: toLlmSchema(schema),
    maxOutputTokens: provider.id === 'local' ? 900 : undefined,
    signal,
    onProgress: callbacks.onModelEvent,
    validate: (value) => {
      const parsed = schema.safeParse(value)
      if (!parsed.success) throw new Error(formatIssues(parsed.error))
      // Keep only citations into this section; drop concepts left with none.
      const concepts = parsed.data.concepts
        .map((c) => ({ ...c, source_paragraphs: c.source_paragraphs.filter((p) => allowed.has(p)) }))
        .filter((c) => c.source_paragraphs.length > 0)
      if (!concepts.length) {
        throw new Error(`every concept must cite paragraph numbers from: ${[...allowed].join(', ')}`)
      }
      const generic = concepts.find((c) => GENERIC_LABEL.test(c.label))
      if (generic) {
        throw new Error(`label "${generic.label}" says what kind of concept it is; label each concept with the idea itself, such as "Newton's third law"`)
      }
      return concepts
    },
  })
  return result.value
}

export async function draftItem(
  provider: LLMProvider,
  unit: SourceUnit,
  concept: Concept,
  itemType: ItemType,
  avoid: string[],
  allowed: Set<number>,
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
): Promise<QuestionDraft> {
  const result = await provider.complete({
    system: SYSTEM_PROMPT,
    prompt: draftPrompt(unit, concept, itemType, avoid),
    schemaName: `${itemType}_item`,
    schema: llmSchemaFor(itemType),
    signal,
    onProgress: callbacks.onModelEvent,
    validate: (value) => {
      checkSymbols(value, sourceText(unit))
      const repaired = repairDraft(itemType, value)
      const draft = parseDraft(itemType, repaired, allowed)
      checkModelDraft(draft)
      if (draft.item_type === 'math') {
        const example = WORKED_EXAMPLE_SCHEMA.safeParse((repaired as { worked_example?: unknown }).worked_example)
        if (!example.success) throw new Error(`worked_example: ${formatIssues(example.error)}`)
        checkWorkedExample(draft, example.data)
      }
      return draft
    },
  })
  return result.value
}

export async function reviewItem(
  provider: LLMProvider,
  unit: SourceUnit,
  concept: Concept,
  draft: QuestionDraft,
  allowed: Set<number>,
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
  keyProblems: string[] = [],
  answerProblem: string | null = null,
): Promise<{ draft: QuestionDraft; issues: string[] }> {
  const schema = z.object({
    issues: z.array(z.string().trim().min(1).max(400)).max(8),
    revised: draft.item_type === 'math' ? MATH_WORDING_SCHEMA : ITEM_SCHEMAS[draft.item_type],
  })
  const sentBack: string[] = []
  const result = await provider.complete({
    system: SYSTEM_PROMPT,
    prompt: reviewPrompt(unit, concept, draft, keyProblems, answerProblem),
    schemaName: 'item_review',
    schema: toLlmSchema(schema),
    signal,
    onProgress: callbacks.onModelEvent,
    validate: (value) => {
      try {
        const record = value as { issues?: unknown; revised?: unknown }
        const issues = z.array(z.string()).max(8).safeParse(record?.issues)
        checkSymbols(record?.revised, sourceText(unit))
        const revised = parseDraft(draft.item_type, repairDraft(draft.item_type, keepComputation(draft, record?.revised)), allowed)
        checkModelDraft(revised)
        return { issues: issues.success ? cleanReviewNotes(issues.data, draft) : [], draft: revised }
      } catch (error) {
        sentBack.push(message(error).toLowerCase())
        throw error
      }
    },
  })
  // Sent back with a problem, the reviewer sometimes listed the problem itself
  // as a note once it had fixed it, word for word: "the stem gives the answer
  // away: "displacement" already appears in it" (4 of 895 saved notes,
  // 2026-10-09).
  const repeats = (note: string) => sentBack.some((problem) => problem.includes(note.toLowerCase().replace(/[.\s]+$/, '')))
  return { ...result.value, issues: result.value.issues.filter((note) => !repeats(note)) }
}

// The text of the source section, whose symbols a question may use.
function sourceText(unit: SourceUnit): string {
  return unit.paragraphs.map(([, text]) => text).join('\n')
}

// Gemma 4 E4B wrote a true statement as a wrong choice in 18 of 120
// multiple-choice and select-all questions (2026-10-07), such as a = F/m next
// to the key F = ma, or "if the net force is zero, the acceleration is zero"
// marked wrong. The reviewer kept all of them: shown the key, it defends it.
// Asked to answer the question without the key, the same model disagreed with
// 16 of the 18 keys and with 4 of 93 right ones. A key it disagrees with goes
// back once, naming the choices; if the check still disagrees, the instructor
// gets a note. The check is a convenience: if it cannot run, the question is
// kept as it is.
export interface KeyDisagreement {
  choice: string
  // What the check makes of the choice; the key says the opposite.
  checkSaysCorrect: boolean
}

export async function checkAnswerKey(
  provider: LLMProvider,
  unit: SourceUnit,
  draft: QuestionDraft,
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
): Promise<KeyDisagreement[]> {
  if (draft.item_type !== 'multiple_choice' && draft.item_type !== 'multiple_answers') return []
  const { choices } = draft
  const schema = z.object({ working: z.string(), answers: z.array(z.int().min(1).max(choices.length)) })
  const result = await provider.complete({
    system: KEY_CHECK_SYSTEM,
    prompt: keyCheckPrompt(unit, draft),
    schemaName: 'key_check',
    schema: toLlmSchema(schema),
    signal,
    onProgress: callbacks.onModelEvent,
    validate: (value) => {
      const parsed = schema.safeParse(value)
      if (!parsed.success) throw new Error(formatIssues(parsed.error))
      if (!parsed.data.answers.length) throw new Error('answers must list the number of at least one right choice')
      return new Set(parsed.data.answers)
    },
  })
  return choices.flatMap((choice, i) =>
    result.value.has(i + 1) === choice.correct ? [] : [{ choice: choice.text, checkSaysCorrect: !choice.correct }],
  )
}

// Checks the key of a multiple-choice, select-all, true/false or
// fill-in-the-blank question, and fixes it or notes it.
export async function verifyAnswerKey(
  provider: LLMProvider,
  unit: SourceUnit,
  concept: Concept,
  draft: QuestionDraft,
  allowed: Set<number>,
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
  textbook: WordIndex,
): Promise<{ draft: QuestionDraft; notes: string[] }> {
  switch (draft.item_type) {
    case 'multiple_choice':
    case 'multiple_answers':
      return verifyByReview(provider, unit, concept, draft, allowed, signal, callbacks)
    case 'true_false':
      return verifyTrueFalse(provider, unit, draft, signal, callbacks)
    case 'fill_in_blank':
      return verifyBlank(provider, unit, concept, draft, signal, callbacks, textbook)
    default:
      return { draft, notes: [] }
  }
}

// The checks are a convenience: one that cannot run leaves the question as it is.
function unlessAborted<T>(signal: AbortSignal) {
  return (error: unknown): T | null => {
    if (signal.aborted) throw error
    console.warn('Answer check unavailable:', error)
    return null
  }
}

async function verifyByReview(
  provider: LLMProvider,
  unit: SourceUnit,
  concept: Concept,
  draft: QuestionDraft,
  allowed: Set<number>,
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
): Promise<{ draft: QuestionDraft; notes: string[] }> {
  const check = (question: QuestionDraft) =>
    checkAnswerKey(provider, unit, question, signal, callbacks).catch(unlessAborted<KeyDisagreement[]>(signal))
  callbacks.onStatus(`Checking the answer key of “${draft.title}”…`)
  const disagreements = await check(draft)
  if (!disagreements?.length) return { draft, notes: [] }
  callbacks.onStatus(`Fixing the answer key of “${draft.title}”…`)
  let fixed: QuestionDraft
  try {
    const problems = disagreements.map((d) => keyProblem(draft.item_type, d))
    fixed = (await reviewItem(provider, unit, concept, draft, allowed, signal, callbacks, problems)).draft
  } catch (error) {
    if (signal.aborted) throw error
    return { draft, notes: [keyNote(draft.item_type, disagreements)] }
  }
  const remaining = await check(fixed)
  return { draft: fixed, notes: remaining?.length ? [keyNote(draft.item_type, remaining)] : [] }
}

// True/false keys get the same check, but a disagreement is only noted. The
// check agreed with 27 of 28 saved Gemma 4 E4B and gpt-6-luna statements, all
// of whose keys were right (2026-10-09). Its one disagreement was its own
// mistake ("forces in the same system cancel" judged false), and sent back to
// the reviewer that way, a correct key was flipped to false in 1 of 4 tries,
// which the recheck then agreed with.
async function verifyTrueFalse(
  provider: LLMProvider,
  unit: SourceUnit,
  draft: QuestionDraft,
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
): Promise<{ draft: QuestionDraft; notes: string[] }> {
  callbacks.onStatus(`Checking the answer key of “${draft.title}”…`)
  const disagreements = await checkTrueFalse(provider, unit, draft, signal, callbacks).catch(unlessAborted<KeyDisagreement[]>(signal))
  return { draft, notes: disagreements?.length ? [keyNote(draft.item_type, disagreements)] : [] }
}

export async function checkTrueFalse(
  provider: LLMProvider,
  unit: SourceUnit,
  draft: QuestionDraft,
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
): Promise<KeyDisagreement[]> {
  if (draft.item_type !== 'true_false') return []
  const schema = z.object({ working: z.string(), answer: z.boolean() })
  const result = await provider.complete({
    system: KEY_CHECK_SYSTEM,
    prompt: trueFalseCheckPrompt(unit, draft.stem),
    schemaName: 'true_false_check',
    schema: toLlmSchema(schema),
    signal,
    onProgress: callbacks.onModelEvent,
    validate: (value) => {
      const parsed = schema.safeParse(value)
      if (!parsed.success) throw new Error(formatIssues(parsed.error))
      return parsed.data.answer
    },
  })
  return result.value === draft.answer ? [] : [{ choice: draft.stem, checkSaysCorrect: result.value }]
}

// ADAPT marks a fill-in-the-blank answer right only when it is the key, typed
// exactly. About half of Gemma 4 E4B's blanks were weak in a blind read of 57
// (2026-10-08): another word fits as well ("do not cancel if they act on
// different ____": systems, but objects too), or the key is a phrase few would
// type the same way ("elements of the system"). Asked to fill the blank without
// the key or the textbook, the same model wrote something else for 12 of 13
// ambiguous blanks and for 6 of 29 good ones (2026-10-09).
//
// Sent back to the reviewer, a number key was replaced 1 time in 8, so the fix
// is narrower: the blank goes back into the sentence, the model names other
// words of it to blank, and the first one the check fills in as the key is
// kept, skipping words the textbook gives away (givenAway). The sentence and
// the explanation stay as they were, so the question's facts do not change. If
// none passes, the question keeps its blank, with a note if the check
// disagreed.
export async function checkBlank(
  provider: LLMProvider,
  unit: SourceUnit,
  stem: string,
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
): Promise<string> {
  const schema = z.object({ answer: z.string().trim().min(1).max(120) })
  const result = await provider.complete({
    system: KEY_CHECK_SYSTEM,
    prompt: blankCheckPrompt(unit.pageTitle, stem),
    schemaName: 'blank_check',
    schema: toLlmSchema(schema),
    maxOutputTokens: provider.id === 'local' ? 100 : undefined,
    signal,
    onProgress: callbacks.onModelEvent,
    validate: (value) => {
      const parsed = schema.safeParse(value)
      if (!parsed.success) throw new Error(formatIssues(parsed.error))
      return parsed.data.answer
    },
  })
  return result.value
}

async function verifyBlank(
  provider: LLMProvider,
  unit: SourceUnit,
  concept: Concept,
  draft: DraftOf<'fill_in_blank'>,
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
  textbook: WordIndex,
): Promise<{ draft: QuestionDraft; notes: string[] }> {
  const fill = (stem: string) => checkBlank(provider, unit, stem, signal, callbacks).catch(unlessAborted<string>(signal))
  const passes = async (candidate: DraftOf<'fill_in_blank'>) => {
    const answer = await fill(candidate.stem)
    return answer !== null && sameAnswer(answer, candidate.answer)
  }
  callbacks.onStatus(`Checking the answer of “${draft.title}”…`)
  const filled = await fill(draft.stem)
  if (filled === null) return { draft, notes: [] }
  const agrees = [draft.answer, ...draft.alternates].some((answer) => sameAnswer(filled, answer))
  if (agrees && !typedAnswerProblem(draft)) return { draft, notes: [] }

  callbacks.onStatus(`Choosing a better blank for “${draft.title}”…`)
  const sentence = repairProse(fillIn(draft.stem, draft.answer)) as string
  const words = await reblank(provider, unit, concept, sentence, [draft.answer], signal, callbacks).catch(unlessAborted<string[]>(signal))
  const givenAwayBlanks: DraftOf<'fill_in_blank'>[] = []
  for (const word of words ?? []) {
    const candidate = blankedDraft(draft, sentence, word)
    if (!candidate) continue
    if (givenAway(candidate.stem, candidate.answer, textbook)) givenAwayBlanks.push(candidate)
    else if (await passes(candidate)) return { draft: candidate, notes: [] }
  }
  // An easy blank still beats a number or symbol students type differently.
  if (typedAnswerProblem(draft)) {
    for (const candidate of givenAwayBlanks) if (await passes(candidate)) return { draft: candidate, notes: [] }
  }
  return { draft, notes: agrees ? [] : [blankNote(filled, draft.answer)] }
}

export async function reblank(
  provider: LLMProvider,
  unit: SourceUnit,
  concept: Concept,
  sentence: string,
  avoid: string[],
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
): Promise<string[]> {
  // No length limits on a word: blankedDraft skips an empty or overlong one,
  // rather than one such word failing the whole list.
  const schema = z.object({ words: z.array(z.string()).min(1).max(5) })
  const result = await provider.complete({
    system: KEY_CHECK_SYSTEM,
    prompt: reblankPrompt(unit.pageTitle, concept, sentence, avoid),
    schemaName: 'blank_choice',
    schema: toLlmSchema(schema),
    maxOutputTokens: provider.id === 'local' ? 200 : undefined,
    signal,
    onProgress: callbacks.onModelEvent,
    validate: (value) => {
      const parsed = schema.safeParse(value)
      if (!parsed.success) throw new Error(formatIssues(parsed.error))
      return parsed.data.words
    },
  })
  return result.value
}

// The stem with its blank filled in. A key of several words often repeats the
// word next to the blank ("an ____ force" with the key "internal force", "is
// ____ to" with "proportional to"), which is written once.
export function fillIn(stem: string, answer: string): string {
  const [before, after = ''] = stem.split(BLANK_RUN)
  const words = answer.trim().split(/\s+/)
  let head = before
  let tail = after
  if (words.length > 1) {
    const next = tail.match(/^\s*([\p{L}\p{N}]+)/u)
    if (next && next[1].toLowerCase() === words.at(-1)!.toLowerCase()) tail = tail.slice(next[0].length)
    const previous = head.match(/([\p{L}\p{N}]+)\s*$/u)
    if (previous && previous[1].toLowerCase() === words[0].toLowerCase()) head = head.slice(0, -previous[0].length)
  }
  return `${head}${answer.trim()}${tail}`
}

// The question with `word` blanked out of `sentence`, or null if the word is
// not in the sentence's prose exactly once or the question would fail a check.
export function blankedDraft(draft: DraftOf<'fill_in_blank'>, sentence: string, word: string): DraftOf<'fill_in_blank'> | null {
  const target = word.trim().replace(/[.,;:!]+$/, '')
  // A letter or two is a symbol or a unit ("N"), not a word.
  if (!/\p{L}{3,}/u.test(target) || target.split(/\s+/).length > 3 || sameAnswer(target, draft.answer)) return null
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(target)}(?![\\p{L}\\p{N}])`, 'giu')
  if ((sentence.match(pattern) ?? []).length !== 1) return null
  let answer = ''
  const parts = sentence.split(MATH_OR_PLACEHOLDER)
  const stem = parts
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(pattern, (match) => {
            answer = match
            return '____'
          }),
    )
    .join('')
  if (!answer) return null
  try {
    const { item_type, ...payload } = draft
    const next = parseDraft(item_type, { ...payload, stem, answer, alternates: [] })
    checkModelDraft(next)
    return next.item_type === 'fill_in_blank' && !typedAnswerProblem(next) ? next : null
  } catch {
    return null
  }
}

// Asked for the word that carries the idea, Gemma 4 E4B also offers words the
// rest of the sentence gives away: "net external ____" (force), "acceleration
// due to ____" (gravity), "An ____ force acts from outside the system, while an
// internal force …" (external). Of 108 new blanks the check passed (2026-10-09),
// 54 were given away like this and 31 were good. Skipping a word that the
// textbook writes next to the blank's neighbouring word or two at least half
// the time, where that neighbour occurs at least 3 times, or whose opposite
// the sentence contrasts with it, flagged 25 of the 54 and 1 of the 31. It
// counts over every page of the source, leaving out the question's own
// sentence; counted over one page or the cited paragraphs, it still flags 1
// of the 31. Gemma's own judgement of whether a blank is guessable told the
// two apart no better than chance.
export class WordIndex {
  private readonly texts: string[]
  private readonly vocabulary = new Map<string, number>()
  private readonly positions: number[][] = []
  private ids: Int32Array | null = null

  // The words are read on first use: only a fill-in-the-blank question sent
  // back for a new blank needs them, and a whole book has about a million.
  constructor(texts: string[]) {
    this.texts = texts
  }

  count(sequence: string[]): number {
    const ids = this.build()
    const wanted = sequence.map((word) => this.vocabulary.get(word) ?? -1)
    if (!wanted.length || wanted.includes(-1)) return 0
    let count = 0
    for (const start of this.positions[wanted[0]]) {
      let k = 1
      while (k < wanted.length && ids[start + k] === wanted[k]) k++
      if (k === wanted.length) count++
    }
    return count
  }

  private build(): Int32Array {
    if (this.ids) return this.ids
    const words = this.texts.flatMap((text) => [...wordsOf(text), BREAK])
    const ids = new Int32Array(words.length)
    words.forEach((word, i) => {
      let id = word === BREAK ? -1 : this.vocabulary.get(word)
      if (id === undefined) {
        id = this.positions.length
        this.vocabulary.set(word, id)
        this.positions.push([])
      }
      ids[i] = id
      if (id >= 0) this.positions[id].push(i)
    })
    this.ids = ids
    return ids
  }
}

const MIN_CONTEXT = 3
const PREDICTABLE = 0.5

export function givenAway(stem: string, answer: string, textbook: WordIndex): boolean {
  const [before, after = ''] = stem.split(BLANK_RUN)
  const head = wordsOf(before)
  // The underscore keeps the "'s" of "____'s" attached, as in "Newton’s".
  const tail = wordsOf(`_${after}`)
  const key = wordsOf(answer)
  // The words next to the blank, up to any math on either side.
  const left = head.slice(head.lastIndexOf(BREAK) + 1)
  const right = tail.includes(BREAK) ? tail.slice(0, tail.indexOf(BREAK)) : tail
  for (const k of [1, 2]) {
    if (left.length >= k && predicts(textbook, left.slice(-k), [...left.slice(-k), ...key])) return true
    if (right.length >= k && predicts(textbook, right.slice(0, k), [...key, ...right.slice(0, k)])) return true
  }
  const others = [...head, ...tail].filter((word) => word !== BREAK)
  return CONTRAST.test(stem) && key.some((word) => others.some((other) => opposite(word, other)))
}

// The question's sentence comes from the textbook, so one of the textbook's
// uses of the phrase is usually that very sentence, which says nothing about
// the rest of the book. On a one-page source it was often the only one.
function predicts(textbook: WordIndex, context: string[], phrase: string[]): boolean {
  const hit = textbook.count(phrase)
  const own = hit > 0 ? 1 : 0
  const seen = textbook.count(context) - own
  return seen >= MIN_CONTEXT && (hit - own) / seen >= PREDICTABLE
}

// Opposites contrasted in one sentence give each other away: "An ____ force
// acts from outside the system, while an internal force …" (external). They
// are the same word with and without a negating prefix ("balanced",
// "unbalanced"), or one stem behind the two halves of a pair ("internal",
// "external"). Without a contrast, "the ____ of a spring … the tension"
// (extension) or "____ until no charge remains" (discharge) is not one.
const CONTRAST = /\b(?:while|whereas|but|unlike|not|rather than|instead|opposite|versus|compared)\b/i
const NEGATIONS = ['un', 'non', 'in', 'im', 'ir', 'il', 'dis']
const PAIRS = [['in', 'ex'], ['im', 'ex'], ['inter', 'intra'], ['endo', 'exo'], ['in', 'out'], ['in', 'de']]

function opposite(a: string, b: string): boolean {
  const negates = (x: string, y: string) => y.length >= 4 && NEGATIONS.some((prefix) => x === prefix + y)
  const paired = (x: string, y: string) =>
    PAIRS.some(([p, q]) => x.startsWith(p) && y.startsWith(q) && x.length - p.length >= 3 && x.slice(p.length) === y.slice(q.length))
  return negates(a, b) || negates(b, a) || paired(a, b) || paired(b, a)
}

// Words as the index counts them. Math is not prose, so it ends a run of words
// (BREAK) instead of adding "f", "text" and "net". Curly and straight
// apostrophes are the same, and "Newton's" is "newton" and "'s", so the blank
// in "____'s second law" lines up with the textbook's "Newton’s second law".
// "Forces" counts as "force".
const BREAK = '|'

function wordsOf(text: string): string[] {
  return text
    .split(DELIMITED_MATH)
    .flatMap((part, i) =>
      i % 2 ? [BREAK] : (part.toLowerCase().replace(/[‘’]/g, "'").match(/[\p{L}\p{N}]+|(?<=[\p{L}\p{N}_])'\p{L}+/gu) ?? []).map(singular),
    )
}

// "forces" and "force", "masses" and "mass", but "mass" and "this" as they are.
function singular(word: string): string {
  if (word.length <= 3 || /(?:ss|us|is)$/.test(word)) return word
  if (/(?:sses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2)
  return word.endsWith('s') ? word.slice(0, -1) : word
}

// Case, a leading article, punctuation and a plural ending are not what the
// check is after.
export function sameAnswer(a: string, b: string): boolean {
  const plain = (text: string) =>
    text
      .toLowerCase()
      .replace(/\\[()[\]]/g, ' ')
      .replace(/[“”"'‘’.,;:!?()]/g, '')
      .replace(/^\s*(?:the|a|an)\s+/, '')
      .replace(/\s+/g, ' ')
      .trim()
  const [x, y] = [plain(a), plain(b)]
  return x === y || singular(x) === singular(y)
}

function blankNote(filled: string, key: string): string {
  return `An automatic check filled the blank with “${clip(filled, 80)}”, not “${clip(key, 80)}”: students may give an answer other than the key and be marked wrong.`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function keyProblem(itemType: ItemType, { choice, checkSaysCorrect }: KeyDisagreement): string {
  if (!checkSaysCorrect) {
    return `The choice "${clip(choice, 160)}" is marked correct, but it may not be: make sure it is true and answers the question, or mark it incorrect.`
  }
  const fix = itemType === 'multiple_answers' ? 'mark it correct, or replace it with a statement that is clearly false' : 'replace it with a choice that is clearly wrong'
  return `The choice "${clip(choice, 160)}" is marked incorrect, but it is also a correct answer: ${fix}.`
}

function keyNote(itemType: ItemType, disagreements: KeyDisagreement[]): string {
  if (itemType === 'true_false') {
    return `An automatic answer check disagrees with the answer key: it judged the statement ${disagreements[0].checkSaysCorrect ? 'true' : 'false'}.`
  }
  const judged = disagreements.map(({ choice, checkSaysCorrect }) => `“${clip(choice, 100)}” is ${checkSaysCorrect ? 'also correct' : 'not correct'}`)
  return `An automatic answer check disagrees with the answer key: it judged that ${judged.join('; ')}.`
}

// The instructor reads the reviewer's notes on the question card. Gemma 4 E4B
// also wrote notes about the app's side of things ("The concept_label is too
// long", "…not explicitly stated in the final output structure"), which the
// instructor can do nothing about; notes that a wrong choice is wrong or not
// in the source, which is what a wrong choice is for; and notes that the
// explanation is redundant or not needed to answer, when it is the feedback
// students read afterwards. All are dropped. The phrases are narrow on purpose:
// "field", "output" and "stem" are also subject words, and a note that a wrong
// choice is too easy or also true is kept.
const ABOUT_THE_APP =
  /\b(?:concept[ _]labels?|citations?|citation_paragraphs|paragraph numbers?|json|schema|prompt(?: rules)?|output (?:structure|format)|field names?|feedback fields|(?:item|question) types?|(?:revised|final) (?:question|version|draft|output))\b/i
const WRONG_BY_DESIGN =
  /\b(?:(?:is|are) (?:incorrect|wrong|false|not correct|not true)|not (?:\w+ ){0,2}(?:mentioned|supported|stated|found|discussed|covered|given) (?:in|by) the (?:source|text|passage|excerpt))\b/i
const EXPLANATION_NOT_NEEDED =
  /\bexplanation\b.*\b(?:not (?:strictly )?necessary|unnecessary|redundant|(?:does|did) not add (?:any )?value|without adding (?:any )?value)/i
const REAL_PROBLEM = /\b(?:plausib|obvious|easy|too |confus|mislead|ambigu|arguabl|defensib|also (?:true|correct)|could be (?:true|correct)|partly|partially)/i
const FIELD_NAME = /\b[a-z]+(?:_[a-z]+)+\b/g

export function cleanReviewNotes(notes: string[], draft?: QuestionDraft): string[] {
  const wrong = draft ? wrongChoices(draft).map((text) => text.trim().replace(/[.\s]+$/, '').toLowerCase()).filter((t) => t.length >= 3) : []
  const aboutWrongChoice = (note: string) => {
    const lower = note.toLowerCase()
    return wrong.some((text) => lower.includes(text)) && WRONG_BY_DESIGN.test(note) && !REAL_PROBLEM.test(note)
  }
  const seen = new Set<string>()
  return notes
    .filter((note) => !ABOUT_THE_APP.test(note) && !EXPLANATION_NOT_NEEDED.test(note) && !aboutWrongChoice(note))
    .map((note) => note.trim().replace(FIELD_NAME, (name) => name.replace(/_/g, ' ')))
    .filter((note) => {
      const key = note.toLowerCase()
      if (!note || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function wrongChoices(draft: QuestionDraft): string[] {
  switch (draft.item_type) {
    case 'multiple_choice':
    case 'multiple_answers':
      return draft.choices.filter((choice) => !choice.correct).map((choice) => choice.text)
    case 'matching':
      return draft.distractors
    case 'dropdowns':
      return draft.blanks.flatMap((blank) => blank.distractors)
    default:
      return []
  }
}

// The reviewer may reword a math question but not change what it computes. In
// testing, Qwen3.5 4B "simplified" a correct (v0 + v) / 2 into v0 + v / 2, which
// still passes every check but gives a wrong answer key in every version. Its
// schema asks only for the wording, and the validated computation is merged
// back in here.
function keepComputation(draft: QuestionDraft, revised: unknown): unknown {
  if (draft.item_type !== 'math' || !revised || typeof revised !== 'object') return revised
  const { variables, constraints, answer_formula, tolerance_percent, units } = draft
  return { ...revised, variables, constraints, answer_formula, tolerance_percent, units }
}

// Small models mark a division "exact" (tolerance 0) and ignore the hint on
// every retry. When the answers are not exact, 1% is what an author would
// pick, so it is set here instead of failing the item. Only model output is
// repaired: an instructor who sets 0 in the editor still gets the error.
//
// Qwen3.5 4B also writes step 0 for a range that starts at a fraction, such as
// a time of 0.5 to 3 s, and repeats it on every retry. The step becomes the
// largest round number both ends are multiples of that still gives ten or more
// values.
export function repairDraft(itemType: ItemType, value: unknown): unknown {
  value = repairProse(value)
  if (itemType !== 'math' || !value || typeof value !== 'object') return value
  let record = lowercaseNames(value as Record<string, unknown>)
  if (Array.isArray(record.variables) && record.variables.some(hasZeroStep)) {
    record = { ...record, variables: record.variables.map((v) => (hasZeroStep(v) ? { ...v, step: roundStep(v.min, v.max) } : v)) }
  }
  if (record.tolerance_percent !== 0) return record
  const result = ITEM_SCHEMAS.math.safeParse(record)
  const inexact = !result.success && result.error.issues.some((issue) => issue.code === 'custom' && issue.params?.math === 'inexact_answer')
  return inexact ? { ...record, tolerance_percent: 1 } : record
}

// Gemma 4 names variables the way physics writes them, F_net or V0, and keeps
// the capitals on every retry: under Transformers.js the grammar cannot carry
// the name pattern. A name that is valid once lowercased is renamed, along with
// every use of it in the formula, the constraints, the stem and explanation
// placeholders and the worked example. A use that differs from a declared name
// only in case is the same variable and is lowercased too. Names that would
// collide (M and m) or become reserved (E) are left for the error message.
const IDENTIFIER = /(?<![A-Za-z0-9_.])[A-Za-z_][A-Za-z0-9_]*/g
const RESERVED_NAMES = new Set<string>([...CONSTANT_NAMES, ...FUNCTION_NAMES, 'answer'])

function lowercaseNames(record: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(record.variables)) return record
  const declared = record.variables.map((v) => (v && typeof v === 'object' ? (v as { name?: unknown }).name : undefined))
  const names = new Set(declared.filter((name): name is string => typeof name === 'string' && VARIABLE_NAME.test(name)))
  const renames = new Map<string, string>()
  for (const name of declared) {
    if (typeof name !== 'string' || VARIABLE_NAME.test(name)) continue
    const lower = name.toLowerCase()
    if (!VARIABLE_NAME.test(lower) || names.has(lower) || RESERVED_NAMES.has(lower)) continue
    renames.set(name, lower)
    names.add(lower)
  }
  const fix = (id: string) => renames.get(id) ?? (!declared.includes(id) && names.has(id.toLowerCase()) ? id.toLowerCase() : id)
  const formula = (value: unknown) => (typeof value === 'string' ? value.replace(IDENTIFIER, fix) : value)
  const template = (value: unknown) =>
    typeof value === 'string' ? value.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => `{{${inner.replace(IDENTIFIER, fix)}}}`) : value
  const out: Record<string, unknown> = {
    ...record,
    variables: record.variables.map((v) => {
      const name = (v as { name?: unknown } | null)?.name
      return typeof name === 'string' && renames.has(name) ? { ...v, name: renames.get(name) } : v
    }),
    answer_formula: formula(record.answer_formula),
    stem: template(record.stem),
    explanation: template(record.explanation),
  }
  if (Array.isArray(record.constraints)) out.constraints = record.constraints.map(formula)
  const example = record.worked_example as { values?: unknown } | undefined
  if (example && Array.isArray(example.values)) {
    out.worked_example = {
      ...example,
      values: example.values.map((v) => {
        const name = (v as { name?: unknown } | null)?.name
        return typeof name === 'string' ? { ...v, name: name.replace(IDENTIFIER, fix) } : v
      }),
    }
  }
  return JSON.stringify(out) === JSON.stringify(record) ? record : out
}

// Gemma 4 writes $…$ and $$…$$ math although the prompt asks for \( \) and
// \[ \], which are all ADAPT's MathJax and the preview render. Pandoc's rule
// tells math from prices: an opening $ is followed by a non-space, a closing
// one follows a non-space and is not followed by a digit ("$5 and $10" stays).
const DISPLAY_DOLLARS = /\$\$(?!\s)([^$]+?)(?<!\s)\$\$/g
const INLINE_DOLLARS = /(?<![\\$])\$(?![\s$])([^$\n]*?[^\s\\$])\$(?![\d$])/g

export function dollarsToDelimiters(text: string): string {
  if (!text.includes('$')) return text
  return text.replace(DISPLAY_DOLLARS, '\\[$1\\]').replace(INLINE_DOLLARS, '\\($1\\)')
}

// The textbook writes display math as \[ … \]. Copying it, Gemma 4 kept the
// backslash of \dfrac but not those of the delimiters: "[a = \dfrac{F_{net}}{m}.
// \nonumber ]", which ADAPT shows as typed (1 of 3,844 saved texts,
// 2026-10-09). Square brackets outside math that hold a LaTeX command are taken
// as display math; dropdown blanks such as [a1] hold none.
const BARE_DISPLAY = /(?<!\\)\[([^[\]]*\\[A-Za-z][^[\]]*)(?<!\\)\]/g
const DELIMITED_MATH = /(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/

export function bracketsToDelimiters(text: string): string {
  if (!text.includes('[')) return text
  return text
    .split(DELIMITED_MATH)
    .map((part, i) => (i % 2 ? part : part.replace(BARE_DISPLAY, '\\[$1\\]')))
    .join('')
}

// Gemma 4 also writes LaTeX with no delimiters at all: a choice "x = x_0 +
// \bar{v} t", a key "a \propto F_{net}", and "w = (1.0 kg) \times (9.8 m/s^2)
// = 9.8 N" at the end of a sentence (3 of 3,892 saved texts, 2026-10-09).
// ADAPT shows the commands as typed. A text that is nothing but a formula, with
// no word of two letters or more, is wrapped in \( \). In a sentence the ends
// of the formula cannot be told from the words around it, so common commands
// become the characters they stand for, and unknown ones are left.
const BARE_COMMAND = /\\[A-Za-z]+/
const NOT_WORDS = /\\(?:text|mathrm|textrm|mbox)\s*\{[^{}]*\}|\\[A-Za-z]+|[_^](?:\{[^{}]*\}|[A-Za-z0-9])|\{\{[^{}]*\}\}/g
const COMMAND_CHARACTERS: Record<string, string> = {
  times: '×', cdot: '·', div: '÷', pm: '±', propto: '∝', approx: '≈', sim: '∼', neq: '≠', ne: '≠',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', ll: '≪', gg: '≫', infty: '∞', to: '→', rightarrow: '→',
  leftarrow: '←', Rightarrow: '⇒', degree: '°', ldots: '…', cdots: '⋯',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', epsilon: 'ε', varepsilon: 'ε', theta: 'θ',
  lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', Sigma: 'Σ', tau: 'τ', phi: 'φ', omega: 'ω', Omega: 'Ω',
}
const ACCENTS: Record<string, string> = { bar: '̄', vec: '⃗', hat: '̂', dot: '̇', tilde: '̃' }
const asGroup = (text: string) => (/^[\w.]+$/.test(text.trim()) ? text.trim() : `(${text.trim()})`)

export function bareLatexToMath(text: string, plain = false): string {
  if (!BARE_COMMAND.test(text)) return text
  const parts = text.split(DELIMITED_MATH)
  if (!plain && parts.length === 1 && !/\p{L}{2,}/u.test(text.replace(NOT_WORDS, ' '))) {
    const [, lead, formula, trail] = text.match(/^(\s*)([\s\S]*?)([.,;:]?\s*)$/)!
    return `${lead}\\(${formula}\\)${trail}`
  }
  return parts.map((part, i) => (i % 2 ? part : latexToCharacters(part))).join('')
}

function latexToCharacters(text: string): string {
  return text
    .replace(/\\(?:left|right)(?![A-Za-z])\s*/g, '')
    .replace(/\\(?:text|mathrm|textrm|mbox)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, top: string, bottom: string) => `${asGroup(top)}/${asGroup(bottom)}`)
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, radicand: string) => `√${asGroup(radicand)}`)
    .replace(/\\(bar|vec|hat|dot|tilde)\s*\{([A-Za-z])\}/g, (_, accent: string, letter: string) => letter + ACCENTS[accent])
    .replace(/\\([A-Za-z]+)(?![A-Za-z])/g, (command, name: string) => COMMAND_CHARACTERS[name] ?? command)
    .replace(/\\[,;: ]/g, ' ')
    .replace(/ {2,}/g, ' ')
}

// OpenAI's strict JSON output lets a backslash start only a valid JSON escape,
// so where gpt-6-luna meant \( it sometimes wrote a control character: \f( and
// \f), \u0005( and \u0005), or \u0002 before a correct \(. 3 of 18 Luna
// questions had one (2026-10-07), and their math did not render. Tab, newline
// and carriage return can be real text and are left alone.
const CONTROL_BEFORE_BRACKET = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]([()[\]])/g
const CONTROL_BEFORE_BACKSLASH = /[\u0000-\u0008\u000b\u000c\u000e-\u001f](?=\\)/g

export function controlsToBackslashes(text: string): string {
  return text.replace(CONTROL_BEFORE_BRACKET, '\\$1').replace(CONTROL_BEFORE_BACKSLASH, '')
}

// Gemma 4 writes subscripted symbols as plain text ("F_net", "F_{net}"), which
// ADAPT shows as typed. In 715 saved drafts (2026-10-08) all 71 one-letter
// names with a subscript outside math were a symbol or a figure's force label
// (F_floor). As a check that sent them back, Gemma could not write "F_net" as
// math in 9 attempts on 2 of 30 questions, so the app does it.
const PLAIN_SYMBOL = /(?<![\p{L}\p{N}\\])([A-Za-z])_(?:\{([^{}]*)\}|([A-Za-z0-9]+))/gu
const MATH_OR_PLACEHOLDER = /(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\{\{[\s\S]*?\}\})/

// Math drops spaces: F_{wall on feet} would read "wallonfeet".
const subscript = (text: string) => (/\s/.test(text) ? `\\text{${text}}` : text)

export function symbolsToMath(text: string): string {
  if (!text.includes('_')) return text
  return text
    .split(MATH_OR_PLACEHOLDER)
    .map((part, i) => (i % 2 ? part : part.replace(PLAIN_SYMBOL, (_, name, braced, bare) => `\\(${name}_{${subscript(braced ?? bare)}}\\)`)))
    .join('')
}

// The model is shown the source as [paragraph N] blocks and cites them in
// what students read: "Paragraph 21 explicitly states that …", "The source
// states in paragraph 21 that …", "…, as shown in paragraphs 14 and 21",
// "(Paragraph 10, 21)". As a check that sent them back, this was 27 of 34
// rejections in 30 Gemma 4 E4B fill-in-the-blank drafts (2026-10-08), and one
// question failed all 9 attempts on it. A citation in brackets or an "as shown
// in" clause is dropped, "in paragraph N" after "states" is dropped, and a
// paragraph that states something becomes the textbook. checkModelDraft still
// rejects any form this misses.
const PARAGRAPHS = String.raw`(?:the\s+)?paragraphs?\s+\d+(?:\s*(?:,\s*and|,|and|&|or|to|-|–)\s*\d+)*`
const AS_SHOWN = String.raw`as\s+(?:\w+\s+)?(?:stated|shown|described|explained|mentioned|noted|seen|given|defined|discussed|presented|established|indicated|outlined)`
const REPORTING_VERBS =
  'state|show|confirm|provide|explain|say|describe|define|give|note|mention|present|introduce|list|indicate|discuss|emphasize|highlight|establish|clarif|express|support|demonstrate|illustrate|use|contain|relate|link|connect|tell'
// "(paragraph 21)", "[see paragraphs 3 and 4]"
const CITED_PARAGRAPHS = new RegExp(String.raw`\s*[([](?:see\s+|cf\.\s+)?${PARAGRAPHS}[)\]]`, 'gi')
// "According to paragraph 3, the …", "As stated in paragraph 3, mass …"
const PARAGRAPH_LEAD_IN = new RegExp(
  String.raw`(^|[.!?]\s+)(?:according\s+to|in|from|per|based\s+on|${AS_SHOWN}\s+in)\s+${PARAGRAPHS}\s*,\s*(\p{Ll})?`,
  'giu',
)
// ", as shown in paragraphs 14 and 21" and ", as noted in paragraph 3,"
const AS_SHOWN_IN_PARAGRAPHS = new RegExp(String.raw`,?\s*\b${AS_SHOWN}\s+in\s+${PARAGRAPHS}\b,?`, 'gi')
// "Paragraph 21 explicitly states", "paragraphs 24 and 26 both state"
const PARAGRAPH_SAYS = new RegExp(
  String.raw`\b${PARAGRAPHS}\s+((?:(?:also|explicitly|directly|clearly|both|further|specifically|then)\s+)*)(${REPORTING_VERBS})(?:e?s|ies|y)?\b`,
  'gi',
)
// "states in paragraph 21 that", "states in paragraph 21:"
const SAYS_IN_PARAGRAPH = new RegExp(String.raw`\s+(?:in|from)\s+${PARAGRAPHS}(?=\s*(?:that\b|[,:]))`, 'gi')
// "is described in paragraph 21"
const IN_PARAGRAPH = new RegExp(String.raw`\b(in|from)\s+${PARAGRAPHS}\b`, 'gi')

export function stripParagraphMentions(text: string): string {
  if (!/paragraph/i.test(text)) return text
  return text
    .replace(CITED_PARAGRAPHS, '')
    .replace(PARAGRAPH_LEAD_IN, (_, before: string, letter?: string) => before + (letter ?? '').toUpperCase())
    .replace(AS_SHOWN_IN_PARAGRAPHS, '')
    .replace(PARAGRAPH_SAYS, (_, adverbs: string, verb: string, offset: number, whole: string) => {
      const sentenceStart = /(?:^|[.!?]\s+)$/.test(whole.slice(0, offset))
      return `${sentenceStart ? 'The' : 'the'} textbook ${adverbs.replace(/\bboth\s+/gi, '')}${thirdPerson(verb)}`
    })
    .replace(SAYS_IN_PARAGRAPH, '')
    .replace(IN_PARAGRAPH, '$1 the textbook')
}

function thirdPerson(stem: string): string {
  if (stem.toLowerCase() === 'clarif') return `${stem}ies`
  return /(?:s|sh|ch|x)$/i.test(stem) ? `${stem}es` : `${stem}s`
}

// Formulas, variable names, ids and units are not prose.
const NOT_PROSE = new Set(['answer_formula', 'constraints', 'variables', 'units', 'id', 'name'])
// ADAPT lists titles as text, so they keep a symbol as written.
const PLAIN_TEXT = new Set(['title', 'concept_label'])

function repairProse(value: unknown, plain = false): unknown {
  if (typeof value === 'string') {
    const delimited = bracketsToDelimiters(dollarsToDelimiters(controlsToBackslashes(value)))
    const text = stripParagraphMentions(bareLatexToMath(delimited, plain))
    return plain ? text : symbolsToMath(text)
  }
  if (Array.isArray(value)) {
    const next = value.map((item) => repairProse(item, plain))
    return next.every((item, i) => item === value[i]) ? value : next
  }
  if (!value || typeof value !== 'object') return value
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    next[key] = NOT_PROSE.has(key) ? item : repairProse(item, plain || PLAIN_TEXT.has(key))
    changed ||= next[key] !== item
  }
  return changed ? next : value
}

const ROUND_STEPS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001]

function hasZeroStep(v: unknown): v is { min: number; max: number; step: 0 } {
  const { min, max, step } = (v ?? {}) as Record<string, unknown>
  return step === 0 && typeof min === 'number' && typeof max === 'number' && max > min
}

function roundStep(min: number, max: number): number {
  const multiple = (x: number, step: number) => Math.abs(x / step - Math.round(x / step)) < 1e-9
  const fits = ROUND_STEPS.filter((step) => multiple(min, step) && multiple(max, step))
  return fits.find((step) => (max - min) / step >= 9) ?? fits.at(-1) ?? (max - min) / 10
}

// "According to the provided text, …" reads oddly once the question is in a
// course; students never saw "the text". Gemma 4 E4B also writes "based on
// the context provided" and "based on the provided information". "The
// textbook" is left: students have one. Only a reference that ends a clause
// is dropped, so "as shown in the context of the wagon" stays whole.
const SOURCE_NOUN = String.raw`(?:(?:provided|given|above|supplied)\s+)?(?:source\s+(?:text|material)|text|passage|excerpt|source|reading|context|information|material)(?:\s+(?:provided|given|above))?`
const SOURCE_REFERENCE = new RegExp(
  String.raw`\s*,?\s*\b(?:according to|based on|as (?:stated|described|explained|mentioned|found|given|shown|presented|noted|seen) in)\s+the\s+${SOURCE_NOUN}(?=\s*[,.;:?!)]|\s*$),?`,
  'gi',
)
// Marks where a sentence lost its first words, so the next letter is capitalized.
const CAPITALIZE = '\u0000'

export function stripSourceReferences(value: string): string {
  const stripped = value
    .replace(SOURCE_REFERENCE, (_, offset: number, whole: string) => (/(?:^|[.!?]\s*)$/.test(whole.slice(0, offset)) ? ` ${CAPITALIZE}` : ''))
    .replace(/\s+([?.!,])/g, '$1')
    .replace(new RegExp(`${CAPITALIZE}\\s*(\\p{L})?`, 'gu'), (_, letter?: string) => (letter ?? '').toUpperCase())
    .replace(/ {2,}/g, ' ')
    .trim()
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
}

// "The source states that …", "The text explicitly states, "…"": students
// never saw the source, and an explanation should give the reason, not cite
// it. Of 2,542 distinct stems, explanations, feedback and model answers in the
// saved test runs (2026-10-09), 556 open a sentence this way after
// stripSourceReferences, nearly all explanations and feedback. A sentence that
// only reports a clause or a quotation becomes the clause itself (410 of
// them), also after "The textbook states", which stripParagraphMentions writes.
// Otherwise, as in "The text states that a larger force gives a larger
// acceleration, not that they are equal", the source becomes the textbook (146).
const REPORTER = String.raw`(?:(?:provided|given)\s+)?(?:source\s+text|textbook|text|passage|excerpt|source|reading)`
const REPORTS = String.raw`(?:(?:also|explicitly|directly|clearly|specifically|further)\s+){0,2}(?:states?|explains?|notes?|says?|describes?|mentions?|indicates?|defines?|shows?|specifies|establishes|confirms?|emphasizes|highlights|clarifies|provides|gives|presents)`
const SAYS = String.raw`(^|[.!?]\s+)(?:The\s+${REPORTER}|It)\s+${REPORTS}`
// The quotation must be the rest of the sentence and hold no other quotation.
const QUOTED_CLAIM = new RegExp(String.raw`${SAYS}(?:\s+that)?\s*[,:]?\s*(?:["“]([^"“”]+?)["”]|'([^"“”]+?)')(?=[.!?]?(?:\s+\p{Lu}|\s*$))`, 'gu')
const CLAIM = new RegExp(String.raw`${SAYS}\s+that\s+(?=\S)(\p{L})?`, 'gu')
const REPORTER_SUBJECT = new RegExp(String.raw`\b(the)\s+${REPORTER}(?=\s+${REPORTS}\b)`, 'gi')
// The clause cannot stand alone when the rest of the sentence still speaks of
// the source: "…, not that they are equal", "…, and that …", "…, but does not
// specify …", "…, and provides the equation …".
const LEANS_ON_THAT = new RegExp(
  String.raw`\b(?:not|and|but) that\b|\brather than\b|\bbut not\b|\b(?:but|yet)\s+(?:does|did|do|is|was|has|only)\b|\b(?:and|but|yet)\s+${REPORTS}\b`,
  'i',
)

export function stripSourceClaims(text: string): string {
  if (!/\b(?:source|text|textbook|passage|excerpt|reading)\b/i.test(text)) return text
  const sentenceRest = (whole: string, from: number) => whole.slice(from).split(/[.!?](?:\s|$)/)[0]
  // "It also states that …" is rewritten only once a sentence has lost its
  // "The text states", so a second pass catches it after either form.
  let stripped = false
  const pass = (current: string) =>
    current
      .replace(QUOTED_CLAIM, (match: string, before: string, double?: string, single?: string, ...rest: unknown[]) => {
        if (/^It\b/.test(match.slice(before.length)) && !stripped) return match
        stripped = true
        const quote = (double ?? single)!
        const [offset, whole] = rest as [number, string]
        const next = whole.charAt(offset + match.length)
        const claim = /[.!?]$/.test(quote) && /[.!?]/.test(next) ? quote.slice(0, -1) : quote
        return before + claim.charAt(0).toUpperCase() + claim.slice(1)
      })
      .replace(CLAIM, (match: string, before: string, letter: string | undefined, offset: number, whole: string) => {
        if ((/^It\b/.test(match.slice(before.length)) && !stripped) || LEANS_ON_THAT.test(sentenceRest(whole, offset + match.length))) return match
        stripped = true
        return before + (letter ?? '').toUpperCase()
      })
  return pass(pass(text)).replace(REPORTER_SUBJECT, '$1 textbook')
}

// 21 of 25 saved Gemma 4 E4B math explanations (2026-10-09) explain the
// formula but never give its result, so a student who got the question wrong
// never sees the number. Those get a closing sentence with {{answer}}.
export function withFinalValue(draft: DraftOf<'math'>): DraftOf<'math'> {
  const formula = draft.answer_formula.replace(/\s+/g, '')
  const placeholders = [...draft.explanation.matchAll(/\{\{([^{}]*)\}\}/g)].map(([, inner]) => inner.replace(/\s+/g, ''))
  if (placeholders.some((inner) => inner === 'answer' || inner === formula)) return draft
  const explanation = draft.explanation.trim()
  const ending = `${/[.!?]$/.test(explanation) ? '' : '.'} With these numbers, the answer is {{answer}}${draft.units ? ` ${formatUnits(draft.units)}` : ''}.`
  return explanation.length + ending.length > 2_000 ? draft : { ...draft, explanation: explanation + ending }
}

// Deterministic clean-up the model should not be trusted with.
function finalize(draft: QuestionDraft, concept: Concept): QuestionDraft {
  const clean = (text: string) => stripSourceReferences(stripSourceClaims(text))
  const out = {
    ...draft,
    concept_label: concept.label,
    stem: clean(draft.stem),
    explanation: clean(draft.explanation),
  }
  if (out.item_type === 'multiple_choice' || out.item_type === 'multiple_answers') {
    // Models favour putting the answer first; spread it out for previews and
    // for importers that do not shuffle.
    out.choices = shuffle(out.choices.map((choice) => ({ ...choice, feedback: choice.feedback && clean(choice.feedback) })))
  }
  if (out.item_type === 'essay') out.model_answer = clean(out.model_answer)
  return out.item_type === 'math' ? withFinalValue(out) : out
}

function shuffle<T>(values: T[]): T[] {
  const copy = [...values]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
