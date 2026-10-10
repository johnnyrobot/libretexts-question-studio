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
// variable is meant, and not always evenly: "({{xf}} - {{x0}}) / {{t}}",
// "( {{xf} - {{x0}} } / {{t}} )" and "( {xf} - {x0} ) / {t}" all mean
// (xf - x0) / t. Formulas have no braces of their own: whole placeholders
// become parentheses, and leftover braces that balance are read as
// parentheses too, which keeps the model's grouping. Otherwise braces around a
// bare name are dropped, and then any that are left. For model drafts the
// worked-example check catches a repair that changed the meaning.
export function repairFormula(value: string): string {
  const placeholders = value.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => `(${inner.trim()})`)
  if (!/[{}]/.test(placeholders)) return placeholders
  const parens = (text: string) => text.replace(/\{/g, '(').replace(/\}/g, ')')
  if (bracesBalance(placeholders)) return parens(placeholders)
  const named = placeholders.replace(/\{+\s*([a-z][a-z0-9_]*)\s*\}+/gi, '$1')
  return bracesBalance(named) ? parens(named) : named.replace(/[{}]/g, '')
}

function bracesBalance(text: string): boolean {
  let depth = 0
  for (const char of text) {
    if (char === '{') depth++
    else if (char === '}' && --depth < 0) return false
  }
  return depth === 0
}

const formula = (max: number) => z.preprocess((value) => (typeof value === 'string' ? repairFormula(value) : value), text(max))

// stem and explanation are templates with {{name}} placeholders; compileMath
// checks the whole spec over many seeded samples (see math/spec.ts).
// What the reviewer may change in a math question: the wording only. The
// computation is merged back in from the validated draft (see pipeline.ts).
export const MATH_WORDING_SCHEMA = z.object(common)

const mathFields = {
  variables: z
    .array(z.object({ name: z.string().regex(VARIABLE_NAME), min: z.number(), max: z.number(), step: z.number().positive() }))
    .min(1)
    .max(6),
  constraints: z.array(formula(200)).max(6),
  answer_formula: formula(500),
  // compileMath also rejects anything between 0 and MIN_TOLERANCE_PERCENT.
  tolerance_percent: z.number().min(0).max(MAX_TOLERANCE_PERCENT),
  units,
}

// The model works one example by hand before it writes answer_formula; the
// pipeline checks the formula against it (checkWorkedExample) and drops it, so
// it is never saved. Values are a list of {name, value}, not a record, because
// OpenAI's strict mode does not accept records.
export const WORKED_EXAMPLE_SCHEMA = z.object({
  values: z.array(z.object({ name: z.string(), value: z.number() })).min(1).max(6),
  working: text(300),
  answer: z.number(),
})

// What the model fills in when it drafts a math question. Properties are
// generated in order, so the example comes just before the formula.
const MATH_DRAFT_SCHEMA = z.object({
  ...common,
  variables: mathFields.variables,
  constraints: mathFields.constraints,
  worked_example: WORKED_EXAMPLE_SCHEMA,
  answer_formula: mathFields.answer_formula,
  tolerance_percent: mathFields.tolerance_percent,
  units,
})

const math = z
  .object({ ...common, ...mathFields })
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

