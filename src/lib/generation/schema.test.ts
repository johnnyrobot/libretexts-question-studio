import { describe, expect, it } from 'vitest'
import { SAMPLE_DRAFTS } from '../qti/fixtures'
import { evaluate, parse } from '../math/expr'
import { ITEM_TYPES, llmSchemaFor, parseDraft, repairFormula, type DraftOf } from './schema'

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
