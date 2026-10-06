// A small arithmetic language for math question formulas, parsed by hand so
// model output is never passed to eval(). One syntax tree drives evaluation,
// the TeX shown to instructors, and the checks in spec.ts.
//
//   numbers 2, 0.5, 6.02e3   variables   + - * / ^ (or **)   ( )
//   functions: sqrt abs exp ln log10 sin cos tan asin acos atan (radians),
//              sind cosd tand (degrees), floor ceil round, min max (2+ args)
//   constants: pi, e
//   comparisons (constraints only): < <= > >= == !=

export type Node =
  | { kind: 'num'; value: number; text: string }
  | { kind: 'var'; name: string }
  | { kind: 'const'; name: 'pi' | 'e' }
  | { kind: 'neg'; arg: Node }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '^'; left: Node; right: Node }
  | { kind: 'call'; fn: FunctionName; args: Node[] }
  | { kind: 'cmp'; op: Comparison; left: Node; right: Node }

export type Comparison = '<' | '<=' | '>' | '>=' | '==' | '!='

const UNARY = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sind: (x: number) => Math.sin((x * Math.PI) / 180),
  cosd: (x: number) => Math.cos((x * Math.PI) / 180),
  tand: (x: number) => Math.tan((x * Math.PI) / 180),
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
} as const

const VARIADIC = { min: Math.min, max: Math.max } as const

export type FunctionName = keyof typeof UNARY | keyof typeof VARIADIC

export const FUNCTION_NAMES = [...Object.keys(UNARY), ...Object.keys(VARIADIC)] as FunctionName[]
export const CONSTANT_NAMES = ['pi', 'e'] as const

export const MAX_LENGTH = 1_000
export const MAX_NODES = 128
export const MAX_DEPTH = 16

export class ExprError extends Error {}

type Token =
  | { type: 'num'; value: number; text: string; at: number }
  | { type: 'id'; text: string; at: number }
  | { type: 'op'; text: string; at: number }

const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/
const OPERATOR = /^(?:\*\*|<=|>=|==|!=|[-+*/^(),<>])/

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const rest = source.slice(i)
    const space = /^\s+/.exec(rest)
    if (space) {
      i += space[0].length
      continue
    }
    const number = NUMBER.exec(rest)
    if (number) {
      const next = rest[number[0].length]
      if (next && /[A-Za-z_(]/.test(next)) {
        throw new ExprError(`write multiplication explicitly: "${number[0]}*${next}", not "${number[0]}${next}"`)
      }
      tokens.push({ type: 'num', value: Number(number[0]), text: number[0], at: i })
      i += number[0].length
      continue
    }
    const ident = IDENT.exec(rest)
    if (ident) {
      tokens.push({ type: 'id', text: ident[0], at: i })
      i += ident[0].length
      continue
    }
    const op = OPERATOR.exec(rest)
    if (op) {
      tokens.push({ type: 'op', text: op[0] === '**' ? '^' : op[0], at: i })
      i += op[0].length
      continue
    }
    if (rest[0] === '=') throw new ExprError('use == to compare, not =')
    throw new ExprError(`unexpected character "${rest[0]}"`)
  }
  return tokens
}

export interface ParseOptions {
  // Names the expression may reference.
  names: ReadonlySet<string>
  allowComparison?: boolean
}

