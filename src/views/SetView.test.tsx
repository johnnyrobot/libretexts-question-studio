// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { strFromU8, unzipSync } from 'fflate'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAMPLE_DRAFTS } from '../lib/qti/fixtures'
import { db } from '../lib/storage/db'
import { FakeLocks } from '../lib/storage/fixtures'
import { SetView } from './SetView'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let cleanup: (() => void) | null = null
// Each file handed to the browser to download.
let downloads: Blob[] = []
afterEach(() => {
  cleanup?.()
  vi.restoreAllMocks()
})

beforeEach(async () => {
  await Promise.all([db.items.clear(), db.sets.clear(), db.sources.clear(), db.exports.clear(), db.settings.clear()])
  await db.sources.put({ id: 's', kind: 'paste', title: 'Leaves', library: null, url: null, license: null, pages: [], createdAt: 1 })
  await db.sets.put({
    id: 'set', title: 'Leaf quiz', sourceId: 's', provider: 'local', model: 'm', status: 'complete', error: null,
    requested: { itemTypes: [], count: 1 }, createdAt: 1, updatedAt: 1,
  })
  await db.items.put({
    id: 'item', setId: 'set', position: 0, status: 'approved', draft: SAMPLE_DRAFTS[0], sourcePageIndex: 0, critique: [],
    createdAt: 1, updatedAt: 1,
  })
  downloads = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    downloads.push(blob as Blob)
    return 'blob:test'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockReturnValue()
})

// Lets what loads from IndexedDB reach the page.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

async function render(tab: 'review' | 'export' = 'export') {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<SetView setId="set" tab={tab} />))
  cleanup = () => {
    act(() => root.unmount())
    container.remove()
    cleanup = null
  }
  await settle()
  const authorBox = () =>
    [...container.querySelectorAll('label')]
      .find((label) => label.textContent?.startsWith('Author name'))
      ?.querySelector('input') ?? null
  const download = () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Download')!
  const deleteButton = () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Delete this set')!
  return { container, authorBox, download, deleteButton }
}

// The one file downloaded, as text by path.
async function unzip(blobs: Blob[]): Promise<Record<string, string>> {
  expect(blobs).toHaveLength(1)
  const files = unzipSync(new Uint8Array(await blobs[0].arrayBuffer()))
  return Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, strFromU8(bytes)]))
}

async function type(input: HTMLInputElement, value: string) {
  // React tracks the value it last set, so set it the way the browser does.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })))
  await settle()
}

describe('the author name on the Export page', () => {
  it('starts empty and exports without an author', async () => {
    const { authorBox, download } = await render()
    expect(authorBox()?.value).toBe('')
    await act(async () => download().click())
    await settle()
    const manifest = (await unzip(downloads))['imsmanifest.xml']
    expect(manifest).toContain('<metadata>\n<schema>IMS Content</schema>\n<schemaversion>1.1.3</schemaversion>\n</metadata>')
    expect(manifest).not.toContain('<lom')
  })

  it('waits for the remembered name before a download can start', async () => {
    await db.settings.put({ key: 'exportAuthor', value: 'Ana Ruiz' })
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = db.settings.get.bind(db.settings)
    vi.spyOn(db.settings, 'get').mockImplementation((async (key: string) => {
      await held
      return read(key)
    }) as typeof db.settings.get)
    const page = await render()
    expect(page.download().disabled).toBe(true)
    release()
    await settle()
    expect(page.download().disabled).toBe(false)
    expect(page.authorBox()?.value).toBe('Ana Ruiz')
  })

  it('starts with no name when the remembered one cannot be read', async () => {
    vi.spyOn(db.settings, 'get').mockRejectedValue(new Error('IndexedDB is unavailable'))
    const page = await render()
    expect(page.download().disabled).toBe(false)
    expect(page.authorBox()?.value).toBe('')
  })

  it('is remembered in this browser and named in the download', async () => {
    let page = await render()
    await type(page.authorBox()!, 'Ana Ruiz')
    expect((await db.settings.get('exportAuthor'))?.value).toBe('Ana Ruiz')

    cleanup!()
    page = await render()
    expect(page.authorBox()?.value).toBe('Ana Ruiz')
    await act(async () => page.download().click())
    await settle()
    const files = await unzip(downloads)
    expect(files['imsmanifest.xml']).toContain('\nFN:Ana Ruiz\n')
    const meta = Object.entries(files).find(([path]) => path.endsWith('assessment_meta.xml'))![1]
    expect(meta).toContain('&lt;p&gt;Question author: Ana Ruiz&lt;/p&gt;')
  })
})

