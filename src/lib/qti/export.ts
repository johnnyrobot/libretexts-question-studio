import { db, newId, type StoredExport } from '../storage/db'
import { buildQuizPackage } from './canvas'

// Builds the ADAPT-importable QTI zip for a set and keeps a copy in IndexedDB
// so earlier exports can be downloaded again without regenerating anything.

export async function exportSet(setId: string, includeDrafts: boolean): Promise<StoredExport> {
  const set = await db.sets.get(setId)
  if (!set) throw new Error('That question set no longer exists.')
  const source = await db.sources.get(set.sourceId)
  const items = (await db.items.where('setId').equals(setId).sortBy('position')).filter((item) =>
    includeDrafts ? item.status !== 'rejected' : item.status === 'approved',
  )
  if (items.length === 0) {
    throw new Error(includeDrafts ? 'There are no questions to export.' : 'Approve at least one question to export.')
  }
  const description = source?.url
    ? `Questions generated from ${source.title} (${source.url}). Review before assigning.`
    : `Questions generated from ${source?.title ?? 'a LibreTexts source'}. Review before assigning.`
  const zip = buildQuizPackage([
    { id: set.id, title: set.title, description, items: items.map((item) => ({ id: item.id, draft: item.draft })) },
  ])
  const record: StoredExport = {
    id: newId(),
    setId,
    filename: `${slug(set.title)}-adapt-qti.zip`,
    itemIds: items.map((item) => item.id),
    zip: new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
    createdAt: Date.now(),
  }
  await db.exports.add(record)
  return record
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function slug(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'questions'
  )
}
