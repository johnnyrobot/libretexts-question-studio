// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { EmptySourceError, expandPageIndex, normalizeHtml, normalizePlainText, withPageNumbers } from './normalize'

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

describe('expandPageIndex', () => {
  const title = "4.4: Newton's Third Law of Motion- Symmetry in Forces"

  it('turns the LibreTexts figure macro into the number its pages show', () => {
    expect(expandPageIndex('Figure \\(\\PageIndex{2}\\): A professor pushes a cart.', title)).toBe(
      'Figure 4.4.2: A professor pushes a cart.',
    )
    expect(expandPageIndex('Example \\( \\PageIndex{ 10 } \\) and \\(x = \\PageIndex{3}\\)', title)).toBe(
      'Example 4.4.10 and \\(x = 4.4.3\\)',
    )
    expect(expandPageIndex('Table \\(\\PageIndex{1}\\)', 'A.2: Units')).toBe('Table A.2.1')
  })

  it('keeps just the argument when the title has no number', () => {
    expect(expandPageIndex('Figure \\(\\PageIndex{1}\\)', 'Pasted text')).toBe('Figure 1')
  })

  it('keeps paragraph offsets in step with the new text', () => {
    const { paragraphs, plaintext } = normalizePlainText('Intro\nFigure \\(\\PageIndex{2}\\): A cart.\nAfter')
    expect(plaintext).toContain('PageIndex')
    const expanded = withPageNumbers(paragraphs, title)
    const text = expanded.map((p) => p.text).join('\n\n')
    expect(expanded[1].text).toBe('Figure 4.4.2: A cart.')
    for (const p of expanded) expect(text.slice(p.start, p.end)).toBe(p.text)
    // A page without the macro comes back untouched.
    const plain = paragraphs.slice(0, 1)
    expect(withPageNumbers(plain, title)).toBe(plain)
  })
})
