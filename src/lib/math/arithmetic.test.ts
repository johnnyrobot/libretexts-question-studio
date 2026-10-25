import { describe, expect, it } from 'vitest'
import { arithmeticProblems } from './arithmetic'

describe('arithmetic check of a numerical explanation', () => {
  it('flags a worked step that does not follow from the one before', () => {
    expect(arithmeticProblems('The force is \\(F = 2.0 \\times 3.5 = 8.0\\) N.', 8, 0)).toEqual([
      { kind: 'step', written: '2.0 * 3.5', value: 7, nextValue: 8 },
    ])
  })

  it('accepts a step rounded to the digits it is written with, and an approximation within 2%', () => {
    expect(arithmeticProblems('\\(a = \\frac{10}{3} = 3.33\\) m/s².', 3.33, 0.01)).toEqual([])
    expect(arithmeticProblems('\\(t = \\frac{100}{7} = 15\\) s.', 15, 0.5)).toHaveLength(1)
    // 9.81 × 1.37 is 13.44: 13.2 is within 2% but not 0.5%.
    expect(arithmeticProblems('\\(W = 9.81 \\times 1.37 \\approx 13.2\\) N.', 13.2, 0.1)).toEqual([])
    expect(arithmeticProblems('\\(W = 9.81 \\times 1.37 = 13.2\\) N.', 13.2, 0.1)).toHaveLength(1)
    // Only a written result is rounded: the last operand of a calculation allows nothing.
    expect(arithmeticProblems('\\(\\frac{10}{3} = 3.0\\)', 3, 0.5)).toEqual([
      { kind: 'step', written: '\\frac{10}{3}', value: 10 / 3, nextValue: 3 },
    ])
    expect(arithmeticProblems('\\(3 \\times 4 = 12.4\\)', 12.4, 0)).toHaveLength(1)
  })

  it('reads LaTeX fractions, mixed numbers, roots, powers, products and units', () => {
    // Each step with its right result, and with twice that, which must be flagged.
    const steps: [(result: string) => string, number][] = [
      [(r) => `\\(\\dfrac{1}{2}(4)(3)^2 = ${r}\\)`, 18],
      [(r) => `\\(2\\frac{1}{2} \\cdot 4 = ${r}\\)`, 10],
      [(r) => `\\(\\sqrt{16} + 1 = ${r}\\)`, 5],
      [(r) => `\\(T = 2\\sqrt{2.25}(4) = ${r}\\)`, 12],
      [(r) => `\\(F = 4(9.86) = ${r}\\)`, 39.44],
      [(r) => `\\(v = 12\\,\\text{m/s} \\div 4 = ${r}\\,\\text{m/s}\\)`, 3],
      [(r) => `\\(1{,}200 \\times 2 = ${r.replace(/(?<=\d)(?=\d{3}$)/, ',')}\\)`, 2400],
      [(r) => `The total is 3 × 4 = ${r} grams.`, 12],
    ]
    for (const [step, result] of steps) {
      expect(arithmeticProblems(step(String(result)), result, 0), step(String(result))).toEqual([])
      expect(arithmeticProblems(step(String(2 * result)), 2 * result, 0), step(String(2 * result))).toEqual([
        expect.objectContaining({ kind: 'step', value: expect.closeTo(result), nextValue: 2 * result }),
      ])
    }
    expect(arithmeticProblems('\\(\\dfrac{1}{2}(4)(3)^2 = 36\\)', 36, 0)).toEqual([
      { kind: 'step', written: '\\dfrac{1}{2}(4)(3)^2', value: 18, nextValue: 36 },
    ])
  })

  it('leaves alone sides that are not pure arithmetic', () => {
    expect(arithmeticProblems('\\(F = ma = m \\cdot 9.8\\), so \\(50\\% = 0.5\\).', 0.5, 0)).toEqual([])
  })

  it('flags a key the explanation never arrives at, within the tolerance or half a unit of its last digit', () => {
    const explanation = '\\(d = 4.0 \\times 3.0 = 12\\) m.'
    expect(arithmeticProblems(explanation, 12, 0)).toEqual([])
    expect(arithmeticProblems(explanation, 12.05, 0)).toEqual([])
    expect(arithmeticProblems(explanation, 13, 0.5)).toEqual([{ kind: 'key', key: 13 }])
    expect(arithmeticProblems(explanation, 13, 1)).toEqual([])
    expect(arithmeticProblems('Six molecules of oxygen are released.', 6, 0)).toEqual([])
    expect(arithmeticProblems('\\(x = 0.0042\\)', 0.0042, 0)).toEqual([])
    expect(arithmeticProblems('\\(x = 0.0042\\)', 0.0047, 0)).toEqual([{ kind: 'key', key: 0.0047 }])
    // A key JavaScript writes with an exponent still gets the rounding of its last digit, not 0.5.
    expect(arithmeticProblems('\\(x = 3 \\times 10^{-7}\\)', 3e-7, 0)).toEqual([])
    expect(arithmeticProblems('\\(x = 3 \\times 10^{-7}\\)', 5e-7, 0)).toEqual([{ kind: 'key', key: 5e-7 }])
  })
})
