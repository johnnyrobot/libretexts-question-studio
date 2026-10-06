import { z } from 'zod'
import type { LLMProvider, ProgressEvent } from '../llm/types'
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
  llmSchemaFor,
  parseDraft,
  toLlmSchema,
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
// page's questions across them in proportion to their length.
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
    units.forEach((unit, i) => counts[i] > 0 && plans.push({ pageIndex, unit, count: counts[i] }))
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
  let typeCursor = existing.length
  let done = 0
  let created = 0
  const failures: string[] = []
  callbacks.onProgress(0, total)

  for (const { pageIndex, unit, count } of units) {
    signal.throwIfAborted()
    const allowed = new Set(unit.paragraphs.map(([index]) => index))
    callbacks.onStatus(`Finding concepts in “${unit.pageTitle}”…`)
    let concepts: Concept[]
    try {
      concepts = await extractConcepts(provider, unit, count, allowed, signal, callbacks)
    } catch (error) {
      if (signal.aborted) throw error
      failures.push(`${unit.pageTitle}: ${message(error)}`)
      done += count
      callbacks.onProgress(done, total)
      continue
    }

    for (let j = 0; j < count; j++) {
      signal.throwIfAborted()
      let concept = concepts[j % concepts.length]
      let itemType = plan.itemTypes[typeCursor++ % plan.itemTypes.length]
      const notes: string[] = []
      // A calculation question needs numbers in the source; without them small
      // models invent nonsense, so fall back to another requested type.
      if (itemType === 'numerical') {
        const numeric = concepts.filter((c) => c.quantitative)
        if (numeric.length) concept = numeric[j % numeric.length]
        else {
          itemType = plan.itemTypes.find((t) => t !== 'numerical') ?? 'multiple_choice'
          notes.push(
            `A numerical question was requested, but this section has no quantitative content, so a ${itemType.replace(/_/g, ' ')} question was written instead.`,
          )
        }
      }
      callbacks.onStatus(`Writing a ${itemType.replace(/_/g, ' ')} question on “${concept.label}”…`)
      try {
        let draft = await draftItem(provider, unit, concept, itemType, stems.slice(-12), allowed, signal, callbacks)
        let critique: string[] = notes
        if (plan.reviewPass) {
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
          sourcePageIndex: pageIndex,
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
  allowed: Set<number>,
  signal: AbortSignal,
  callbacks: GenerationCallbacks,
): Promise<Concept[]> {
  const schema = conceptBatch(Math.max(1, count))
  const result = await provider.complete({
    system: SYSTEM_PROMPT,
    prompt: conceptPrompt(unit, count),
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
    validate: (value) => parseDraft(itemType, value, allowed),
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
    revised: ITEM_SCHEMAS[draft.item_type],
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
        draft: parseDraft(draft.item_type, record?.revised, allowed),
      }
    },
  })
  return result.value
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
