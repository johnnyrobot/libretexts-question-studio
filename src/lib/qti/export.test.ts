import 'fake-indexeddb/auto'
import { strFromU8, unzipSync } from 'fflate'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DraftOf } from '../generation/schema'
import { compileMath } from '../math/spec'
import { db, type StoredSource } from '../storage/db'
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

async function descriptionAndManifest(blob: Blob) {
  const entries = Object.entries(unzipSync(new Uint8Array(await blob.arrayBuffer())))
  const text = (end: string) => strFromU8(entries.find(([path]) => path.endsWith(end))![1])
  // The description is HTML inside XML: undo the XML escaping to read the HTML.
  const description = /<description>([^<]*)<\/description>/
    .exec(text('assessment_meta.xml'))![1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
  return { description, manifest: text('imsmanifest.xml') }
}

const sha256 = async (blob: Blob) => createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex')

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

  it('writes the same bytes as before authorship for a pasted source with no link or license, and no author', async () => {
    // Taken on main at e1f63ef, before export authorship; change only on purpose.
    for (const author of [undefined, '', '   ']) {
      const set = await exportSet('set', { includeDrafts: false, randomizeMath: false, author })
      const math = await exportMathVersions('set', false, 3, author)
      expect(await sha256(set.zip)).toBe('92f8affef628deff8399c3c474b0eefff67cc96e646a973bd39f5262919b07a3')
      expect(await sha256(math.zip)).toBe('abd9ea8fe5ecfead561791564660f35385bea9ce431152cbbb288fcb5f5b3f40')
    }
  })

  it('names the question author for students and in the manifest', async () => {
    for (const record of [
      await exportSet('set', { includeDrafts: false, randomizeMath: false, author: '  Ana Ruiz ' }),
      await exportMathVersions('set', false, 3, '  Ana Ruiz '),
    ]) {
      const { description, manifest } = await descriptionAndManifest(record.zip)
      expect(description).toBe('<div><p>Questions based on Leaves.</p><p>Question author: Ana Ruiz</p></div>')
      expect(manifest).toContain('\nFN:Ana Ruiz\n')
    }
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

describe('the credit for the source', () => {
  const URL = 'https://human.libretexts.org/@go/page/378488'
  const PAGE: StoredSource = {
    id: 's', kind: 'page', title: '4.2: La profecía de la gitana', library: 'human', url: URL,
    license: { code: 'ccbyncsa', label: 'CC BY-NC-SA 4.0', version: '4.0' }, pages: [], createdAt: 1,
  }
  const BOOK = { title: 'Lecturas intermedias', author: 'Erica Brown & Elizabeth Small' }
  const BOOK_URL = 'https://human.libretexts.org/Bookshelves/Languages/Spanish/Lecturas_intermedias'

  beforeEach(() => seed())

  it.each<[string, StoredSource, string]>([
    [
      'a page of a book',
      { ...PAGE, book: BOOK },
      `Questions based on 4.2: La profecía de la gitana (${URL}), from Lecturas intermedias by Erica Brown &amp; Elizabeth Small. License: CC BY-NC-SA 4.0.`,
    ],
    [
      'a whole book',
      { ...PAGE, kind: 'book', title: 'Lecturas intermedias', url: BOOK_URL, book: BOOK },
      `Questions based on Lecturas intermedias by Erica Brown &amp; Elizabeth Small (${BOOK_URL}). License: CC BY-NC-SA 4.0.`,
    ],
    [
      'a book the catalog names no author for',
      { ...PAGE, book: { title: 'Lecturas intermedias', author: null } },
      `Questions based on 4.2: La profecía de la gitana (${URL}), from Lecturas intermedias. License: CC BY-NC-SA 4.0.`,
    ],
    [
      'a page with no license',
      { ...PAGE, license: null, book: BOOK },
      `Questions based on 4.2: La profecía de la gitana (${URL}), from Lecturas intermedias by Erica Brown &amp; Elizabeth Small.`,
    ],
    [
      'a source saved before the app kept its book',
      PAGE,
      `Questions based on 4.2: La profecía de la gitana (${URL}). License: CC BY-NC-SA 4.0.`,
    ],
    [
      'a book picked when the app kept a license code with no label as its own label',
      { ...PAGE, license: { code: 'mixed', label: 'mixed', version: null }, book: BOOK },
      `Questions based on 4.2: La profecía de la gitana (${URL}), from Lecturas intermedias by Erica Brown &amp; Elizabeth Small.`,
    ],
  ])('credits %s with what is known', async (_, source, credit) => {
    await db.sources.put(source)
    const record = await exportSet('set', { includeDrafts: false, randomizeMath: false })
    expect((await descriptionAndManifest(record.zip)).description).toBe(`<div><p>${credit}</p></div>`)
  })

  it('puts the source credit and the question author in the zip together', async () => {
    await db.sources.put({ ...PAGE, book: BOOK })
    const record = await exportSet('set', { includeDrafts: false, randomizeMath: false, author: 'Ana Ruiz' })
    const { description, manifest } = await descriptionAndManifest(record.zip)
    expect(description).toBe(
      `<div><p>Questions based on 4.2: La profecía de la gitana (${URL}), from Lecturas intermedias by Erica Brown &amp; Elizabeth Small. License: CC BY-NC-SA 4.0.</p><p>Question author: Ana Ruiz</p></div>`,
    )
    expect(manifest).toContain('<value>author</value>')
    expect(manifest).toContain('\nFN:Ana Ruiz\n')
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
