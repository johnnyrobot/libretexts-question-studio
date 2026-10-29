import { describe, expect, it } from 'vitest'
import { SAMPLE_DRAFTS } from '../qti/fixtures'
import { evaluate, parse } from '../math/expr'
import { checkModelDraft, checkSymbols, ITEM_TYPES, llmSchemaFor, parseDraft, repairFormula, type DraftOf } from './schema'

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

describe('checkModelDraft', () => {
  it('sends back a fill-in-the-blank key that is only function words', () => {
    const fib = SAMPLE_DRAFTS.find((d): d is DraftOf<'fill_in_blank'> => d.item_type === 'fill_in_blank')!
    const key = (stem: string, answer: string) => () => checkModelDraft({ ...fib, stem, answer })
    expect(key('The weight ____ of an object is calculated from its mass.', 'is')).toThrow('"is" is a function word, not a term')
    expect(key('An internal force acts ____ elements of the system.', 'between')).toThrow('function word')
    expect(key('The acceleration ____ gravity is 9.8 m/s².', 'due to')).toThrow('function word')
    expect(key('A force that ____ real.', "isn't")).toThrow('function word')
    expect(key('____ the net force is zero, the velocity is constant.', 'When')).toThrow('function word')
    // Terms, including ones that are also function-like words, and symbols
    // and acronyms written as such.
    expect(key("Newton's ____ law relates force and acceleration.", 'second')).not.toThrow()
    expect(key('Acceleration is ____ to the net force.', 'proportional to')).not.toThrow()
    expect(key('The ____ of interest is chosen first.', 'system')).not.toThrow()
    expect(key('____ poles repel.', 'Like')).not.toThrow()
    expect(key('The lightest quark is the ____ quark.', 'down')).not.toThrow()
    expect(key('The symbol for helium is ____.', 'He')).not.toThrow()
    expect(key('Indium has the symbol ____.', 'In')).not.toThrow()
    expect(key('A gate whose output is 1 only when both inputs are 1 is an ____ gate.', 'AND')).not.toThrow()
    expect(key('The square root of −1 is written ____.', 'i')).not.toThrow()
    expect(key('F = m ____', 'a')).not.toThrow()
  })

  it('sends back a wrong option that is the same number as the key', () => {
    const fixture = <K extends DraftOf<'dropdowns' | 'multiple_choice' | 'multiple_answers' | 'matching'>['item_type']>(type: K) =>
      SAMPLE_DRAFTS.find((d): d is DraftOf<K> => d.item_type === type)!
    const dropdowns = fixture('dropdowns')
    const blank = (correct: string, distractors: string[]) => () =>
      checkModelDraft({ ...dropdowns, blanks: [{ ...dropdowns.blanks[0], correct, distractors }, ...dropdowns.blanks.slice(1)] })
    // Gemma 4 E4B's MKPZ (2026-10-28): 10 and 10.00 for the same blank.
    expect(blank('10', ['10.00', '100'])).toThrow('"10" and "10.00" are the same number')
    expect(blank('0.5', ['1/2'])).toThrow('"0.5" and "1/2" are the same number')
    expect(blank('2.5 m/s', ['5/2 m/s'])).toThrow('same number')
    expect(blank('1,000 J', ['1000 J'])).toThrow('same number')
    expect(blank('\\(\\frac{1}{4}\\)', ['0.25'])).toThrow('same number')
    expect(blank('-3', ['−3.0'])).toThrow('same number')
    expect(blank('1000 J', ['1e3 J'])).toThrow('same number')
    expect(blank('2.5E-3', ['0.0025'])).toThrow('same number')
    expect(blank('0.1', ['\\(\\frac{0.3}{3}\\)'])).toThrow('same number')
    // Different numbers, units or text.
    expect(blank('10', ['100', '1', '0.1'])).not.toThrow()
    expect(blank('10 m', ['10 s', '10 kg'])).not.toThrow()
    expect(blank('1/2', ['2'])).not.toThrow()
    expect(blank('3', ['-3'])).not.toThrow()
    expect(blank('50%', ['0.5'])).not.toThrow()
    expect(blank('1,5', ['15'])).not.toThrow()
    expect(blank('0.000000001', ['0.000000002'])).not.toThrow()
    expect(blank('1000000000', ['1000000001'])).not.toThrow()
    expect(blank('5 eV', ['5e1 V'])).not.toThrow()
    expect(blank('oxygen', ['10', 'carbon dioxide'])).not.toThrow()

    const choices = (draft: DraftOf<'multiple_choice' | 'multiple_answers'>, texts: string[]) => () =>
      checkModelDraft({ ...draft, choices: draft.choices.map((c, i) => ({ ...c, text: texts[i] })) } as DraftOf<'multiple_choice'>)
    // Choice 2 is the key of the multiple-choice fixture; 1 and 2 of the select-all.
    expect(choices(fixture('multiple_choice'), ['0.50', '1/2', '2', '4'])).toThrow('"1/2" and "0.50" are the same number')
    expect(choices(fixture('multiple_answers'), ['6', '12', '6.0'])).toThrow('"6" and "6.0" are the same number')
    expect(choices(fixture('multiple_choice'), ['0.25', '0.5', '2', '4'])).not.toThrow()
    // Two right answers, or two wrong ones, that are the same number leave the key right.
    expect(choices(fixture('multiple_answers'), ['1/2', '3/6', '1/3'])).not.toThrow()
    expect(choices(fixture('multiple_choice'), ['+1.6 C', '-1.6 C', '1.6 C', '1.6 A·s'])).not.toThrow()
    expect(blank('10', ['5', '5.0'])).not.toThrow()

    const matching = fixture('matching')
    expect(() => checkModelDraft({ ...matching, distractors: ['3.0'], pairs: [...matching.pairs.slice(0, 2), { prompt: 'Atoms in O3', match: '3' }] })).toThrow(
      '"3" and "3.0" are the same number',
    )
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
