import { unzipSync, strFromU8 } from 'fflate'
import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkModelDraft, parseDraft, typedAnswerProblem, type DraftOf, type ItemType } from '../generation/schema'
import { formatUnits } from '../math/format'
import { compileMath } from '../math/spec'
import {
  buildItemXml,
  buildQuizPackage,
  formatNumber,
  ident,
  itemIdent,
  mathVersion,
  numericRange,
  paragraphsHtml,
} from './canvas'
import { adaptExpectation } from './adapt-expectations'
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
          // Shaped like an export's own: the source credit, then the author.
          description:
            'Questions based on 4.2: La profecía de la gitana (https://human.libretexts.org/@go/page/378488), ' +
            'from ¡HOLA! Spanish 3 (Tseng, Rosales, and Lemari) by Beatrice Tseng, Karla Lemari, Lisbeth Rosales. ' +
            'License: CC BY-NC-SA 4.0.\n\nQuestion author: Question Studio test',
          items,
        },
      ], { author: 'Question Studio test' })
      writeFileSync('tests/adapt-parser/out/sample.zip', sample)
      writeFileSync('tests/adapt-parser/out/expectations.json', JSON.stringify(SAMPLE_DRAFTS.map(adaptExpectation), null, 2))
    }
  })

  it('builds the same bytes as before authorship when no author is given', () => {
    // Taken on main at e1f63ef, before export authorship. An export with no
    // author must stay byte-for-byte what it was; change this only on purpose.
    const zip = buildQuizPackage([{ id: 'set-1', title: 'Chapter 1 Quiz', description: 'Questions based on Leaves.', items }])
    expect(createHash('sha256').update(zip).digest('hex')).toBe('afc38dd1a4181f7a4c858bcf8d1dd7e90eeeecd5d74deaea60590a9935bca383')
  })

  it('names the question author in the manifest metadata as IEEE LOM, a vCard 3.0 with its required N', () => {
    const manifestOf = (author?: string) =>
      strFromU8(unzipSync(buildQuizPackage([{ id: 'set-1', title: 'Quiz', items }], { author }))['imsmanifest.xml'])
    const manifest = manifestOf('Ruiz, Ana <ana@example.org> & Co')
    // The LOM block names its own namespace, so the manifest element is the same as with no author.
    expect(manifest.split('\n')[1]).toBe(manifestOf().split('\n')[1])
    expect(manifest).toContain(
      [
        '<schemaversion>1.1.3</schemaversion>',
        '<lom xmlns="http://ltsc.ieee.org/xsd/LOM">',
        '<lifeCycle>',
        '<contribute>',
        '<role>',
        '<source>LOMv1.0</source>',
        '<value>author</value>',
        '</role>',
        '<entity>BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Ruiz\\, Ana &lt;ana@example.org&gt; &amp; Co',
        'N:;;;;',
        'END:VCARD</entity>',
        '</contribute>',
        '</lifeCycle>',
        '</lom>',
        '</metadata>',
      ].join('\n'),
    )
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
    // eslint-disable-next-line no-control-regex -- detecting these is the point
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

  it('gives the parts of a matching or dropdowns question shares that add up to exactly 100', () => {
    const matching = items[4].draft as DraftOf<'matching'>
    const dropdowns = items[6].draft as DraftOf<'dropdowns'>
    const elements = ['Hydrogen', 'Helium', 'Lithium', 'Beryllium', 'Boron', 'Carbon', 'Nitrogen']
    // Three pairs, seven pairs and three blanks.
    const drafts = [matching, { ...matching, pairs: elements.map((name, i) => ({ prompt: `Element ${i + 1}`, match: name })), distractors: [] }, dropdowns]
    for (const draft of drafts) {
      const shares = [...buildItemXml({ id: items[4].id, draft }).matchAll(/<setvar varname="SCORE" action="Add">([\d.]+)<\/setvar>/g)].map((m) => m[1])
      const parts = draft.item_type === 'matching' ? draft.pairs.length : draft.blanks.length
      expect(shares).toHaveLength(parts)
      // In hundredths, so that floating point cannot round a wrong total to 100.
      expect(shares.every((share) => /^\d+(\.\d{1,2})?$/.test(share))).toBe(true)
      expect(shares.reduce((sum, share) => sum + Math.round(Number(share) * 100), 0)).toBe(10000)
    }
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

  it('writes unit powers as superscripts, since ADAPT shows units as typed', () => {
    expect(formatUnits('m/s^2')).toBe('m/s²')
    expect(formatUnits('kg·m^{2}/s^-1')).toBe('kg·m²/s⁻¹')
    expect(formatUnits('m/s²')).toBe('m/s²')
    expect(formatUnits('N')).toBe('N')
    const numerical = items.find((i) => i.draft.item_type === 'numerical')!
    const draft = { ...numerical.draft, units: 'm/s^2' } as DraftOf<'numerical'>
    expect(buildItemXml({ ...numerical, draft })).toContain('(Answer in m/s².)')
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

describe('answer-leak and wording checks', () => {
  const fib = SAMPLE_DRAFTS.find((d) => d.item_type === 'fill_in_blank')!
  const { item_type: _t, ...payload } = fib
  void _t

  it('rejects a fill-in-the-blank whose stem contains the answer', () => {
    expect(() =>
      parseDraft('fill_in_blank', { ...payload, stem: 'Chlorophyll is the pigment; the green pigment is called ____.' }),
    ).toThrow(/gives the answer away/)
  })

  // What the pipeline applies to model output: parse, then the model-only rules.
  const fromModel = (itemType: ItemType, value: unknown) => checkModelDraft(parseDraft(itemType, value))

  it('rejects paragraph numbers in student-facing text', () => {
    expect(() => fromModel('fill_in_blank', { ...payload, explanation: 'This is stated in paragraph 26.' })).toThrow(
      /paragraph numbers/,
    )
  })

  it('rejects references to figures, tables and examples students cannot see', () => {
    for (const stem of ['As shown in Figure 4.3.1, the cart speeds up because ____.', 'Using the values in Table 2, the force is ____.', 'In Example 4.4 the cart moves because ____.']) {
      expect(() => fromModel('fill_in_blank', { ...payload, stem })).toThrow(/students never see/)
    }
    expect(() => fromModel('fill_in_blank', { ...payload, stem: 'A figure skater spins faster when she pulls in her ____.' })).not.toThrow()
  })

  it('leaves those rules out of parseDraft, which the editor and backup restore use', () => {
    expect(() => parseDraft('fill_in_blank', { ...payload, stem: 'As shown in Figure 4.3.1, the cart speeds up because ____.' })).not.toThrow()
    expect(() => parseDraft('fill_in_blank', { ...payload, answer: '9.8 N', stem: 'The weight of a 1.0 kg object is ____.' })).not.toThrow()
  })

  it('names fill-in-the-blank answers students cannot type to an exact match, without rejecting them', () => {
    const stem = 'The weight of a 1.0 kg object on Earth is ____.'
    for (const answer of ['9.8 N', '53 N', '9.8 m/s^2', 'w = mg', '\\(ma\\)', '-3']) {
      const draft = parseDraft('fill_in_blank', { ...payload, stem, answer, alternates: [] })
      expect(() => checkModelDraft(draft), answer).not.toThrow()
      expect(typedAnswerProblem(draft), answer).toContain(`"${answer}" is a number, symbol or equation`)
    }
    for (const answer of ['chlorophyll', 'H2O', 'g', 'net force']) {
      expect(typedAnswerProblem(parseDraft('fill_in_blank', { ...payload, stem, answer, alternates: [] })), answer).toBeNull()
    }
  })

  it('rejects control characters, which JSON.stringify would hide as escapes', () => {
    expect(() => parseDraft('fill_in_blank', { ...payload, explanation: 'So \f(F = ma\f).' })).toThrow(/control characters/)
  })

  it('rejects dropdown options already written in the stem', () => {
    const dd = SAMPLE_DRAFTS.find((d) => d.item_type === 'dropdowns')!
    const { item_type: _d, ...rest } = dd
    void _d
    expect(() => parseDraft('dropdowns', { ...rest, stem: 'Plants absorb [gasin], not oxygen, and release [gasout], using energy from [energy].' })).toThrow(
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
