import { z } from 'zod'
import type { LLMProvider, ProgressEvent } from '../llm/types'
import { checkWorkedExample } from '../math/spec'
import { db, newId, type StoredItem, type StoredSource } from '../storage/db'
import {
  conceptPrompt,
  draftPrompt,
  reviewPrompt,
  SYSTEM_PROMPT,
  type Concept,
  type SourceUnit,
} from './prompts'
import {
  formatIssues,
  ITEM_SCHEMAS,
  ITEM_TYPE_LABELS,
  MATH_WORDING_SCHEMA,
  llmSchemaFor,
  parseDraft,
  toLlmSchema,
  WORKED_EXAMPLE_SCHEMA,
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
    for (const paragraph of page.paragraphs) {
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

export async function runGeneration(
  setId: string,
  source: StoredSource,
  plan: GenerationPlan,
  provider: LLMProvider,
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
): Promise<{ created: number; failures: string[] }> {
  const units = planUnits(source, plan.perPage, SOURCE_BUDGET[provider.id])
  const total = units.reduce((sum, u) => sum + u.count, 0)
  const existing = await db.items.where('setId').equals(setId).sortBy('position')
  const stems = existing.map((item) => item.draft.stem)
  let position = existing.length
  let done = 0
  let created = 0
  const failures: string[] = []
  callbacks.onProgress(0, total)

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
      concepts = target.count
        ? extractConcepts(provider, target.unit, target.count, calculations, signal, callbacks)
        : extractConcepts(provider, target.unit, 2, 2, signal, callbacks)
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
      failures.push(`${current.unit.pageTitle}: ${message(error)}`)
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
      callbacks.onStatus(`Writing a ${itemType.replace(/_/g, ' ')} question on “${concept.label}”…`)
      try {
        let draft = await draftItem(provider, unit, concept, itemType, stems.slice(-12), allowed, signal, callbacks)
        let critique: string[] = notes
        // On the in-browser model the reviewer may only reword a math question
        // (see keepComputation), and its notes on them were mostly false claims
        // about placeholder format, so the ~20 s review is skipped.
        const review = plan.reviewPass && !(provider.id === 'local' && draft.item_type === 'math')
        if (review) {
          callbacks.onStatus(`Reviewing “${draft.title}”…`)
          try {
            const reviewed = await reviewItem(provider, unit, concept, draft, allowed, signal, callbacks)
            draft = reviewed.draft
            critique = [...notes, ...reviewed.issues]
          } catch (error) {
            if (signal.aborted) throw error
            critique = [...notes, `Automatic review could not complete (${message(error)}); the unreviewed draft was kept.`]
          }
        }
        draft = finalize(draft, concept)
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
        failures.push(`${itemType.replace(/_/g, ' ')} on “${concept.label}”: ${message(error)}`)
      }
      callbacks.onProgress(++done, total)
    }
  }
  return { created, failures }
}

async function extractConcepts(
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
      return concepts
    },
  })
  return result.value
}

async function draftItem(
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
      const repaired = repairDraft(itemType, value)
      const draft = parseDraft(itemType, repaired, allowed)
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

async function reviewItem(
  provider: LLMProvider,
  unit: SourceUnit,
  concept: Concept,
  draft: QuestionDraft,
  allowed: Set<number>,
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
): Promise<{ draft: QuestionDraft; issues: string[] }> {
  const schema = z.object({
    issues: z.array(z.string().trim().min(1).max(400)).max(8),
    revised: draft.item_type === 'math' ? MATH_WORDING_SCHEMA : ITEM_SCHEMAS[draft.item_type],
  })
  const result = await provider.complete({
    system: SYSTEM_PROMPT,
    prompt: reviewPrompt(unit, concept, draft),
    schemaName: 'item_review',
    schema: toLlmSchema(schema),
    signal,
    onProgress: callbacks.onModelEvent,
    validate: (value) => {
      const record = value as { issues?: unknown; revised?: unknown }
      const issues = z.array(z.string()).max(8).safeParse(record?.issues)
      return {
        issues: issues.success ? issues.data : [],
        draft: parseDraft(draft.item_type, repairDraft(draft.item_type, keepComputation(draft, record?.revised)), allowed),
      }
    },
  })
  return result.value
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
  if (itemType !== 'math' || !value || typeof value !== 'object') return value
  let record = value as Record<string, unknown>
  if (Array.isArray(record.variables) && record.variables.some(hasZeroStep)) {
    record = { ...record, variables: record.variables.map((v) => (hasZeroStep(v) ? { ...v, step: roundStep(v.min, v.max) } : v)) }
  }
  if (record.tolerance_percent !== 0) return record
  const result = ITEM_SCHEMAS.math.safeParse(record)
  const inexact = !result.success && result.error.issues.some((issue) => issue.code === 'custom' && issue.params?.math === 'inexact_answer')
  return inexact ? { ...record, tolerance_percent: 1 } : record
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
// course; students never saw "the text".
const SOURCE_REFERENCE =
  /\s*,?\s*\b(?:according to|based on|as (?:stated|described|explained|mentioned|found|given|shown) in)\s+the\s+(?:provided\s+|given\s+|above\s+)?(?:source\s+text|text|passage|excerpt|source|reading)\b,?/gi

export function stripSourceReferences(value: string): string {
  const stripped = value.replace(SOURCE_REFERENCE, '').replace(/\s+([?.!,])/g, '$1').trim()
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
}

// Deterministic clean-up the model should not be trusted with.
function finalize(draft: QuestionDraft, concept: Concept): QuestionDraft {
  const out = {
    ...draft,
    concept_label: concept.label,
    stem: stripSourceReferences(draft.stem),
    explanation: stripSourceReferences(draft.explanation),
  }
  if (out.item_type === 'multiple_choice' || out.item_type === 'multiple_answers') {
    // Models favour putting the answer first; spread it out for previews and
    // for importers that do not shuffle.
    out.choices = shuffle(out.choices)
  }
  return out
}

function shuffle<T>(values: T[]): T[] {
  const copy = [...values]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