export function parse(source: string, options: ParseOptions): Node {
  if (source.length > MAX_LENGTH) throw new ExprError(`the expression is too long (over ${MAX_LENGTH} characters)`)
  const tokens = tokenize(source)
  if (tokens.length === 0) throw new ExprError('the expression is empty')
  let pos = 0
  // Brackets and calls nest the recursive descent; capping them keeps a
  // hostile "((((…" from overflowing the stack.
  let nesting = 0
  const enter = () => {
    if (++nesting > MAX_DEPTH) throw new ExprError(`the expression is nested too deeply (over ${MAX_DEPTH} levels)`)
  }
  const peek = () => tokens[pos]
  const isOp = (text: string) => peek()?.type === 'op' && peek().text === text
  const expectOp = (text: string) => {
    if (!isOp(text)) throw new ExprError(`expected "${text}"${peek() ? ` before "${peek().text}"` : ' at the end'}`)
    pos++
  }

  // comparison := additive (cmp additive)?
  const comparison = (): Node => {
    const left = additive()
    const token = peek()
    if (token?.type === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(token.text)) {
      if (!options.allowComparison) throw new ExprError(`comparisons like "${token.text}" belong in constraints only`)
      pos++
      const right = additive()
      if (peek()?.type === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(peek().text)) {
        throw new ExprError('write one comparison per constraint, e.g. "a < b" and "b < c" as two constraints')
      }
      return { kind: 'cmp', op: token.text as Comparison, left, right }
    }
    return left
  }

  const additive = (): Node => {
    let node = multiplicative()
    while (isOp('+') || isOp('-')) {
      const op = tokens[pos++].text as '+' | '-'
      node = { kind: 'bin', op, left: node, right: multiplicative() }
    }
    return node
  }

  const multiplicative = (): Node => {
    let node = unary()
    while (isOp('*') || isOp('/')) {
      const op = tokens[pos++].text as '*' | '/'
      node = { kind: 'bin', op, left: node, right: unary() }
    }
    return node
  }

  // Unary minus binds looser than ^, so -x^2 is -(x^2).
  const unary = (): Node => {
    if (isOp('-')) {
      pos++
      return { kind: 'neg', arg: unary() }
    }
    if (isOp('+')) {
      pos++
      return unary()
    }
    return power()
  }

  // ^ is right-associative; its exponent may carry its own sign (2^-1).
  const power = (): Node => {
    const base = primary()
    if (isOp('^')) {
      pos++
      return { kind: 'bin', op: '^', left: base, right: unary() }
    }
    return base
  }

  const primary = (): Node => {
    const token = peek()
    if (!token) throw new ExprError('the expression ends too early')
    if (token.type === 'num') {
      pos++
      return { kind: 'num', value: token.value, text: token.text }
    }
    if (token.type === 'op' && token.text === '(') {
      pos++
      enter()
      const inner = additive()
      expectOp(')')
      nesting--
      return inner
    }
    if (token.type === 'id') {
      pos++
      const name = token.text
      if (isOp('(')) {
        pos++
        if (!(FUNCTION_NAMES as string[]).includes(name)) {
          if (name === 'log') throw new ExprError('log is ambiguous: use ln (natural log) or log10')
          throw new ExprError(`unknown function "${name}"; allowed: ${FUNCTION_NAMES.join(', ')}`)
        }
        enter()
        const args = [additive()]
        while (isOp(',')) {
          pos++
          args.push(additive())
        }
        expectOp(')')
        nesting--
        const fn = name as FunctionName
        if (fn in VARIADIC ? args.length < 2 : args.length !== 1) {
          throw new ExprError(fn in VARIADIC ? `${fn}() needs at least two arguments` : `${fn}() takes exactly one argument`)
        }
        return { kind: 'call', fn, args }
      }
      if (name === 'pi' || name === 'e') return { kind: 'const', name }
      if (!options.names.has(name)) {
        if ((FUNCTION_NAMES as string[]).includes(name)) throw new ExprError(`${name} is a function: write ${name}(...)`)
        throw new ExprError(`unknown name "${name}"${options.names.size ? `; available: ${[...options.names].join(', ')}` : ''}`)
      }
      return { kind: 'var', name }
    }
    throw new ExprError(`unexpected "${token.text}"`)
  }

  const node = comparison()
  if (pos < tokens.length) throw new ExprError(`unexpected "${tokens[pos].text}"`)
  if (count(node) > MAX_NODES) throw new ExprError(`the expression is too long (over ${MAX_NODES} parts)`)
  if (depth(node) > MAX_DEPTH) throw new ExprError(`the expression is nested too deeply (over ${MAX_DEPTH} levels)`)
  return node
}

export function evaluate(node: Node, values: Readonly<Record<string, number>>): number {
  switch (node.kind) {
    case 'num':
      return node.value
    case 'var': {
      const value = values[node.name]
      if (value === undefined) throw new ExprError(`no value for "${node.name}"`)
      return value
    }
    case 'const':
      return node.name === 'pi' ? Math.PI : Math.E
    case 'neg':
      return -evaluate(node.arg, values)
    case 'bin': {
      const a = evaluate(node.left, values)
      const b = evaluate(node.right, values)
      switch (node.op) {
        case '+':
          return a + b
        case '-':
          return a - b
        case '*':
          return a * b
        case '/':
          return a / b
        case '^':
          return a ** b
      }
      break
    }
    case 'call': {
      const args = node.args.map((arg) => evaluate(arg, values))
      return node.fn in VARIADIC
        ? VARIADIC[node.fn as keyof typeof VARIADIC](...args)
        : UNARY[node.fn as keyof typeof UNARY](args[0])
    }
    case 'cmp': {
      const a = evaluate(node.left, values)
      const b = evaluate(node.right, values)
      const close = Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
      switch (node.op) {
        case '<':
          return a < b && !close ? 1 : 0
        case '<=':
          return a < b || close ? 1 : 0
        case '>':
          return a > b && !close ? 1 : 0
        case '>=':
          return a > b || close ? 1 : 0
        case '==':
          return close ? 1 : 0
        case '!=':
          return close ? 0 : 1
      }
    }
  }
  throw new ExprError('unsupported expression')
}

export function variablesIn(node: Node, into = new Set<string>()): Set<string> {
  if (node.kind === 'var') into.add(node.name)
  for (const child of children(node)) variablesIn(child, into)
  return into
}

// ------------------------------------------------------------------ TeX

