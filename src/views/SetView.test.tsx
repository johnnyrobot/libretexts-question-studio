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
