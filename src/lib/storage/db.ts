import Dexie, { type EntityTable } from 'dexie'
import type { Paragraph } from '../content/normalize'
import type { QuestionDraft } from '../generation/schema'

// Everything the app knows lives in this browser's IndexedDB. There is no
// account and no server copy, so closing the tab never loses a question set.

export interface SourcePage {
  title: string
  url: string | null
  pageId: string | null
  paragraphs: Paragraph[]
}

export interface SourceLicense {
  code: string
  label: string
  version: string | null
}

export interface StoredSource {
  id: string
  kind: 'page' | 'section' | 'book' | 'paste'
  title: string
  library: string | null
  url: string | null
  license: SourceLicense | null
  pages: SourcePage[]
  createdAt: number
}

export type ItemStatus = 'draft' | 'approved' | 'rejected'

export interface StoredItem {
  id: string
  setId: string
  position: number
  status: ItemStatus
  draft: QuestionDraft
  // The page the item's citations point into, so review can show the source.
  sourcePageIndex: number
  critique: string[]
  createdAt: number
  updatedAt: number
}

export interface StoredSet {
  id: string
  title: string
  sourceId: string
  provider: 'local' | 'openai'
  model: string
  status: 'generating' | 'complete' | 'failed' | 'cancelled'
  error: string | null
  requested: { itemTypes: string[]; count: number }
  createdAt: number
  updatedAt: number
}

export interface StoredExport {
  id: string
  setId: string
  filename: string
  itemIds: string[]
  zip: Blob
  createdAt: number
}

// Normalised page text cached by library + page id, so re-using a book or
// generating more questions does not refetch it.
export interface CachedPage {
  key: string
  title: string
  url: string
  paragraphs: Paragraph[]
  fetchedAt: number
}

export interface StoredSetting {
  key: string
  value: unknown
}

export class AppDatabase extends Dexie {
  sources!: EntityTable<StoredSource, 'id'>
  sets!: EntityTable<StoredSet, 'id'>
  items!: EntityTable<StoredItem, 'id'>
  exports!: EntityTable<StoredExport, 'id'>
  settings!: EntityTable<StoredSetting, 'key'>
  pages!: EntityTable<CachedPage, 'key'>

  constructor(name = 'assessment-ai') {
    super(name)
    this.version(1).stores({
      sources: 'id, createdAt',
      sets: 'id, sourceId, createdAt',
      items: 'id, setId, [setId+position], status',
      exports: 'id, setId, createdAt',
      settings: 'key',
      pages: 'key, fetchedAt',
    })
  }
}

export const db = new AppDatabase()

export function newId(): string {
  return crypto.randomUUID()
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key)
  return row === undefined ? fallback : (row.value as T)
}

export async function putSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value })
}

export async function deleteSet(setId: string): Promise<void> {
  await db.transaction('rw', db.sets, db.items, db.exports, async () => {
    await db.items.where('setId').equals(setId).delete()
    await db.exports.where('setId').equals(setId).delete()
    await db.sets.delete(setId)
  })
}

// Ask the browser not to evict our data under storage pressure. Model weights
// cached by the local runtime share this origin's quota.
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted()) return true
  return navigator.storage.persist()
}
