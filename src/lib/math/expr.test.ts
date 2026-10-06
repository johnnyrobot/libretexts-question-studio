import { describe, expect, it } from 'vitest'
import { evaluate, parse, toTex, variablesIn } from './expr'

const names = new Set(['a', 'b', 'x', 'v0', 'v_max', 'mass', 'theta', 'theta2', 'mu_k'])
const run = (source: string, values: Record<string, number> = {}) => evaluate(parse(source, { names }), values)
const fails = (source: string, allowComparison = false) => () => parse(source, { names, allowComparison })

describe('expression parser', () => {
  it('follows the usual precedence', () => {
    expect(run('1 + 2 * 3')).toBe(7)
    expect(run('(1 + 2) * 3')).toBe(9)
    expect(run('2 ^ 3 ^ 2')).toBe(512)
    expect(run('-x^2', { x: 3 })).toBe(-9)
    expect(run('2^-1')).toBe(0.5)
    expect(run('10 / 4 / 5')).toBe(0.5)
    expect(run('a - b - 1', { a: 10, b: 3 })).toBe(6)
  })

  it('accepts ** for powers and scientific notation', () => {
    expect(run('x ** 2', { x: 4 })).toBe(16)
    expect(run('6.02e3 / 2')).toBe(3010)
  })

  it('evaluates the whitelisted functions and constants', () => {
    expect(run('sqrt(16) + abs(-2)')).toBe(6)
    expect(run('ln(e)')).toBe(1)
    expect(run('log10(1000)')).toBe(3)
    expect(run('sind(30)')).toBeCloseTo(0.5)
    expect(run('cos(pi)')).toBeCloseTo(-1)
    expect(run('max(1, 5, 3) - min(4, 2)')).toBe(3)
    expect(run('round(2.6) + floor(2.6) + ceil(2.1)')).toBe(8)
  })

  it('evaluates comparisons in constraints, tolerating float noise', () => {
    const holds = (source: string, values: Record<string, number>) =>
      evaluate(parse(source, { names, allowComparison: true }), values)
    expect(holds('a < b', { a: 1, b: 2 })).toBe(1)
    expect(holds('a + b == 0.3', { a: 0.1, b: 0.2 })).toBe(1)
    expect(holds('a != b', { a: 2, b: 2 })).toBe(0)
    expect(holds('a >= b', { a: 2, b: 2 })).toBe(1)
  })

  it('rejects anything outside the language with a message a model can act on', () => {
    expect(fails('2x')).toThrow('write multiplication explicitly')
    expect(fails('2(x+1)')).toThrow('write multiplication explicitly')
    expect(fails('log(x)')).toThrow('use ln (natural log) or log10')
    expect(fails('y + 1')).toThrow('unknown name "y"')
    expect(fails('eval(1)')).toThrow('unknown function "eval"')
    expect(fails('sqrt')).toThrow('sqrt is a function')
    expect(fails('max(1)')).toThrow('at least two arguments')
    expect(fails('sqrt(1, 2)')).toThrow('exactly one argument')
    expect(fails('a < b')).toThrow('belong in constraints only')
    expect(fails('a < b < x', true)).toThrow('one comparison per constraint')
    expect(fails('a = b', true)).toThrow('use == to compare')
    expect(fails('(a + b')).toThrow('expected ")"')
    expect(fails('a +')).toThrow('ends too early')
    expect(fails('a; b')).toThrow('unexpected character ";"')
    expect(fails('constructor')).toThrow('unknown name')
    expect(fails('1+'.repeat(80) + '1')).toThrow('too long')
    expect(fails('('.repeat(20) + '1' + ')'.repeat(20))).toThrow('nested too deeply')
  })

  it('lists the variables an expression uses', () => {
    expect([...variablesIn(parse('a * sqrt(b) + a', { names }))].sort()).toEqual(['a', 'b'])
  })
})

describe('toTex', () => {
  const tex = (source: string) => toTex(parse(source, { names, allowComparison: true }))

  it('writes fractions, powers and functions', () => {
    expect(tex('a / b')).toBe('\\frac{a}{b}')
    expect(tex('(a + b)^2')).toBe('\\left(a + b\\right)^{2}')
    expect(tex('sqrt(x) * 2')).toBe('\\sqrt{x} \\cdot 2')
    expect(tex('sind(x)')).toBe('\\sin\\left(x^\\circ\\right)')
    expect(tex('abs(a)')).toBe('\\left|a\\right|')
    expect(tex('a <= b')).toBe('a \\le b')
    expect(tex('6.02e23')).toBe('6.02 \\times 10^{23}')
  })

  it('brackets only where precedence needs it', () => {
    expect(tex('a - (b - x)')).toBe('a - \\left(b - x\\right)')
    expect(tex('a - b - x')).toBe('a - b - x')
    expect(tex('a * (b + x)')).toBe('a \\cdot \\left(b + x\\right)')
    expect(tex('a - -b')).toBe('a - \\left(-b\\right)')
    expect(tex('(-a)^2')).toBe('\\left(-a\\right)^{2}')
  })

  it('subscripts digits and suffixes in names', () => {
    expect(tex('v0')).toBe('v_{0}')
    expect(tex('v_max')).toBe('v_{\\mathrm{max}}')
    expect(tex('mass')).toBe('\\mathit{mass}')
    expect(tex('theta')).toBe('\\theta')
    expect(tex('theta2')).toBe('\\theta_{2}')
    expect(tex('mu_k')).toBe('\\mu_{\\mathrm{k}}')
  })
})
