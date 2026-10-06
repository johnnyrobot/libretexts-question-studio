// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { EmptySourceError, normalizeHtml, normalizePlainText } from './normalize'

describe('normalizeHtml', () => {
  it('splits block elements into paragraphs whose offsets slice back to their text', () => {
    const result = normalizeHtml(
      '<h2>Atoms</h2><p>An atom has a <b>nucleus</b>.</p><script>x()</script>' +
        '<ul><li>Protons</li><li>Neutrons</li></ul><img alt="Bohr  model"><br>Tail',
    )
    expect(result.paragraphs.map((p) => p.text)).toEqual([
      'Atoms',
      'An atom has a nucleus.',
      'Protons',
      'Neutrons',
      '[Image: Bohr model]',
      'Tail',
    ])
    for (const p of result.paragraphs) {
      expect(result.plaintext.slice(p.start, p.end)).toBe(p.text)
    }
  })

  it('rejects a body with no readable text', () => {
    expect(() => normalizeHtml('<script>only()</script>')).toThrow(EmptySourceError)
  })
})

describe('normalizePlainText', () => {
  it('collapses whitespace and drops blank lines from pasted text', () => {
    const result = normalizePlainText('  First   line \n\n\n second line ')
    expect(result.paragraphs.map((p) => p.text)).toEqual(['First line', 'second line'])
    expect(result.plaintext).toBe('First line\n\nsecond line')
  })
})