// Validates a payload for one item type, including that every citation points
// at a paragraph the model was actually shown. The editor and backup restore
// use this too; rules only for what the model writes are in checkModelDraft.
export function parseDraft(itemType: ItemType, value: unknown, allowedParagraphs?: Set<number>): QuestionDraft {
  const result = ITEM_SCHEMAS[itemType].safeParse(value)
  if (!result.success) throw new Error(formatIssues(result.error))
  const draft = { item_type: itemType, ...result.data } as QuestionDraft
  // Tested on the strings themselves: JSON.stringify writes a form feed as "\\f".
  if (stringsIn(draft).some((text) => XML_FORBIDDEN.test(text))) {
    throw new Error('text contains control characters that are not allowed in XML')
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

// What the model writes must make sense to a student who sees only the
// question. These rules stay out of parseDraft: an instructor may mean to
// refer to a figure they show in ADAPT, and a backup saved before a rule was
// added must still restore.
export function checkModelDraft(draft: QuestionDraft): void {
  const serialized = JSON.stringify({ ...draft, citation_paragraphs: undefined, concept_label: undefined })
  if (/\bparagraphs?\s+\d+/i.test(serialized)) {
    throw new Error('student-facing text must not mention paragraph numbers; cite them only in citation_paragraphs')
  }
  const reference = serialized.match(SOURCE_LABEL)
  if (reference) {
    throw new Error(
      `students never see "${reference[0]}"; describe in the question whatever it needs from it, and do not mention it`,
    )
  }
}

// "Figure 4.3.1", "Table 2", "Example 4.4": students see the question, not
// the page it was written from.
const SOURCE_LABEL = /\b(?:Figures?|Fig\.|Tables?|Examples?)\s+\d+(?:\.\d+)*/i

// Where it meant LaTeX, Gemma 4 E4B sometimes wrote a stray symbol instead:
// "The weight (Å) of an object … its mass (ℕ)", "a ∈ F_net" for a ∝ F_net, "x
// = x_0 + ← v t", "larger acceleration ≈ a)" for (al>a); once an escape code
// as text, "v_{\u03b1}". This check flags 75 of 1,991 saved drafts
// (2026-10-09), every one of them such a slip; json-escapes.ts has the cause.
// What was meant cannot be told, so the draft goes back. The check reads the
// model's own text, before repairs write \leftarrow as ←, and keeps the
// symbols of the source it was shown and the two the model wrote for
// themselves (− and ∝).
const SYMBOL = /[\u203C-\u205E\u2100-\u2BFF]/gu
const OWN_SYMBOLS = '−∝'
const ESCAPE_CODE = /\\u[\da-fA-F]{4}/

export function checkSymbols(value: unknown, source: string): void {
  for (const text of stringsIn(value)) {
    const code = text.match(ESCAPE_CODE)
    if (code) throw new Error(`"${code[0]}" is an escape code, not text: write the character itself, or LaTeX inside \\( \\)`)
    for (const [symbol] of text.matchAll(SYMBOL)) {
      if (!OWN_SYMBOLS.includes(symbol) && !source.includes(symbol)) {
        throw new Error(`"${symbol}" stands where a symbol or formula should be: write it in LaTeX inside \\( \\), such as \\(a \\propto F_{net}\\)`)
      }
    }
  }
}

// ADAPT marks a fill-in-the-blank right only on an exact match, ignoring case,
// and uses only the first answer. 5 of 30 Gemma 4 E4B answers (2026-10-08)
// were numbers, symbols or equations: "9.8 N", "9.8 m/s^2", "F_{net}/m".
// Rejecting them removed all 5 but doubled the time and left 3 questions out,
// so the reviewer is asked to fix one and the instructor is told if it stays.
const UNTYPEABLE_ANSWER = /[=_\\^{}<>*/|$²³⁻]|(?:^|\s)[-+−]?\d/

export function typedAnswerProblem(draft: QuestionDraft): string | null {
  if (draft.item_type !== 'fill_in_blank' || !UNTYPEABLE_ANSWER.test(draft.answer)) return null
  return `Students must type the answer exactly, and "${draft.answer}" is a number, symbol or equation that many will type differently, so they would be marked wrong.`
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn)
  return []
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
  return toLlmSchema(itemType === 'math' ? MATH_DRAFT_SCHEMA : ITEM_SCHEMAS[itemType])
}

export function toLlmSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: 'output', target: 'draft-2020-12' }) as JsonSchema
  delete json.$schema
  return stripKeys(json, new Set(['minLength', 'maxLength'])) as JsonSchema
}

// XGrammar (WebLLM's grammar engine) compiles a number with a lower bound but
// no upper bound into a grammar that cannot write 0.5 or 0.05, only 0 or ≥ 1:
// Qwen3.5 4B wrote step 0 when asked for 0.5. Those bounds are dropped; zod
// enforces them.
const LOWER_BOUNDS = new Set(['minimum', 'exclusiveMinimum'])

function stripKeys(node: unknown, keys: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((child) => stripKeys(child, keys))
  if (!node || typeof node !== 'object') return node
  const record = node as Record<string, unknown>
  const lowerOnly = record.type === 'number' && !('maximum' in record) && !('exclusiveMaximum' in record)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (keys.has(key) || (lowerOnly && LOWER_BOUNDS.has(key))) continue
    // zod emits safe-integer bounds for z.int(); they add nothing for the model.
    if ((key === 'minimum' || key === 'maximum') && Math.abs(value as number) >= Number.MAX_SAFE_INTEGER) continue
    out[key] = stripKeys(value, keys)
  }
  return out
}