const PRECEDENCE = { cmp: 0, '+': 1, '-': 1, '*': 2, '/': 2, neg: 3, '^': 4, atom: 5 } as const

const TEX_FUNCTION: Record<FunctionName, string> = {
  sqrt: '\\sqrt',
  abs: '',
  exp: '\\exp',
  ln: '\\ln',
  log10: '\\log_{10}',
  sin: '\\sin',
  cos: '\\cos',
  tan: '\\tan',
  asin: '\\arcsin',
  acos: '\\arccos',
  atan: '\\arctan',
  sind: '\\sin',
  cosd: '\\cos',
  tand: '\\tan',
  floor: '',
  ceil: '',
  round: '\\operatorname{round}',
  min: '\\min',
  max: '\\max',
}

const DEGREE_FUNCTIONS = new Set<FunctionName>(['sind', 'cosd', 'tand'])

const TEX_CMP: Record<Comparison, string> = { '<': '<', '<=': '\\le', '>': '>', '>=': '\\ge', '==': '=', '!=': '\\ne' }

export function toTex(node: Node): string {
  switch (node.kind) {
    case 'num':
      return node.text.replace(/[eE]([+-]?\d+)$/, (_, exp: string) => ` \\times 10^{${Number(exp)}}`)
    case 'var':
      return texName(node.name)
    case 'const':
      return node.name === 'pi' ? '\\pi' : 'e'
    case 'neg':
      return `-${wrap(node.arg, PRECEDENCE.neg)}`
    case 'cmp':
      return `${toTex(node.left)} ${TEX_CMP[node.op]} ${toTex(node.right)}`
    case 'bin':
      switch (node.op) {
        case '+':
          return `${wrap(node.left, 1)} + ${wrap(node.right, 1, true)}`
        case '-':
          return `${wrap(node.left, 1)} - ${wrap(node.right, 2, true)}`
        case '*':
          return `${wrap(node.left, 2)} \\cdot ${wrap(node.right, 3, true)}`
        case '/':
          return `\\frac{${toTex(node.left)}}{${toTex(node.right)}}`
        case '^':
          return `${wrap(node.left, PRECEDENCE.atom)}^{${toTex(node.right)}}`
      }
      break
    case 'call': {
      const args = node.args.map(toTex)
      const degrees = DEGREE_FUNCTIONS.has(node.fn) ? '^\\circ' : ''
      switch (node.fn) {
        case 'sqrt':
          return `\\sqrt{${args[0]}}`
        case 'abs':
          return `\\left|${args[0]}\\right|`
        case 'floor':
          return `\\left\\lfloor ${args[0]}\\right\\rfloor`
        case 'ceil':
          return `\\left\\lceil ${args[0]}\\right\\rceil`
        default:
          return `${TEX_FUNCTION[node.fn]}\\left(${args.join(', ')}${degrees}\\right)`
      }
    }
  }
  return ''
}

// A right operand that starts with a minus sign is bracketed: a - (-b).
function wrap(node: Node, minimum: number, rightOperand = false): string {
  const tex = toTex(node)
  return precedence(node) < minimum || (rightOperand && node.kind === 'neg') ? `\\left(${tex}\\right)` : tex
}

function precedence(node: Node): number {
  if (node.kind === 'bin') return node.op === '/' ? PRECEDENCE.atom : PRECEDENCE[node.op]
  if (node.kind === 'neg') return PRECEDENCE.neg
  if (node.kind === 'cmp') return PRECEDENCE.cmp
  return PRECEDENCE.atom
}

const GREEK = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'kappa', 'lambda', 'mu', 'nu', 'xi',
  'rho', 'sigma', 'tau', 'phi', 'chi', 'psi', 'omega',
])

// v0 -> v_{0}, v_max -> v_{\mathrm{max}}, theta1 -> \theta_{1}, mass -> \mathit{mass}.
function texName(name: string): string {
  const [head, ...rest] = name.split('_')
  const sub = rest.join('\\_')
  const digits = /^([a-z]+?)(\d+)$/.exec(head)
  const letter = (word: string) => (GREEK.has(word) ? `\\${word}` : word.length > 1 ? `\\mathit{${word}}` : word)
  const base = digits ? `${letter(digits[1])}_{${digits[2]}}` : letter(head)
  if (!sub) return base
  return digits ? `${letter(digits[1])}_{${digits[2]},\\mathrm{${sub}}}` : `${base}_{\\mathrm{${sub}}}`
}

// ---------------------------------------------------------------- helpers

function children(node: Node): Node[] {
  switch (node.kind) {
    case 'neg':
      return [node.arg]
    case 'bin':
    case 'cmp':
      return [node.left, node.right]
    case 'call':
      return node.args
    default:
      return []
  }
}

function count(node: Node): number {
  return 1 + children(node).reduce((sum, child) => sum + count(child), 0)
}

function depth(node: Node): number {
  return 1 + Math.max(0, ...children(node).map(depth))
}
