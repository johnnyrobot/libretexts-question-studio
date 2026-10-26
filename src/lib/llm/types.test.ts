import { describe, expect, it } from 'vitest'
import { DEVICE_LOST_ERROR } from './fixtures'
import { completeWithRetries, dropTrailingCommas, GpuLost, parseJsonResponse, repairLatexEscapes } from './types'

describe('completeWithRetries', () => {
  const request = {
    system: '',
    prompt: 'Write a question.',
    schemaName: 'question',
    schema: {},
    validate: (value: unknown) => value,
  }

  it('stops at a lost GPU instead of asking again', async () => {
    let calls = 0
    const completion = completeWithRetries(request, async () => {
      calls++
      throw new Error(DEVICE_LOST_ERROR)
    })
    await expect(completion).rejects.toBeInstanceOf(GpuLost)
    expect(calls).toBe(1)
  })

  it('still asks again when a check quotes an answer about something lost', async () => {
    // The pipeline's checks quote the model's words back to it.
    let calls = 0
    const completion = completeWithRetries(
      {
        ...request,
        validate: (value: unknown) => {
          throw new Error(`label "${(value as { label: string }).label}" says what kind of concept it is`)
        },
      },
      async () => {
        calls++
        return { text: '{"label": "The energy is lost as heat"}', usage: null }
      },
    )
    await expect(completion).rejects.not.toBeInstanceOf(GpuLost)
    expect(calls).toBe(3)
  })

  it('still asks again when the engine loses something other than the GPU', async () => {
    let calls = 0
    const completion = completeWithRetries(request, async () => {
      calls++
      throw new Error('Connection is lost.')
    })
    await expect(completion).rejects.not.toBeInstanceOf(GpuLost)
    expect(calls).toBe(3)
  })
})

describe('parseJsonResponse', () => {
  it('reads LaTeX written with one backslash as LaTeX, not as JSON escapes', () => {
    // Gemma 4 E4B: \frac became a form feed and \text a tab. Escapes JSON does
    // not have, such as \D, cannot get past the grammar, so those arrive doubled.
    const raw = String.raw`{"stem": "Find $\bar{v}=\frac{\\Delta x}{t}$ for ($\text{30 m}$) at $\theta$ and $\rho \neq 0$."}`
    expect(parseJsonResponse(raw)).toEqual({ stem: String.raw`Find $\bar{v}=\frac{\Delta x}{t}$ for ($\text{30 m}$) at $\theta$ and $\rho \neq 0$.` })
  })

  it('reads the text-mode spellings Gemma 4 E4B writes as LaTeX too', () => {
    // These arrived as a tab and "extsubscript{net}" in the saved runs.
    const raw = String.raw`{"stem": "F\textsubscript{net} = ma, 9.80 m/s\textasciicircum{}2, 10\textsuperscript{3}, F\textunderscore net, \textbf{x}"}`
    expect(parseJsonResponse(raw)).toEqual({ stem: String.raw`F\textsubscript{net} = ma, 9.80 m/s\textasciicircum{}2, 10\textsuperscript{3}, F\textunderscore net, \textbf{x}` })
    // \to, \ne and \nu read as text here; inside math, controlsToBackslashes restores them.
    expect(parseJsonResponse(String.raw`{"a": "$F_{A \to B}$ \ne \nu"}`)).toEqual({ a: '$F_{A \to B}$ \ne \nu' })
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
