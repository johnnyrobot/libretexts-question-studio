import { z } from 'zod'
import type { JsonSchema } from '../llm/types'
import { compileMath, MathSpecError, MAX_TOLERANCE_PERCENT, VARIABLE_NAME } from '../math/spec'

// The item types here are exactly the ones ADAPT's QTI importer can turn into
// ADAPT questions (Canvas QTI 1.2 `question_type` values, see qti/canvas.ts).
// `math` is the exception that proves the rule: it is a template whose versions
// export as numerical questions. Each type has its own narrow schema: narrow schemas give small in-browser
// models far less room to go wrong than one schema with every field nullable.

export const ITEM_TYPES = [
  'multiple_choice',
  'true_false',
  'multiple_answers',
  'numerical',
  'math',
  'matching',
  'fill_in_blank',
  'dropdowns',
  'essay',
] as const

export type ItemType = (typeof ITEM_TYPES)[number]

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  multiple_choice: 'Multiple choice',
  true_false: 'True / false',
  multiple_answers: 'Select all that apply',
  numerical: 'Numerical',
  math: 'Math (randomized numbers)',
  matching: 'Matching',
  fill_in_blank: 'Fill in the blank',
  dropdowns: 'Multiple dropdowns',
  essay: 'Essay (manually graded)',
}

export const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'] as const
export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const

// Matches ADAPT's own placeholder and blank detection exactly.
export const BLANK_RUN = /_{2,}/g
export const DROPDOWN_PLACEHOLDER = /\[([a-z][a-z0-9]{0,15})\]/g

const text = (max: number) => z.string().trim().min(1).max(max)

// eslint-disable-next-line no-control-regex -- detecting exactly these is the point
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/

const common = {
  title: text(120),
  concept_label: text(160),
  stem: text(2_000),
  explanation: text(2_000),
  bloom: z.enum(BLOOM_LEVELS),
  difficulty: z.enum(DIFFICULTIES),
  citation_paragraphs: z.array(z.int().min(0)).min(1).max(12),
}

const choice = z.object({
  text: text(500),
  correct: z.boolean(),
  feedback: z.string().trim().max(500).nullable(),
})

const multipleChoice = z
  .object({ ...common, choices: z.array(choice).length(4) })
  .superRefine((item, ctx) => {
    if (item.choices.filter((c) => c.correct).length !== 1) {
      ctx.addIssue({ code: 'custom', message: 'multiple_choice needs exactly one choice with correct=true' })
    }
    uniqueTexts(item.choices.map((c) => c.text), 'choices', ctx)
  })

const trueFalse = z.object({ ...common, answer: z.boolean() }).superRefine((item, ctx) => {
  if (item.stem.trim().endsWith('?')) {
    ctx.addIssue({ code: 'custom', message: 'true_false stem must be a declarative statement, not a question' })
  }
})

const multipleAnswers = z
  .object({ ...common, choices: z.array(choice).min(3).max(6) })
  .superRefine((item, ctx) => {
    const correct = item.choices.filter((c) => c.correct).length
    if (correct < 1 || correct === item.choices.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'multiple_answers needs at least one correct and at least one incorrect choice',
      })
    }
    uniqueTexts(item.choices.map((c) => c.text), 'choices', ctx)
  })

// Small models sometimes write the string "null" or "none" for no unit. A
// preprocess, unlike a transform, still has an output type the model's JSON
// Schema can show.
const units = z.preprocess(
  (u) => (typeof u === 'string' && /^\s*(null|none|n\/a|unitless|-)?\s*$/i.test(u) ? null : u),
  z.string().trim().max(40).nullable(),
)

const numerical = z
  .object({
    ...common,
    answer: z.number(),
    tolerance: z.number().min(0),
    units,
  })
  .superRefine((item, ctx) => {
    if ((item.stem.match(BLANK_RUN) ?? []).length > 0) {
      ctx.addIssue({ code: 'custom', message: 'numerical stem must ask for a computed value, not contain a ____ blank' })
    }
    if (!/\d/.test(item.stem) && !/how many/i.test(item.stem)) {
      ctx.addIssue({ code: 'custom', message: 'numerical stem must give the numbers needed to compute the answer' })
    }
    if (!Number.isFinite(item.answer) || !Number.isFinite(item.tolerance)) {
      ctx.addIssue({ code: 'custom', message: 'answer and tolerance must be finite numbers' })
    }
    if (item.tolerance > 0 && item.tolerance < 0.00001) {
      ctx.addIssue({ code: 'custom', message: 'tolerance must be 0 or at least 0.00001 (ADAPT rounds margins to 5 decimals)' })
    }
  })