// Another tab writes the set's questions and holds its lock meanwhile (LT-74);
// deleting it here would leave that tab writing questions for no set (LT-82).
describe('a set being written in another tab', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('says so and cannot be deleted', async () => {
    const locks = new FakeLocks()
    vi.stubGlobal('navigator', { locks })
    void locks.request('generation:set', () => new Promise(() => {}))
    await db.sets.update('set', { status: 'generating' })
    const { container, deleteButton } = await render('review')
    expect(container.textContent).toContain('Questions are being written in another tab.')
    expect(deleteButton().disabled).toBe(true)
    expect(container.querySelector('.page-foot')?.textContent).toContain('Being written in another tab. Delete it once its questions are written.')
    locks.closeTab()
  })

  // As on an http address other than localhost: no tab can tell, so the page
  // is as it was before LT-82.
  it('can still be deleted without Web Locks', async () => {
    vi.stubGlobal('navigator', {})
    await db.sets.update('set', { status: 'generating' })
    const { container, deleteButton } = await render('review')
    expect(container.textContent).not.toContain('being written in another tab')
    expect(deleteButton().disabled).toBe(false)
  })

  // The run may start after this tab opened the app, so nothing else here
  // waits on its lock.
  it('is marked interrupted when the tab writing it closes', async () => {
    const locks = new FakeLocks()
    vi.stubGlobal('navigator', { locks })
    void locks.request('generation:set', () => new Promise(() => {}))
    await db.sets.update('set', { status: 'generating' })
    const { container, deleteButton } = await render('review')
    expect(deleteButton().disabled).toBe(true)
    locks.closeTab()
    await settle()
    expect(container.textContent).toContain('Interrupted when the app was closed.')
    expect(container.textContent).not.toContain('being written in another tab')
    expect(deleteButton().disabled).toBe(false)
  })

  // The run starts in the other tab as this one shows the set, before the
  // set's new status reaches this page.
  it('is kept when Delete is pressed just as the run starts', async () => {
    const locks = new FakeLocks()
    vi.stubGlobal('navigator', { locks })
    void locks.request('generation:set', () => new Promise(() => {}))
    vi.stubGlobal('confirm', () => true)
    const { container, deleteButton } = await render('review')
    await act(async () => deleteButton().click())
    await settle()
    expect(container.textContent).toContain('“Leaf quiz” is being written in another tab. Delete it once its questions are written.')
    expect(await db.sets.get('set')).toBeDefined()
    expect(await db.items.get('item')).toBeDefined()
    locks.closeTab()
  })
})

