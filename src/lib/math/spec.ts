import { evaluate, ExprError, CONSTANT_NAMES, FUNCTION_NAMES, parse, variablesIn, type Node } from './expr'
import { formatComputed, formatNumber } from './format'

// A math question is a template, not a fixed number: the model supplies
// variables with ranges, constraints, and an answer formula, and the answer for
// every version is computed here. Nothing the model writes is executed.
//
// Templates mark values with {{ expression }}. Single braces are left alone so
// TeX such as \frac{a}{b} still works; a bare variable prints its exact value,
// anything computed prints four significant figures.

export interface MathVariable {
  name: string
  min: number
  max: number
  step: number
}

export interface MathSpec {
  stem: string
  explanation: string
  variables: MathVariable[]
  constraints: string[]
  answer_formula: string
  tolerance_percent: number
  units: string | null
}

export interface MathVariant {
  values: Record<string, number>
  answer: number
  // Absolute ± margin, rounded to the 5 decimals ADAPT stores.
  margin: number
  stem: string
  explanation: string
}

export interface CompiledMath {
  answer: Node
  constraints: Node[]
  variants: MathVariant[]
}

export const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,15}$/
export const DEFAULT_VERSIONS = 5
export const MAX_VERSIONS = 10
export const MIN_TOLERANCE_PERCENT = 0.1
export const MAX_TOLERANCE_PERCENT = 5

const RESERVED = new Set<string>([...CONSTANT_NAMES, ...FUNCTION_NAMES, 'answer'])
const VALIDATION_SAMPLES = 25
const MAX_SEEDS = 200
const ATTEMPTS_PER_SEED = 1_000
const MAX_MAGNITUDE = 1e15
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g

export class MathSpecError extends Error {
  // Set for failures the pipeline repairs itself instead of spending a retry.
  readonly code: 'inexact_answer' | undefined

  constructor(message: string, code?: 'inexact_answer') {
    super(message)
    this.code = code
  }
}

