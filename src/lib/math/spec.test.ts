import { describe, expect, it } from 'vitest'
import { compileMath, type MathSpec } from './spec'

const speed: MathSpec = {
  stem: 'A car travels {{d}} km in {{t}} hours. What is its average speed?',
  explanation: 'Speed is distance over time: {{d}} km / {{t}} h = {{answer}} km/h, or {{d/t/3.6}} m/s.',
  variables: [
    { name: 'd', min: 20, max: 200, step: 5 },
    { name: 't', min: 1, max: 8, step: 0.5 },
  ],
  constraints: [],
  answer_formula: 'd / t',
  tolerance_percent: 1,
  units: 'km/h',
}

const spec = (patch: Partial<MathSpec>): MathSpec => ({ ...speed, ...patch })

describe('compileMath', () => {
  it('computes every version from the formula and fills in the templates', () => {
    const { variants } = compileMath(speed)
    expect(variants).toHaveLength(5)
    for (const variant of variants) {
      const { d, t } = variant.values
      expect(variant.answer).toBeCloseTo(d / t, 4)
      expect(variant.margin).toBeCloseTo(Math.abs(d / t) * 0.01, 4)
      expect(variant.stem).toBe(`A car travels ${d} km in ${t} hours. What is its average speed?`)
      expect(variant.explanation).toContain(`${d} km / ${t} h = `)
    }
    expect(new Set(variants.map((v) => v.stem)).size).toBe(5)
  })

  it('is deterministic, so re-exports are byte-identical', () => {
    expect(compileMath(speed)).toEqual(compileMath(speed))
  })

  it('keeps sampled values on the step grid without float noise', () => {
    const { variants } = compileMath(spec({ variables: [{ name: 'd', min: 0.1, max: 2, step: 0.1 }, speed.variables[1]] }), 10)
    for (const variant of variants) {
      expect(String(variant.values.d)).toMatch(/^\d(\.\d)?$/)
      expect(variant.stem).not.toMatch(/0000|9999/)
    }
  })

  it('prints exact values for variables and four significant figures for computed values', () => {
    const { variants } = compileMath(
      spec({
        variables: [
          { name: 'd', min: 100, max: 1000, step: 100 },
          { name: 't', min: 3, max: 9, step: 3 },
        ],
      }),
    )
    for (const { values, explanation } of variants) {
      const { d, t } = values
      const sig4 = (x: number) => String(Number(x.toPrecision(4)))
      expect(explanation).toBe(`Speed is distance over time: ${d} km / ${t} h = ${sig4(d / t)} km/h, or ${sig4(d / t / 3.6)} m/s.`)
    }
  })

  it('applies constraints to every version', () => {
    const { variants } = compileMath(
      spec({
        stem: 'Subtract {{b}} from {{a}}.',
        variables: [
          { name: 'a', min: 1, max: 20, step: 1 },
          { name: 'b', min: 1, max: 20, step: 1 },
        ],
        constraints: ['a > b'],
        answer_formula: 'a - b',
        tolerance_percent: 0,
        explanation: '{{a}} - {{b}} = {{answer}}',
      }),
      10,
    )
    expect(variants.every((v) => v.values.a > v.values.b)).toBe(true)
  })

  it('rounds inexact answers to six significant figures for the answer key', () => {
    const { variants } = compileMath(
      spec({
        variables: [
          { name: 'd', min: 10, max: 100, step: 1 },
          { name: 't', min: 3, max: 7, step: 4 },
        ],
      }),
      10,
    )
    for (const { values, answer } of variants) expect(answer).toBe(Number((values.d / values.t).toPrecision(6)))
    expect(variants.some(({ values, answer }) => answer !== values.d / values.t)).toBe(true)
  })

  describe('rejects specs that would make bad questions', () => {
    const rejects = (patch: Partial<MathSpec>, message: string | RegExp, versions?: number) =>
      expect(() => compileMath(spec(patch), versions)).toThrow(message)

    it('division by zero and other non-numbers', () => {
      rejects({ variables: [speed.variables[0], { name: 't', min: 0, max: 2, step: 1 }] }, /not a number when .*t=0/)
      rejects({ answer_formula: 'sqrt(t - 5)' }, 'not a number')
    })

    it('answers that never change or are zero', () => {
      rejects({ answer_formula: 'd / d' }, 'for every set of numbers')
      rejects({ answer_formula: 'd - d + t - t + d * 0' }, 'the answer is 0')
    })

    it('a stem that hides a variable or shows the answer', () => {
      rejects({ stem: 'A car travels {{d}} km. How fast is it?' }, 'missing: {{t}}')
      rejects({ stem: 'A car goes {{d}} km in {{t}} h, i.e. {{d/t}} km/h. Speed?' }, 'gives the answer away')
      rejects({ stem: 'Travels {{d}} km in {{t}} h at {{answer}}.' }, 'must not show {{answer}}')
    })

    it('malformed templates and formulas', () => {
      rejects({ stem: 'A car travels {{d km in {{t}} hours.' }, 'malformed placeholder')
      rejects({ stem: 'A car travels {{dist}} km in {{t}} hours.' }, 'unknown name "dist"')
      rejects({ answer_formula: '2d / t' }, 'write multiplication explicitly')
      rejects({ answer_formula: '42' }, 'must use at least one variable')
      rejects({ constraints: ['d + t'] }, 'must be a comparison')
    })

    it('bad variables', () => {
      rejects({ variables: [{ name: 'e', min: 1, max: 2, step: 1 }] }, '"e" is reserved')
      rejects({ variables: [{ name: 'answer', min: 1, max: 2, step: 1 }] }, '"answer" is reserved')
      rejects({ variables: [{ name: 'd', min: 1, max: 2, step: 1 }, { name: 'd', min: 1, max: 2, step: 1 }] }, 'declared twice')
      rejects({ variables: [{ name: 'Speed', min: 1, max: 2, step: 1 }] }, 'lowercase')
      rejects({ variables: [speed.variables[0], { name: 't', min: 5, max: 1, step: 1 }] }, 'max must be greater than min')
      rejects({ variables: [speed.variables[0], { name: 't', min: 1, max: 1.5, step: 1 }] }, 'only one possible value')
      rejects({ variables: [speed.variables[0], { name: 't', min: 0, max: 1e9, step: 1 }] }, 'too many possible values')
    })

    it('constraints that can almost never be met', () => {
      rejects({ constraints: ['d > 1000'] }, 'almost never met')
    })

    it('too few distinct versions', () => {
      rejects(
        {
          variables: [
            { name: 'd', min: 10, max: 20, step: 10 },
            { name: 't', min: 1, max: 2, step: 1 },
          ],
        },
        'only 4 different versions can be made, 5 are needed',
      )
    })

    it('tolerances ADAPT cannot grade', () => {
      rejects({ tolerance_percent: 0 }, 'must be exact')
      rejects({ tolerance_percent: 0.05 }, 'must be 0 or between 0.1 and 5')
      rejects({ tolerance_percent: 8 }, 'must be 0 or between 0.1 and 5')
      rejects({ answer_formula: 'd / t / 100000' }, 'too small for a ±1% margin')
    })
  })
})
