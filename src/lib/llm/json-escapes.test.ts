import { describe, expect, it } from 'vitest'
import { escapeTokens, JsonStringState } from './json-escapes'

describe('unicode escapes in generated JSON', () => {
  const texts = ['{"', 'stem', '":', ' "', 'The weight (', '\\', 'u', 'u212B', '\\u', '(\\u', '\\\\u', '\\\\', '(', 'w', '"}', 'unit']
  const tokens = escapeTokens(texts)
  const id = (text: string) => texts.indexOf(text)

  it('finds the tokens that start an escape or hold one', () => {
    expect(tokens.afterBackslash.map((i) => texts[i])).toEqual(['u', 'u212B', 'unit'])
    // An escaped backslash followed by "u" is a backslash and the letter u.
    expect(tokens.within.map((i) => texts[i])).toEqual(['\\u', '(\\u'])
  })

  it('masks them only inside a string, and "u" only after a backslash', () => {
    const state = new JsonStringState()
    state.feed('{')
    expect(state.blocked(tokens)).toEqual([])
    for (const text of ['"', 'stem', '":', ' "', 'The weight (']) state.feed(text)
    expect(state.blocked(tokens)).toEqual(tokens.within)
    state.feed('\\')
    expect(state.blocked(tokens)).toEqual(tokens.afterBackslash)
    expect(state.blocked(tokens)).toContain(id('u212B'))
    state.feed('\\')
    expect(state.blocked(tokens)).toEqual(tokens.within)
    for (const text of ['(', 'w', '\\\\', ')', '"}']) state.feed(text)
    expect(state.inString).toBe(false)
  })

  it('reads an escaped quote as part of the string', () => {
    const state = new JsonStringState()
    state.feed('{"a": "say \\"hi\\" ')
    expect(state.inString).toBe(true)
    state.feed('"}')
    expect(state.inString).toBe(false)
  })
})