export function compileMath(spec: MathSpec, versions = DEFAULT_VERSIONS): CompiledMath {
  const names = checkVariables(spec.variables)
  const tolerance = spec.tolerance_percent
  if (!(tolerance === 0 || (tolerance >= MIN_TOLERANCE_PERCENT && tolerance <= MAX_TOLERANCE_PERCENT))) {
    throw new MathSpecError(`tolerance_percent must be 0 or between ${MIN_TOLERANCE_PERCENT} and ${MAX_TOLERANCE_PERCENT}`)
  }

  const answer = parseOrThrow(spec.answer_formula, names, 'answer_formula')
  const used = variablesIn(answer)
  if (used.size === 0) throw new MathSpecError('answer_formula must use at least one variable')
  const unused = [...names].filter((name) => !used.has(name))
  if (unused.length) {
    throw new MathSpecError(
      `variable${unused.length > 1 ? 's' : ''} ${unused.join(', ')} ${unused.length > 1 ? 'are' : 'is'} not used in answer_formula; declare only the given quantities the answer is computed from, never the quantity being asked for`,
    )
  }
  const constraints = spec.constraints.map((constraint, index) => {
    const node = parseOrThrow(constraint, names, `constraints[${index}]`, true)
    if (node.kind !== 'cmp') throw new MathSpecError(`constraints[${index}] must be a comparison such as "a < b"`)
    return node
  })

  if (/\{\{[^{}]*\banswer\b[^{}]*\}\}/.test(spec.stem)) {
    throw new MathSpecError('the stem must not show {{answer}}; only the explanation may')
  }
  const stem = parseTemplate(spec.stem, names, 'stem')
  const explanation = parseTemplate(spec.explanation, new Set([...names, 'answer']), 'explanation')
  const shown = new Set<string>()
  for (const part of stem) if (part.node) variablesIn(part.node, shown)
  const hidden = spec.variables.filter((v) => !shown.has(v.name)).map((v) => v.name)
  if (hidden.length) {
    throw new MathSpecError(
      `the stem must show every variable as a {{name}} placeholder so students can compute the answer (missing: ${hidden.map((n) => `{{${n}}}`).join(', ')})`,
    )
  }

  // Stem placeholders that equal the answer in every version give it away.
  const leaks = new Set(stem.filter((part) => part.node))
  const answers = new Set<number>()
  const seenStems = new Set<string>()
  const variants: MathVariant[] = []
  for (let seed = 1; seed <= MAX_SEEDS; seed++) {
    if (seed > VALIDATION_SAMPLES && variants.length >= versions) break
    const values = draw(spec.variables, constraints, seed)
    const value = evaluate(answer, values)
    const where = describe(values)
    if (!Number.isFinite(value)) {
      throw new MathSpecError(
        `the answer is not a number when ${where} (division by zero, or a root or log of a negative?); add a constraint or change the ranges`,
      )
    }
    if (Math.abs(value) >= MAX_MAGNITUDE) {
      throw new MathSpecError(`the answer ${value} is too large when ${where}; choose units that keep numbers smaller`)
    }
    if (value === 0) {
      throw new MathSpecError(`the answer is 0 when ${where}; add a constraint so every version has a nonzero answer`)
    }
    const margin = round5((Math.abs(value) * tolerance) / 100)
    if (tolerance > 0 && margin < 0.00001) {
      throw new MathSpecError(
        `the answer ${formatNumber(value)} (when ${where}) is too small for a ±${tolerance}% margin that ADAPT can store (5 decimal places); choose units that make it larger`,
      )
    }
    if (tolerance === 0 && !hasFewDecimals(value)) {
      throw new MathSpecError(
        `with tolerance_percent 0 the answer must be exact, but it is ${formatNumber(value)} when ${where}; set tolerance_percent (about 1) or constrain the numbers`,
        'inexact_answer',
      )
    }
    const stemText = render(stem, values, 'stem', where)
    for (const part of leaks) if (!closeTo(evaluate(part.node!, values), value)) leaks.delete(part)
    answers.add(value)
    if (variants.length < versions && !seenStems.has(stemText)) {
      seenStems.add(stemText)
      variants.push({
        values,
        // Six significant figures are far inside the smallest margin (0.1%)
        // and keep a long decimal out of ADAPT's answer key.
        answer: tolerance > 0 ? Number(value.toPrecision(6)) : value,
        margin,
        stem: stemText,
        explanation: render(explanation, { ...values, answer: value }, 'explanation', where, tolerance === 0),
      })
    }
  }
  const leak = [...leaks][0]
  if (leak) throw new MathSpecError(`the stem gives the answer away: {{${leak.source}}} always equals the answer`)
  if (answers.size < 2) {
    throw new MathSpecError(`the answer is ${formatNumber([...answers][0])} for every set of numbers; answer_formula must depend on the variables`)
  }
  if (variants.length < versions) {
    throw new MathSpecError(
      `only ${variants.length} different version${variants.length === 1 ? '' : 's'} can be made, ${versions} are needed; widen the variable ranges or loosen the constraints`,
    )
  }
  return { answer, constraints, variants }
}

// One example the model worked by hand before it wrote the formula.
export interface WorkedExample {
  values: { name: string; value: number }[]
  answer: number
}

export const WORKED_EXAMPLE_TOLERANCE = 0.05

// A formula can pass every check above and still compute something other than
// what the model meant: Qwen3.5 4B wrote xf - x0 / t for (xf - x0) / t, a
// wrong answer key in every version. The model's own hand calculation must
// agree with the formula to within 5%, which allows for its rounding.
export function checkWorkedExample(spec: Pick<MathSpec, 'variables' | 'answer_formula'>, example: WorkedExample): void {
  const names = new Set(spec.variables.map((v) => v.name))
  const values: Record<string, number> = {}
  for (const { name, value } of example.values) {
    const key = name.replace(/[{}]/g, '').trim()
    if (names.has(key) && Number.isFinite(value)) values[key] = value
  }
  const missing = [...names].filter((name) => !(name in values))
  if (missing.length) {
    throw new MathSpecError(`worked_example.values must give a number for every variable (missing: ${missing.join(', ')})`)
  }
  const where = describe(values)
  const computed = evaluate(parseOrThrow(spec.answer_formula, names, 'answer_formula'), values)
  if (!Number.isFinite(computed)) {
    throw new MathSpecError(`answer_formula is not a number for the worked example (${where}); choose example values that make sense`)
  }
  const gap = Math.abs(computed - example.answer)
  if (!Number.isFinite(example.answer) || gap > WORKED_EXAMPLE_TOLERANCE * Math.max(Math.abs(computed), Math.abs(example.answer))) {
    throw new MathSpecError(
      `the worked example disagrees with answer_formula: when ${where}, "${spec.answer_formula}" gives ${formatComputed(computed)}, but worked_example.answer is ${formatNumber(example.answer)}. ` +
        `Redo the example step by step. If it is right, answer_formula does not compute what the question asks: check its parentheses (a - b / c divides only b) and operators.`,
    )
  }
}

