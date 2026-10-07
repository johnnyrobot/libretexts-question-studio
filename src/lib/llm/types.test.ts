import { describe, expect, it } from 'vitest'
import { dropTrailingCommas, parseJsonResponse, repairLatexEscapes } from './types'

describe('parseJsonResponse', () => {
  it('reads LaTeX written with one backslash as LaTeX, not as JSON escapes', () => {
    // Gemma 4 E4B: \frac became a form feed and \text a tab. Escapes JSON does
    // not have, such as \D, cannot get past the grammar, so those arrive doubled.
    const raw = String.raw`{"stem": "Find $\bar{v}=\frac{\\Delta x}{t}$ for ($\text{30 m}$) at $\theta$ and $\rho \neq 0$."}`
    expect(parseJsonResponse(raw)).toEqual({ stem: String.raw`Find $\bar{v}=\frac{\Delta x}{t}$ for ($\text{30 m}$) at $\theta$ and $\rho \neq 0$.` })
  })

  it('keeps real escapes and already doubled backslashes', () => {
    const raw = String.raw`{"a": "line\nbreak\ttab \\frac{1}{2} \"q\" \nu \to"}`
    expect(parseJsonResponse(raw)).toEqual({ a: 'line\nbreak\ttab \\frac{1}{2} "q" \nu \to' })
    expect(repairLatexEscapes('{"a": "\\n"}')).toBe('{"a": "\\n"}')
  })

  it('drops trailing commas, which the structured-output package allows', () => {
    expect(parseJsonResponse('{"citation_paragraphs": [2,], "x": {"y": 1, }}')).toEqual({ citation_paragraphs: [2], x: { y: 1 } })
    expect(dropTrailingCommas('{"a": "keep ,] this",}')).toBe('{"a": "keep ,] this"}')
  })

  it('still finds JSON in a code fence', () => {
    expect(parseJsonResponse('Here you go:\n```json\n{"a": [1,]}\n```')).toEqual({ a: [1] })
  })
})
