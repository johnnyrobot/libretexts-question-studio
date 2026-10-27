// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { strFromU8, unzipSync } from 'fflate'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAMPLE_DRAFTS } from '../lib/qti/fixtures'
import { db } from '../lib/storage/db'
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

async function render() {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<SetView setId="set" tab="export" />))
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
  return { authorBox, download }
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