// ---------------------------------------------------------------- checks

function checkVariables(variables: MathVariable[]): Set<string> {
  if (variables.length < 1 || variables.length > 6) throw new MathSpecError('use one to six variables')
  const names = new Set<string>()
  for (const v of variables) {
    if (!VARIABLE_NAME.test(v.name)) {
      throw new MathSpecError(`variable name "${v.name}" must be lowercase letters, digits or _ and start with a letter`)
    }
    if (RESERVED.has(v.name)) throw new MathSpecError(`"${v.name}" is reserved; rename that variable`)
    if (names.has(v.name)) throw new MathSpecError(`variable "${v.name}" is declared twice`)
    names.add(v.name)
    if (![v.min, v.max, v.step].every(Number.isFinite) || v.step <= 0) {
      throw new MathSpecError(`variable ${v.name} needs finite min and max and a positive step`)
    }
    if (v.max <= v.min) throw new MathSpecError(`variable ${v.name}: max must be greater than min`)
    const choices = choiceCount(v)
    if (choices < 2) throw new MathSpecError(`variable ${v.name} has only one possible value; widen its range or shrink its step`)
    if (choices > 1_000_000) throw new MathSpecError(`variable ${v.name} has too many possible values; use a larger step`)
  }
  return names
}

function parseOrThrow(source: string, names: Set<string>, label: string, allowComparison = false): Node {
  try {
    return parse(source, { names, allowComparison })
  } catch (error) {
    if (error instanceof ExprError) throw new MathSpecError(`${label} "${source}": ${error.message}`)
    throw error
  }
}

interface TemplatePart {
  text: string
  node?: Node
  source?: string
}

function parseTemplate(template: string, names: Set<string>, label: string): TemplatePart[] {
  const parts: TemplatePart[] = []
  let last = 0
  for (const match of template.matchAll(PLACEHOLDER)) {
    parts.push({ text: template.slice(last, match.index) })
    const source = match[1].trim()
    parts.push({ text: '', node: parseOrThrow(source, names, `${label} placeholder {{${source}}}`), source })
    last = match.index + match[0].length
  }
  parts.push({ text: template.slice(last) })
  if (parts.some((part) => !part.node && /\{\{|\}\}/.test(part.text))) {
    throw new MathSpecError(`${label} has a malformed placeholder; write values as {{name}} or {{expression}}`)
  }
  return parts
}

function render(parts: TemplatePart[], values: Record<string, number>, label: string, where: string, exactAnswer = false): string {
  return parts
    .map((part) => {
      if (!part.node) return part.text
      const value = evaluate(part.node, values)
      if (!Number.isFinite(value)) {
        throw new MathSpecError(`${label} placeholder {{${part.source}}} is not a number when ${where}`)
      }
      const exact = part.node.kind === 'var' && (part.node.name !== 'answer' || exactAnswer)
      return exact ? formatNumber(value) : formatComputed(value)
    })
    .join('')
}

// ---------------------------------------------------------------- sampling

function draw(variables: MathVariable[], constraints: Node[], seed: number): Record<string, number> {
  const random = mulberry32(seed)
  for (let attempt = 0; attempt < ATTEMPTS_PER_SEED; attempt++) {
    const values: Record<string, number> = {}
    for (const v of variables) {
      const k = Math.floor(random() * choiceCount(v))
      values[v.name] = Number((v.min + k * v.step).toPrecision(12))
    }
    if (constraints.every((constraint) => evaluate(constraint, values) === 1)) return values
  }
  throw new MathSpecError('the constraints are almost never met with these variable ranges; loosen the constraints or change the ranges')
}

function choiceCount(v: MathVariable): number {
  return Math.floor((v.max - v.min) / v.step + 1e-9) + 1
}

// Small, fast, seedable PRNG: the same spec always yields the same versions,
// so a re-export is byte-identical.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------- helpers

function describe(values: Record<string, number>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${formatNumber(value)}`)
    .join(', ')
}

function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5
}

function hasFewDecimals(value: number): boolean {
  const scaled = value * 1e4
  return Math.abs(scaled - Math.round(scaled)) < 1e-6 * Math.max(1, Math.abs(scaled))
}

function closeTo(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
}
