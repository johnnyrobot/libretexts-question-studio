// Recomputes the arithmetic a numerical question's explanation shows, ported
// from the check that screened the fine-tuning data.
//
// Every chain "A = B = C" (also \approx, ≈, \simeq), in the explanation's math
// or in a plain-text clause, is split. Each side that is pure arithmetic once
// units and LaTeX are stripped (\frac, \times, \cdot, \div, ^, \sqrt, mixed
// numbers like 2\frac{1}{2}, implicit products like 4(9.86) or 2\sqrt{3}) is
// evaluated, and neighbouring sides must agree when either is a calculation.
// The allowed gap is the rounding of the side written with fewer digits (half a
// unit in its last digit) plus 0.5%, or 2% after \approx.
//
// The key must also appear as a result: some evaluated side, or a number the
// explanation writes, within the question's tolerance (at least 0.5%, or the
// rounding of a key below 1).
import { evaluate, parse } from './expr'

export type ArithmeticProblem =
  // A step written as nextValue, though the side before it, written, is value.
  | { kind: 'step'; written: string; value: number; nextValue: number }
  // A key the explanation never arrives at.
  | { kind: 'key'; key: number }

export function arithmeticProblems(explanation: string, key: number, tolerance: number): ArithmeticProblem[] {
  const { problems, values } = chainProblems(explanation)
  const allowed = Math.max(tolerance, 0.005 * Math.abs(key), keyRounding(key))
  if (![...values, ...numbersIn(explanation)].some((x) => Math.abs(x - key) <= allowed + 1e-12)) {
    problems.push({ kind: 'key', key })
  }
  return problems
}

const MATH_SEGMENT = /\\\((.*?)\\\)|\\\[(.*?)\\\]|\$\$(.*?)\$\$|\$(.*?)\$/gs
const RELATION = /(=|\\approx|≈|\\simeq)/
const THOUSANDS = /(?<=\d),(?=\d{3}\b)/g

interface Side {
  text: string
  value: number
  expression: string
  // Whether the relation after this side is \approx or the like, not =.
  approximate: boolean
}

function chainProblems(text: string): { problems: ArithmeticProblem[]; values: number[] } {
  const problems: ArithmeticProblem[] = []
  const values: number[] = []
  for (const piece of pieces(text)) {
    const parts = piece.split(RELATION)
    const sides = parts.filter((_, k) => k % 2 === 0)
    const relations = parts.filter((_, k) => k % 2 === 1)
    let previous: Side | undefined
    sides.forEach((raw, k) => {
      const side = trim(raw, k === 0, k === sides.length - 1)
      const read = valueOf(side)
      if (!read) {
        previous = undefined
        return
      }
      values.push(read.value)
      if (previous && (isCalculation(read.expression) || isCalculation(previous.expression))) {
        const gap =
          Math.max(halfUnit(side), halfUnit(previous.text)) +
          (previous.approximate ? 0.02 : 0.005) * Math.max(Math.abs(read.value), Math.abs(previous.value))
        if (Math.abs(read.value - previous.value) > gap + 1e-12) {
          problems.push({ kind: 'step', written: previous.text.trim(), value: previous.value, nextValue: read.value })
        }
      }
      previous = { text: side, ...read, approximate: k < relations.length && relations[k] !== '=' }
    })
  }
  return { problems, values }
}

// The math segments, then the plain text between them cut at clause breaks.
function pieces(text: string): string[] {
  const math = [...text.matchAll(MATH_SEGMENT)].map((m) => m.slice(1).find((g) => g !== undefined) ?? '')
  const plain = text.replace(MATH_SEGMENT, ' ; ').replace(THOUSANDS, '')
  return [...math, ...plain.split(/[;:\n]|,\s|\.\s|\.$/).filter((p) => RELATION.test(p))]
}

