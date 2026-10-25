import 'fake-indexeddb/auto'
import { strFromU8, unzipSync } from 'fflate'
import { mkdirSync, writeFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DraftOf } from '../generation/schema'
import { compileMath } from '../math/spec'
import { db } from '../storage/db'
import { numericalExpectation } from './adapt-expectations'
import { itemIdent, mathVersion } from './canvas'
import { exportMathVersions, exportSet } from './export'
import { SAMPLE_DRAFTS } from './fixtures'

const MATH = SAMPLE_DRAFTS.find((d): d is DraftOf<'math'> => d.item_type === 'math')!
// An exact answer, so it can have no tolerance.
const TOTAL: DraftOf<'math'> = {
  ...MATH,
  title: 'Total oxygen released',
  stem: 'A leaf releases {{v}} mL of oxygen per minute for {{t}} minutes. How much oxygen does it release?',
  explanation: 'Volume is rate times time: \\(V = {{v}} \\times {{t}}\\) = {{answer}} mL.',
  answer_formula: 'v * t',
  tolerance_percent: 0,
  units: 'mL',
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

async function seed(drafts = SAMPLE_DRAFTS) {
  await Promise.all([db.items.clear(), db.sets.clear(), db.sources.clear(), db.exports.clear()])
  await db.sources.put({ id: 's', kind: 'paste', title: 'Leaves', library: null, url: null, license: null, pages: [], createdAt: 1 })
  await db.sets.put({
    id: 'set', title: 'Leaf quiz', sourceId: 's', provider: 'local', model: 'm', status: 'complete', error: null,
    requested: { itemTypes: [], count: drafts.length }, createdAt: 1, updatedAt: 1,
  })
  await db.items.bulkPut(
    drafts.map((draft, position) => ({
      id: uuid(position), setId: 'set', position, status: 'approved' as const, draft, sourcePageIndex: 0, critique: [],
      createdAt: 1, updatedAt: 1,
    })),
  )
}

async function quizzes(blob: Blob) {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  return Object.entries(files)
    .filter(([path]) => /^(g[0-9a-f]{32})\/\1\.xml$/.test(path))
    .map(([, bytes]) => {
      const xml = strFromU8(bytes)
      return {
        title: /<assessment ident="[^"]+" title="([^"]*)"/.exec(xml)![1],
        items: [...xml.matchAll(/<item ident="([^"]+)" title="([^"]*)"/g)].map((m) => ({ ident: m[1], title: m[2] })),
        xml,
      }
    })
}

describe('exportSet', () => {
  beforeEach(() => seed())

  it('puts every question, math included, in one quiz by default', async () => {
    const record = await exportSet('set', { includeDrafts: false, randomizeMath: false })
    const [quiz, ...rest] = await quizzes(record.zip)
    expect(rest).toEqual([])
    expect(quiz.items).toHaveLength(SAMPLE_DRAFTS.length)
    expect(quiz.items.at(-1)!.title).toBe(MATH.title)
    expect(record.filename).toBe('leaf-quiz-adapt-qti.zip')
  })

  it('gives identifiers that sort in set order, since ADAPT imports in identifier order', async () => {
    const record = await exportSet('set', { includeDrafts: false, randomizeMath: false })
    const [quiz] = await quizzes(record.zip)
    const idents = quiz.items.map((i) => i.ident)
    expect(idents).toEqual(SAMPLE_DRAFTS.map((_, position) => itemIdent(uuid(position), position, SAMPLE_DRAFTS.length)))
    expect(idents[0]).toMatch(/^q001_g[0-9a-f]{32}$/)
    expect([...idents].sort()).toEqual(idents)
    expect(quiz.xml).toContain(`<fieldentry>${idents[0]}_aq</fieldentry>`)
  })

  it('writes a description students can read as assignment instructions', async () => {
    const record = await exportSet('set', { includeDrafts: false, randomizeMath: false })
    const files = unzipSync(new Uint8Array(await record.zip.arrayBuffer()))
    const meta = strFromU8(Object.entries(files).find(([path]) => path.endsWith('assessment_meta.xml'))![1])
    expect(meta).toContain('<description>&lt;div&gt;&lt;p&gt;Questions based on Leaves.&lt;/p&gt;&lt;/div&gt;</description>')
    expect(meta).not.toMatch(/review/i)
  })

  it('leaves math questions out of the main quiz when they are randomized', async () => {
    const record = await exportSet('set', { includeDrafts: false, randomizeMath: true })
    const [quiz] = await quizzes(record.zip)
    expect(quiz.items).toHaveLength(SAMPLE_DRAFTS.length - 1)
    expect(quiz.items.map((i) => i.title)).not.toContain(MATH.title)
    expect(record.itemIds).not.toContain(uuid(SAMPLE_DRAFTS.length - 1))
  })

  it('says where to go when only math questions are left', async () => {
    await seed([MATH])
    await expect(exportSet('set', { includeDrafts: false, randomizeMath: true })).rejects.toThrow(/Download math versions/)
  })
})

describe('exportMathVersions', () => {
  beforeEach(() => seed([SAMPLE_DRAFTS[0], MATH, { ...MATH, title: 'Second rate question' }]))

  it('writes one quiz per math question, holding every version', async () => {
    const record = await exportMathVersions('set', false, 4)
    const found = await quizzes(record.zip)
    expect(found.map((q) => q.title).sort()).toEqual(['Rate of oxygen release', 'Second rate question'])
    for (const quiz of found) {
      expect(quiz.items.map((i) => i.title)).toEqual([1, 2, 3, 4].map((n) => `${quiz.title} (version ${n})`))
      expect(quiz.xml.match(/numerical_question/g)).toHaveLength(4)
      // Different numbers in every version.
      const stems = [...quiz.xml.matchAll(/releases ([\d.]+) mL of oxygen in (\d+) minutes/g)].map((m) => `${m[1]}/${m[2]}`)
      expect(new Set(stems).size).toBe(4)
    }
    const idents = found.flatMap((q) => q.items.map((i) => i.ident))
    expect(new Set(idents).size).toBe(8)
    // Version 1 keeps the question's own identifier, after its position.
    expect(idents).toContain(itemIdent(uuid(1), 0, 4))
    expect(record.filename).toBe('leaf-quiz-math-versions-adapt-qti.zip')
    expect(record.itemIds).toEqual([uuid(1), uuid(2)])
  })

  it('names the question that cannot make enough versions', async () => {
    await seed([{ ...MATH, variables: [{ name: 'v', min: 1, max: 3, step: 1 }, { name: 't', min: 4, max: 5, step: 1 }] }])
    await expect(exportMathVersions('set', false, 8)).rejects.toThrow(/“Rate of oxygen release”: only 6 different versions/)
  })

  it('writes a question with no tolerance as a single value', async () => {
    await seed([MATH, TOTAL])
    const record = await exportMathVersions('set', false, 5)
    const ranges = Object.fromEntries(
      (await quizzes(record.zip)).map((quiz) => [
        quiz.title,
        [...quiz.xml.matchAll(/<vargte [^>]*>([^<]+)<\/vargte>\n<varlte [^>]*>([^<]+)<\/varlte>/g)].map((m) => [Number(m[1]), Number(m[2])]),
      ]),
    )
    expect(ranges[TOTAL.title]).toHaveLength(5)
    expect(ranges[MATH.title]).toHaveLength(5)
    for (const [low, high] of ranges[TOTAL.title]) expect(low).toBe(high)
    for (const [low, high] of ranges[MATH.title]) expect(low).toBeLessThan(high)

    // npm run verify:adapt runs ADAPT's importer on this export.
    if (process.env.WRITE_QTI_SAMPLE) {
      mkdirSync('tests/adapt-parser/out', { recursive: true })
      writeFileSync('tests/adapt-parser/out/math-versions.zip', new Uint8Array(await record.zip.arrayBuffer()))
      const expected = [MATH, TOTAL].flatMap((draft) =>
        compileMath(draft, 5).variants.map((variant) => numericalExpectation(mathVersion(draft, variant))),
      )
      writeFileSync('tests/adapt-parser/out/math-versions-expectations.json', JSON.stringify(expected, null, 2))
    }
  })

  it('is byte-identical when exported twice', async () => {
    const a = await exportMathVersions('set', false, 3)
    const b = await exportMathVersions('set', false, 3)
    expect(Buffer.from(await a.zip.arrayBuffer()).equals(Buffer.from(await b.zip.arrayBuffer()))).toBe(true)
  })
})