// Models copy the stem's {{name}} placeholders into formulas, where the
// variable is meant: "({{xf}} - {{x0}}) / {{t}}" becomes "((xf) - (x0)) / (t)".
const formula = (max: number) =>
  z.preprocess((value) => (typeof value === 'string' ? value.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => `(${inner.trim()})`) : value), text(max))

// stem and explanation are templates with {{name}} placeholders; compileMath
// checks the whole spec over many seeded samples (see math/spec.ts).
const math = z
  .object({
    ...common,
    variables: z
      .array(z.object({ name: z.string().regex(VARIABLE_NAME), min: z.number(), max: z.number(), step: z.number().positive() }))
      .min(1)
      .max(6),
    constraints: z.array(formula(200)).max(6),
    answer_formula: formula(500),
    // compileMath also rejects anything between 0 and MIN_TOLERANCE_PERCENT.
    tolerance_percent: z.number().min(0).max(MAX_TOLERANCE_PERCENT),
    units,
  })
  .superRefine((item, ctx) => {
    try {
      compileMath(item)
    } catch (error) {
      if (!(error instanceof MathSpecError)) throw error
      ctx.addIssue({ code: 'custom', message: error.message, params: { math: error.code } })
    }
  })

const matching = z
  .object({
    ...common,
    pairs: z.array(z.object({ prompt: text(300), match: text(300) })).min(3).max(8),
    distractors: z.array(text(300)).max(4),
  })
  .superRefine((item, ctx) => {
    uniqueTexts(item.pairs.map((p) => p.prompt), 'pair prompts', ctx)
    uniqueTexts([...item.pairs.map((p) => p.match), ...item.distractors], 'matches and distractors', ctx)
    const matches = new Set([...item.pairs.map((p) => p.match), ...item.distractors].map((m) => m.trim().toLowerCase()))
    const reused = item.pairs.find((p) => matches.has(p.prompt.trim().toLowerCase()))
    if (reused) {
      ctx.addIssue({ code: 'custom', message: `"${reused.prompt}" is used both as a prompt and as a match` })
    }
  })

const fillInBlank = z
  .object({
    ...common,
    answer: text(80),
    alternates: z.array(text(80)).max(3),
  })
  .superRefine((item, ctx) => {
    const runs = item.stem.match(BLANK_RUN) ?? []
    if (runs.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: `fill_in_blank stem must contain exactly one blank written as ____ (found ${runs.length})`,
      })
    }
    if (item.stem.includes('?')) {
      ctx.addIssue({ code: 'custom', message: 'fill_in_blank stem must be a statement with the blank inside it, not a question' })
    }
    if (mentions(item.stem, item.answer)) {
      ctx.addIssue({ code: 'custom', message: `the stem gives the answer away: "${item.answer}" already appears in it` })
    }
    if ([item.answer, ...item.alternates].some((a) => a.includes('__'))) {
      ctx.addIssue({ code: 'custom', message: 'answers must not contain underscores runs' })
    }
  })

