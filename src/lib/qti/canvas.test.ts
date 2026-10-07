import { unzipSync, strFromU8 } from 'fflate'
import { writeFileSync, mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDraft, type DraftOf } from '../generation/schema'
import { compileMath } from '../math/spec'
import {
  buildItemXml,
  buildQuizPackage,
  escapeHtml,
  formatNumber,
  ident,
  itemIdent,
  mathVersion,
  numericRange,
  paragraphsHtml,
} from './canvas'
import { SAMPLE_DRAFTS } from './fixtures'

const items = SAMPLE_DRAFTS.map((draft, index) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  draft,
}))

describe('canvas QTI package', () => {
  it('fixtures satisfy the item schemas', () => {
    for (const draft of SAMPLE_DRAFTS) {
      const { item_type, ...payload } = draft
      expect(() => parseDraft(item_type, payload)).not.toThrow()
    }
  })

  it('lays out a zip exactly the way the ADAPT Canvas importer reads it', () => {
    const zip = buildQuizPackage([{ id: 'set-1', title: 'Chapter 1 Quiz', items }])
    const files = unzipSync(zip)
    const dir = ident('set-1')
    expect(Object.keys(files).sort()).toEqual(
      [`${dir}/${dir}.xml`, `${dir}/assessment_meta.xml`, 'imsmanifest.xml'].sort(),
    )
    const manifest = strFromU8(files['imsmanifest.xml'])
    expect(manifest.match(/<resource /g)).toHaveLength(2)
    expect(manifest).toContain(
      `type="associatedcontent/imscc_xmlv1p1/learning-application-resource" href="${dir}/assessment_meta.xml"`,
    )
    expect(strFromU8(files[`${dir}/assessment_meta.xml`])).toContain('canvas.instructure.com')

    if (process.env.WRITE_QTI_SAMPLE) {
      mkdirSync('tests/adapt-parser/out', { recursive: true })
      const sample = buildQuizPackage([
        {
          id: 'question-studio-import-test',
          title: 'Question Studio — ADAPT import test (safe to delete)',
          description: 'One question of every type, exported by LibreTexts Question Studio to test ADAPT import.',
          items,
        },
      ])
      writeFileSync('tests/adapt-parser/out/sample.zip', sample)
      writeFileSync('tests/adapt-parser/out/expectations.json', JSON.stringify(SAMPLE_DRAFTS.map(adaptExpectation), null, 2))
    }
  })

  it('is byte-stable for the same content', () => {
    const a = buildQuizPackage([{ id: 'set-1', title: 'Quiz', items }])
    const b = buildQuizPackage([{ id: 'set-1', title: 'Quiz', items }])
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('never puts a newline inside a text node (ADAPT deletes them)', () => {
    for (const item of items) {
      const xml = buildItemXml(item)
      // Newlines between tags are fine; inside text they would glue words.
      for (const textNode of xml.matchAll(/>([^<]+)</g)) {
        if (textNode[1].trim() === '') continue
        expect(textNode[1]).not.toMatch(/\n/)
      }
    }
  })

  it('leaves out characters XML forbids, which would spoil the whole file', () => {
    // A form feed where gpt-6-luna meant the backslash of \(.
    const draft = { ...items[0].draft, stem: 'Which force acts \f(F\f) on the cart?' }
    const files = unzipSync(buildQuizPackage([{ id: 'set-1', title: 'Quiz \u0005', items: [{ ...items[0], draft }] }]))
    for (const file of Object.values(files)) expect(strFromU8(file)).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/)
  })

  it('declares at least two metadata fields per item', () => {
    for (const item of items) {
      expect(buildItemXml(item).match(/<qtimetadatafield>/g)!.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('double-escapes displayed HTML and keeps scoring values raw', () => {
    const mc = buildItemXml(items[0])
    expect(mc).toContain('&amp;lt;b&amp;gt;Helium&amp;lt;/b&amp;gt;')
    const fib = buildItemXml(items[5])
    expect(fib).toContain('<varequal respident="response1">chlorophyll</varequal>')
  })

  it('puts the correct dropdown option first and keeps brackets only as placeholders', () => {
    const xml = buildItemXml(items[6])
    const firstLabel = xml.match(/<response_lid ident="response_gasin">[\s\S]*?<response_label ident="(\d+)">[\s\S]*?<mattext texttype="text\/html">([^<]*)</)!
    expect(firstLabel[2]).toBe('carbon dioxide')
    expect(xml).toContain(`<varequal respident="response_gasin">${firstLabel[1]}</varequal>`)
  })

  it('uses response_<digits> idents for matching terms and <varequal> only for scoring', () => {
    const xml = buildItemXml(items[4])
    expect(xml.match(/<response_lid ident="response_\d+">/g)).toHaveLength(3)
    expect(xml.match(/<varequal /g)).toHaveLength(3)
    expect(xml).toMatch(/<render_choice>\n/)
  })

  it('encodes numerical answers as an inclusive range', () => {
    const xml = buildItemXml(items[3])
    expect(xml).toContain('<vargte respident="response1">5.9</vargte>')
    expect(xml).toContain('<varlte respident="response1">6.1</varlte>')
  })

  it('exports a math question as its first version, a numerical question with computed values', () => {
    const item = items.find((i) => i.draft.item_type === 'math')!
    const draft = item.draft as DraftOf<'math'>
    const [first] = compileMath(draft).variants
    const xml = buildItemXml(item)
    expect(xml).toContain('<fieldentry>numerical_question</fieldentry>')
    const [low, high] = numericRange(first.answer, first.margin)
    expect(xml).toContain(`<vargte respident="response1">${low}</vargte>`)
    expect(xml).toContain(`<varlte respident="response1">${high}</varlte>`)
    expect(xml).toContain(`releases ${first.values.v} mL of oxygen in ${first.values.t} minutes`)
    expect(xml).toContain('(Answer in mL/min.)')
    expect(xml).not.toContain('{{')
    expect(buildItemXml({ id: item.id, draft: mathVersion(draft, first) })).toBe(xml)
  })
})

describe('numericRange', () => {
  // What ADAPT stores, computed the way PHP does it (doubles, like JS).
  const stored = ([low, high]: [string, string]) => {
    const value = (Number(low) + Number(high)) / 2
    return { value, margin: Math.round((Number(high) - value) * 1e5) / 1e5 }
  }

  it('makes ADAPT store exactly the answer and the margin', () => {
    let state = 12345
    const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    for (let i = 0; i < 2000; i++) {
      const answer = Number((random() * 10 ** Math.floor(random() * 8 - 3)).toPrecision(6))
      const margin = Math.max(0.00001, Math.round(answer * 0.01 * 1e5) / 1e5)
      expect(stored(numericRange(answer, margin))).toEqual({ value: answer, margin })
    }
  })

  it('covers the cases a naive range gets wrong', () => {
    expect((0.342694 + 0.349614) / 2).not.toBe(0.346154)
    expect(stored(numericRange(0.346154, 0.00346))).toEqual({ value: 0.346154, margin: 0.00346 })
    expect(numericRange(6, 0)).toEqual(['6', '6'])
  })
})

describe('helpers', () => {
  it('formats numbers without float noise or exponents', () => {
    expect(formatNumber(6 - 0.1)).toBe('5.9')
    expect(formatNumber(0.1 + 0.2)).toBe('0.3')
    expect(formatNumber(1.5e-7)).toBe('0.00000015')
    expect(formatNumber(42)).toBe('42')
  })

  it('renders paragraphs without raw newlines', () => {
    expect(paragraphsHtml('a\nb\n\nc')).toBe('<div><p>a<br>b</p><p>c</p></div>')
  })

  it('derives stable Canvas-style identifiers', () => {
    expect(ident('0f8e2c1a-1111-4222-8333-444455556666')).toBe('g0f8e2c1a111142228333444455556666')
    expect(ident('set-1')).toMatch(/^g[0-9a-f]{32}$/)
    expect(ident('set-1')).toBe(ident('set-1'))
    // Version ids must not collapse onto the question's own UUID.
    const uuid = '0f8e2c1a-1111-4222-8333-444455556666'
    expect(ident(`${uuid}:v2`)).toMatch(/^g[0-9a-f]{32}$/)
    expect(new Set([ident(uuid), ident(`${uuid}:v2`), ident(`${uuid}:v3`)]).size).toBe(3)
  })

  it('prefixes item identifiers with a position wide enough to sort as text', () => {
    const uuid = '0f8e2c1a-1111-4222-8333-444455556666'
    expect(itemIdent(uuid, 0, 5)).toBe('q001_g0f8e2c1a111142228333444455556666')
    expect(itemIdent(uuid, 9, 12)).toMatch(/^q010_/)
    expect(itemIdent(uuid, 999, 1200)).toMatch(/^q1000_/)
    expect(itemIdent(uuid, 8, 1200)).toMatch(/^q0009_/)
  })
})

// What ADAPT should store for each fixture, checked by tests/adapt-parser/run.mjs.
function adaptExpectation(draft: (typeof SAMPLE_DRAFTS)[number]) {
  const base = { item_type: draft.item_type, explanationHtml: paragraphsHtml(draft.explanation) }
  switch (draft.item_type) {
    case 'multiple_choice':
      return {
        ...base,
        choices: draft.choices,
        correctHtml: escapeHtml(draft.choices.find((c) => c.correct)!.text),
        choiceFeedback: Object.fromEntries(
          draft.choices.flatMap((c, i) => (c.feedback ? [[String(1000 + i), paragraphsHtml(c.feedback)]] : [])),
        ),
      }
    case 'true_false':
      return { ...base, choices: [1, 2], correctHtml: draft.answer ? 'True' : 'False' }
    case 'multiple_answers':
      return { ...base, correctHtml: draft.choices.filter((c) => c.correct).map((c) => escapeHtml(c.text)) }
    case 'numerical':
      return numericalExpectation(draft)
    case 'math':
      return numericalExpectation(mathVersion(draft, compileMath(draft).variants[0]))
    case 'matching':
      return {
        ...base,
        pairsHtml: draft.pairs.map((p) => [escapeHtml(p.prompt), escapeHtml(p.match)]),
        optionCount: draft.pairs.length + draft.distractors.length,
      }
    case 'fill_in_blank':
      return { ...base, answer: draft.answer }
    case 'dropdowns':
      return {
        ...base,
        blanks: draft.blanks.map((b) => ({ id: b.id, correctHtml: escapeHtml(b.correct), optionCount: 1 + b.distractors.length })),
      }
    case 'essay':
      return { ...base, stemHtml: paragraphsHtml(draft.stem) }
  }
}

// ADAPT stores value = midpoint and margin = half-width (rounded to 5
// decimals) of the exported range, in doubles just like JavaScript.
function numericalExpectation(draft: DraftOf<'numerical'>) {
  const low = Number(formatNumber(draft.answer - draft.tolerance))
  const high = Number(formatNumber(draft.answer + draft.tolerance))
  const value = (low + high) / 2
  return {
    item_type: 'numerical' as const,
    explanationHtml: paragraphsHtml(draft.explanation),
    answer: value,
    tolerance: Math.round((high - value) * 1e5) / 1e5,
  }
}

describe('answer-leak and wording checks', () => {
  const fib = SAMPLE_DRAFTS.find((d) => d.item_type === 'fill_in_blank')!
  const { item_type: _t, ...payload } = fib
  void _t

  it('rejects a fill-in-the-blank whose stem contains the answer', () => {
    expect(() =>
      parseDraft('fill_in_blank', { ...payload, stem: 'Chlorophyll is the pigment; the green pigment is called ____.' }),
    ).toThrow(/gives the answer away/)
  })

  it('rejects paragraph numbers in student-facing text', () => {
    expect(() => parseDraft('fill_in_blank', { ...payload, explanation: 'This is stated in paragraph 26.' })).toThrow(
      /paragraph numbers/,
    )
  })

  it('rejects dropdown options already written in the stem', () => {
    const dd = SAMPLE_DRAFTS.find((d) => d.item_type === 'dropdowns')!
    const { item_type: _d, ...rest } = dd
    void _d
    expect(() => parseDraft('dropdowns', { ...rest, stem: 'Plants absorb [gasin], not oxygen, and release [gasout].' })).toThrow(
      /gives \[gasout\] away/,
    )
  })
})

describe('dollar signs', () => {
  it('keeps literal $ out of MathJax 3 inline math', () => {
    expect(paragraphsHtml('It costs $5 and $7.')).toBe(
      '<div><p>It costs <span class="tex2jax_ignore">$</span>5 and <span class="tex2jax_ignore">$</span>7.</p></div>',
    )
  })
})