// Leading words (first side) and trailing units (last side) are not arithmetic.
function trim(side: string, first: boolean, last: boolean): string {
  let s = side
    .replace(/\\(?:text|mathrm|textrm)\{[^{}]*\}(?:\^\{[^{}]*\}|\^-?\d)?/g, ' ')
    .replace(/\\times|\\cdot/g, '*')
    .replace(/\\div/g, '/')
    .replace(/\\mu\b|\\Omega\b|\^\\circ|\\circ|°/g, ' ')
  if (last) s = s.replace(/(?:\s+[A-Za-z][\w/^·.%-]*)+\s*\.?\s*$/, '')
  if (first) {
    const start = /(?:^|(?<=[A-Za-z]{2}\s))(-?(?:sqrt|\\sqrt|\\[dt]?frac|[\d(]).*)$/.exec(s)
    if (start && !/[A-Za-z]/.test(start[1].replace(/sqrt|\\sqrt|\\[dt]?frac/g, ''))) s = start[1]
  }
  return s
}

function valueOf(side: string): { value: number; expression: string } | undefined {
  try {
    const expression = toExpression(side)
    const value = evaluate(parse(expression, { names: NO_NAMES }), {})
    return Number.isFinite(value) ? { value, expression } : undefined
  } catch {
    return undefined
  }
}

const NO_NAMES: ReadonlySet<string> = new Set()

class NotArithmetic extends Error {}

// LaTeX to the formula syntax of ./expr, or NotArithmetic.
function toExpression(latex: string): string {
  const s = latex
    .trim()
    .replace(/\\(?:text|mathrm|operatorname|textrm|mathit)\{[^{}]*\}/g, ' ')
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, '')
    .replace(/\\[,;:!]|\\quad|\\qquad|~/g, ' ')
    .replace(/\\times|\\cdot|×|·/g, '*')
    .replace(/\\div|÷/g, '/')
    .replace(/−/g, '-')
    .replace(/\\?%/g, ' PCT ')
    .replace(THOUSANDS, '')
    .replace(/(?<=\d)\{,\}(?=\d)/g, '')
    .replace(/\\[dt]frac/g, '\\frac')
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s.startsWith('\\frac', i)) {
      const [numerator, j] = braced(s, i + 5)
      const [denominator, k] = braced(s, j)
      const fraction = `((${toExpression(numerator)})/(${toExpression(denominator)}))`
      // A number right before a fraction makes a mixed number: 2\frac{1}{2} is 2.5.
      const whole = /(\d+(?:\.\d+)?)\s*$/.exec(out)
      out = whole ? `${out.slice(0, whole.index)}(${whole[1]}+${fraction})` : out + fraction
      i = k
    } else if (s.startsWith('\\sqrt', i)) {
      const [radicand, j] = braced(s, i + 5)
      out += `sqrt(${toExpression(radicand)})`
      i = j
    } else {
      out += s[i++]
    }
  }
  let expression = out.replace(/\{/g, '(').replace(/\}/g, ')')
  if (expression.includes('PCT') || expression.includes('\\') || /[A-Za-z]/.test(expression.replace(/sqrt/g, ''))) {
    throw new NotArithmetic('not pure arithmetic')
  }
  expression = expression
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\)\s*\(/g, ')*(')
    .replace(/(\d)\s*\(/g, '$1*(')
    .replace(/\)\s*(\d)/g, ')*$1')
    .replace(/([\d)])\s*sqrt/g, '$1*sqrt')
  // Digits grouped with spaces ("1 000") are one number.
  if (/^[\d\s.]+$/.test(expression)) expression = expression.replace(/(?<=\d)\s+(?=\d)/g, '')
  if (!/\d/.test(expression) || /\d\s+\d/.test(expression)) throw new NotArithmetic('not one expression')
  return expression
}

// s[i], after any spaces, is "{": its content and the index after its "}".
function braced(s: string, i: number): [string, number] {
  while (s[i] === ' ') i++
  if (s[i] !== '{') throw new NotArithmetic('expected {')
  let depth = 0
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') depth++
    else if (s[j] === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1]
  }
  throw new NotArithmetic('unbalanced braces')
}

function isCalculation(expression: string): boolean {
  return /(?<=[\d)])\s*[-+*/^]|sqrt/.test(expression)
}

// Half a unit in the last written digit of the side's last number.
function halfUnit(side: string): number {
  const last = [...side.replace(/,/g, '').matchAll(/\d+(?:\.(\d+))?/g)].at(-1)
  if (!last) return 0
  return last[1] ? 0.5 * 10 ** -last[1].length : 0.5
}

// Half a unit in the last digit of a key below 1 (0.0047 → 0.00005), also when
// it is written with an exponent (1.5e-7 → 0.000000005).
function keyRounding(key: number): number {
  if (Math.abs(key) >= 1 || Number.isInteger(key)) return 0
  const [mantissa, exponent = '0'] = String(key).split('e')
  return 0.5 * 10 ** -((mantissa.split('.')[1] ?? '').length - Number(exponent))
}

const NUMBER_WORDS = 'zero one two three four five six seven eight nine ten eleven twelve'.split(' ')

function numbersIn(text: string): number[] {
  const numerals = text
    .replace(/[–—−](?=\d)/g, '-')
    .match(/(?<![\w.])-?\d[\d,]*(?:\.\d+)?(?:[eE]-?\d+)?/g)
  const words = text.toLowerCase().match(/[a-z]+/g) ?? []
  return [
    ...(numerals ?? []).map((n) => Number(n.replace(/,/g, ''))),
    ...words.map((w) => NUMBER_WORDS.indexOf(w)).filter((n) => n >= 0),
  ]
}