describe('the link to the source page', () => {
  const copyLink = (container: HTMLElement) =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Copy link')

  it('copies a link that opens the app on a set’s one LibreTexts page', async () => {
    await db.sources.put({
      id: 's', kind: 'page', title: '4.2: La profecía de la gitana', library: 'human',
      url: 'https://human.libretexts.org/Bookshelves/Languages/Spanish/04/4.02', license: null,
      pages: [{ title: '4.2: La profecía de la gitana', url: null, pageId: '378488', paragraphs: [] }], createdAt: 1,
    })
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { container } = await render('review')
    await settle()
    await act(async () => copyLink(container)!.click())
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/?page=human-378488`)
  })

  it.each([
    ['pasted text', { kind: 'paste' as const, library: null, pages: [] }],
    ['a whole chapter', {
      kind: 'section' as const, library: 'human',
      pages: [
        { title: '4.1', url: null, pageId: '378487', paragraphs: [] },
        { title: '4.2', url: null, pageId: '378488', paragraphs: [] },
      ],
    }],
    ['a page with no page id', { kind: 'page' as const, library: 'human', pages: [{ title: '4.2', url: null, pageId: null, paragraphs: [] }] }],
  ])('offers no link for %s', async (_, source) => {
    await db.sources.put({ id: 's', title: 'Source', url: null, license: null, createdAt: 1, ...source })
    const { container } = await render('review')
    await settle()
    expect(container.textContent).toContain('Source')
    expect(copyLink(container)).toBeUndefined()
  })
})

describe('the answer keys to check', () => {
  const KEY_NOTE = 'An automatic answer check disagrees with the answer key: it judged the statement false.'
  const BLANK_NOTE = 'An automatic check filled the blank with “chloroplast”, not “chlorophyll”: students may give an answer other than the key and be marked wrong.'
  const REVIEWER_NOTE = 'The stem could name the pigment.'
  const MATCHING_NOTE = 'Matching answer keys from the in-browser model are often wrong: check each pair.'
  const draftOf = (type: string) => SAMPLE_DRAFTS.find((draft) => draft.item_type === type)!

  async function show(questions: { type: string; critique?: string[] }[], provider?: 'local' | 'openai') {
    await db.items.clear()
    const set = await db.sets.get('set')
    await db.sets.put({ ...set!, provider: provider as 'local' })
    await db.items.bulkPut(
      questions.map(({ type, critique = [] }, position) => ({
        id: `item-${position}`, setId: 'set', position, status: 'draft' as const, draft: draftOf(type), sourcePageIndex: 0,
        critique, createdAt: 1, updatedAt: 1,
      })),
    )
    const { container } = await render('review')
    await settle()
    const cards = [...container.querySelectorAll<HTMLElement>('li.item')]
    return { container, cards }
  }
  const keyChecks = (card: HTMLElement) =>
    card.querySelector('.key-check') ? [...card.querySelectorAll('.key-check li')].map((li) => li.textContent) : null

  it('lists the answer check’s notes first and unfolded, and the other notes folded under Notes', async () => {
    const { cards } = await show([{ type: 'true_false', critique: [REVIEWER_NOTE, KEY_NOTE] }], 'local')
    const [card] = cards
    expect(card.querySelector('.item-head')!.textContent).toContain('Check the answer key')
    expect(keyChecks(card)).toEqual([KEY_NOTE])
    expect(card.querySelector('.key-check')!.closest('details')).toBeNull()
    const notes = card.querySelector('details.critique')!
    expect(notes.querySelector('summary')!.textContent).toBe('Notes (1)')
    expect(notes.hasAttribute('open')).toBe(false)
    expect([...notes.querySelectorAll('li')].map((li) => li.textContent)).toEqual([REVIEWER_NOTE])
    expect(card.querySelector('.key-check')!.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows no badge or Notes for a question without notes', async () => {
    const { cards } = await show([{ type: 'fill_in_blank' }], 'local')
    expect(cards[0].textContent).not.toContain('Check the answer key')
    expect(keyChecks(cards[0])).toBeNull()
    expect(cards[0].querySelector('details.critique')).toBeNull()
  })

  it.each([
    ['in the browser', 'local' as const, [MATCHING_NOTE]],
    ['by an unrecorded engine', undefined, [MATCHING_NOTE]],
    ['on OpenAI', 'openai' as const, null],
  ])('marks a matching question written %s by its type alone', async (_, provider, expected) => {
    const { cards } = await show([{ type: 'matching' }], provider)
    expect(keyChecks(cards[0])).toEqual(expected)
  })

  it('does not mark a dropdowns question by its type', async () => {
    const { cards } = await show([{ type: 'dropdowns' }], 'local')
    expect(keyChecks(cards[0])).toBeNull()
  })

  it('counts the marked questions in the set, saying every key still needs checking', async () => {
    const { container } = await show(
      [{ type: 'fill_in_blank', critique: [BLANK_NOTE] }, { type: 'matching' }, { type: 'true_false', critique: [REVIEWER_NOTE] }],
      'local',
    )
    const count = container.querySelector('.key-check-count')!.textContent
    expect(count).toContain('2 of 3 questions are marked “Check the answer key”')
    expect(count).toContain('check every answer key before you export')
  })

  it('counts one marked question in the singular', async () => {
    const { container } = await show([{ type: 'matching' }, { type: 'essay' }], 'local')
    expect(container.querySelector('.key-check-count')!.textContent).toContain('1 of 2 questions is marked')
  })

  it('says nothing about marked questions when none is marked', async () => {
    const { container } = await show([{ type: 'true_false', critique: [REVIEWER_NOTE] }], 'openai')
    expect(container.querySelector('.key-check-count')).toBeNull()
    expect(container.textContent).not.toContain('Check the answer key')
  })
})
