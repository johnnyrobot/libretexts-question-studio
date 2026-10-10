import { describe, expect, it } from 'vitest'
import { SAMPLE_DRAFTS } from '../qti/fixtures'
import { evaluate, parse } from '../math/expr'
import { checkSymbols, ITEM_TYPES, llmSchemaFor, parseDraft, repairFormula, type DraftOf } from './schema'

describe('LLM schemas', () => {
  it('can be built for every item type, closed to extra properties', () => {
    for (const type of ITEM_TYPES) {
      const schema = llmSchemaFor(type) as { additionalProperties?: boolean }
      expect(schema.additionalProperties).toBe(false)
    }
  })

  it('show units as a string or null and normalise "none" to null', () => {
    const properties = (llmSchemaFor('numerical') as { properties: Record<string, unknown> }).properties
    expect(properties.units).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] })
    const { item_type, ...payload } = SAMPLE_DRAFTS.find((d) => d.item_type === 'numerical')!
    const units = (value: string) => (parseDraft(item_type, { ...payload, units: value }) as DraftOf<'numerical'>).units
    for (const none of ['None', ' null ', '', 'n/a', '-']) expect(units(none)).toBeNull()
    expect(units(' m/s ')).toBe('m/s')
  })

  it('drop lower-only number bounds, which stop WebLLM writing values between 0 and 1', () => {
    const math = llmSchemaFor('math') as { properties: Record<string, { items?: { properties: Record<string, unknown> } }> }
    expect(math.properties.variables.items!.properties.step).toEqual({ type: 'number' })
    expect(math.properties.tolerance_percent).toMatchObject({ minimum: 0, maximum: expect.any(Number) })
    const numerical = llmSchemaFor('numerical') as { properties: Record<string, unknown> }
    expect(numerical.properties.tolerance).toEqual({ type: 'number' })
    // Zod still enforces them.
    const { item_type, ...payload } = SAMPLE_DRAFTS.find((d) => d.item_type === 'numerical')!
    expect(() => parseDraft(item_type, { ...payload, tolerance: -1 })).toThrow(/tolerance/)
  })

  it('reads {{name}} placeholders in math formulas as the variables they name', () => {
    const { item_type, ...payload } = SAMPLE_DRAFTS.find((d) => d.item_type === 'math')!
    const draft = parseDraft(item_type, { ...payload, answer_formula: '{{v}} / {{ t }}', constraints: ['{{v}} < {{t}}'] }) as DraftOf<'math'>
    expect(draft.answer_formula).toBe('(v) / (t)')
    expect(draft.constraints).toEqual(['(v) < (t)'])
  })

  it('reads uneven braces the model writes in formulas without changing the grouping', () => {
    // Seen from Qwen3.5 4B; every one means (xf - x0) / t, or (xf - x0) / (tf - t0).
    const names = new Set(['xf', 'x0', 't', 'tf', 't0'])
    const values = { xf: 50, x0: 10, t: 4, tf: 8, t0: 2 }
    const value = (formula: string) => evaluate(parse(repairFormula(formula), { names }), values)
    expect(value('( {{xf} - {{x0}} } / {{t}} )')).toBe(10)
    expect(value('( {xf} - {x0} ) / {t}')).toBe(10)
    expect(value('{xf - x0} / t')).toBe(10)
    expect(value('( {{xf} - {{x0}} ) / ( {{tf} - {{t0}} } )')).toBeCloseTo(40 / 6)
    expect(repairFormula('(xf - x0) / t')).toBe('(xf - x0) / t')
  })
})

describe('checkSymbols', () => {
  it('sends back a stray symbol where the model meant LaTeX, and an escape code written as text', () => {
    // The angstrom sign; the letter Å (U+00C5) is text.
    expect(() => checkSymbols({ stem: 'The weight (\u212B) of an object' }, '')).toThrow('"\u212B" stands where a symbol or formula should be')
    expect(() => checkSymbols({ stem: 'Ångström' }, '')).not.toThrow()
    expect(() => checkSymbols({ explanation: 'a larger acceleration ≈ a) when' }, '')).toThrow('"≈"')
    expect(() => checkSymbols({ choices: [{ text: 'x = x_0 + ← v t' }] }, '')).toThrow('"←"')
    expect(() => checkSymbols({ stem: 'x = x_0 + v_{\\u03b1}t' }, '')).toThrow('"\\u03b1" is an escape code')
  })

  it('keeps LaTeX, plain text, − and ∝, and the symbols of the source', () => {
    const text = 'Find \\(a \\propto F_{net}\\): 2 kg × 9.8 m/s² = 19.6 N — Newton’s “second” law, a ∝ 1/m, −3 °C, θ, v̄ …'
    expect(() => checkSymbols({ stem: text, alternates: [] }, '')).not.toThrow()
    expect(() => checkSymbols({ stem: 'Δt = t_f ≡ t' }, 'the textbook writes Δt=t_f≡t')).not.toThrow()
    expect(() => checkSymbols({ stem: 'a ≡ F_net' }, 'a textbook without that symbol')).toThrow('"≡"')
  })
})