const dropdowns = z
  .object({
    ...common,
    blanks: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z][a-z0-9]{0,15}$/),
          correct: text(120),
          distractors: z.array(text(120)).min(1).max(4),
        }),
      )
      .min(2)
      .max(5),
  })
  .superRefine((item, ctx) => {
    const ids = item.blanks.map((b) => b.id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'dropdown blank ids must be unique' })
    }
    const placeholders = [...item.stem.matchAll(DROPDOWN_PLACEHOLDER)].map((m) => m[1])
    const brackets = (item.stem.match(/[[\]]/g) ?? []).length
    if (
      placeholders.length !== ids.length ||
      ids.some((id) => placeholders.filter((p) => p === id).length !== 1) ||
      brackets !== ids.length * 2
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `dropdowns stem must contain each blank exactly once as [id] (${ids.map((id) => `[${id}]`).join(', ')}) and no other square brackets or \\[ \\] math`,
      })
    }
    if (item.stem.includes('?')) {
      ctx.addIssue({ code: 'custom', message: 'dropdowns stem must be statements with the [id] blanks inside them, not a question' })
    }
    const stemText = item.stem.replace(DROPDOWN_PLACEHOLDER, ' ')
    for (const blank of item.blanks) {
      uniqueTexts([blank.correct, ...blank.distractors], `options for [${blank.id}]`, ctx)
      if (mentions(stemText, blank.correct)) {
        ctx.addIssue({ code: 'custom', message: `the stem gives [${blank.id}] away: "${blank.correct}" already appears in it` })
      }
    }
  })

const essay = z.object({ ...common, model_answer: text(3_000) })

export const ITEM_SCHEMAS = {
  multiple_choice: multipleChoice,
  true_false: trueFalse,
  multiple_answers: multipleAnswers,
  numerical,
  math,
  matching,
  fill_in_blank: fillInBlank,
  dropdowns,
  essay,
} as const

type Payload<K extends ItemType> = z.output<(typeof ITEM_SCHEMAS)[K]>

export type QuestionDraft = {
  [K in ItemType]: { item_type: K } & Payload<K>
}[ItemType]

export type DraftOf<K extends ItemType> = Extract<QuestionDraft, { item_type: K }>

// True when `answer` appears in `text` as a whole word or phrase, ignoring case.
function mentions(text: string, answer: string): boolean {
  const needle = answer.trim().toLowerCase()
  if (needle.length < 3) return false
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(text)
}

function uniqueTexts(values: string[], label: string, ctx: z.RefinementCtx) {
  const seen = new Set<string>()
  for (const value of values) {
    const key = value.trim().toLowerCase()
    if (seen.has(key)) {
      ctx.addIssue({ code: 'custom', message: `${label} must be distinct (duplicate: "${value}")` })
      return
    }
    seen.add(key)
  }
}

// Validates a model payload for one item type, including that every citation
// points at a paragraph the model was actually shown.
export function parseDraft(itemType: ItemType, value: unknown, allowedParagraphs?: Set<number>): QuestionDraft {
  const result = ITEM_SCHEMAS[itemType].safeParse(value)
  if (!result.success) throw new Error(formatIssues(result.error))
  const draft = { item_type: itemType, ...result.data } as QuestionDraft
  const serialized = JSON.stringify({ ...draft, citation_paragraphs: undefined, concept_label: undefined })
  if (XML_FORBIDDEN.test(serialized)) {
    throw new Error('text contains control characters that are not allowed in XML')
  }
  if (/\bparagraphs?\s+\d+/i.test(serialized)) {
    throw new Error('student-facing text must not mention paragraph numbers; cite them only in citation_paragraphs')
  }
  if (allowedParagraphs) {
    const invalid = draft.citation_paragraphs.filter((p) => !allowedParagraphs.has(p))
    if (invalid.length) {
      throw new Error(
        `citation_paragraphs ${invalid.join(', ')} are not in the source; use only: ${[...allowedParagraphs].join(', ')}`,
      )
    }
  }
  return draft
}

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ')
}

// JSON Schema handed to the model. Length limits are dropped (OpenAI strict mode
// does not accept them and grammar engines handle them poorly); zod enforces them.
export function llmSchemaFor(itemType: ItemType): JsonSchema {
  return toLlmSchema(ITEM_SCHEMAS[itemType])
}

export function toLlmSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: 'output', target: 'draft-2020-12' }) as JsonSchema
  delete json.$schema
  return stripKeys(json, new Set(['minLength', 'maxLength'])) as JsonSchema
}

function stripKeys(node: unknown, keys: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((child) => stripKeys(child, keys))
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (keys.has(key)) continue
    // zod emits safe-integer bounds for z.int(); they add nothing for the model.
    if ((key === 'minimum' || key === 'maximum') && Math.abs(value as number) >= Number.MAX_SAFE_INTEGER) continue
    out[key] = stripKeys(value, keys)
  }
  return out
}
