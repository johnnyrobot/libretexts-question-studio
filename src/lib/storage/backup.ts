import { z } from 'zod'
import { parseDraft, ITEM_TYPES } from '../generation/schema'
import { db, type StoredItem, type StoredSet, type StoredSource } from './db'
import { unlessGenerating } from './set-locks'

// Everything lives in one browser, so instructors need a way to move their
// work to another device or keep a copy. A backup is plain JSON: sources,
// sets, and questions. Exported zips and the page cache are rebuilt on demand.

const BACKUP_FORMAT = 'libretexts-question-studio-backup'

interface Backup {
  format: typeof BACKUP_FORMAT
  version: 1
  createdAt: string
  sources: StoredSource[]
  sets: StoredSet[]
  items: StoredItem[]
}

export async function createBackup(): Promise<Blob> {
  const backup: Backup = {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    sources: await db.sources.toArray(),
    sets: await db.sets.toArray(),
    items: await db.items.toArray(),
  }
  return new Blob([JSON.stringify(backup)], { type: 'application/json' })
}

const envelope = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(1),
  sources: z.array(z.object({ id: z.string(), pages: z.array(z.unknown()) }).loose()),
  sets: z.array(z.object({ id: z.string(), sourceId: z.string(), title: z.string() }).loose()),
  items: z.array(
    z
      .object({
        id: z.string(),
        setId: z.string(),
        status: z.enum(['draft', 'approved', 'rejected']),
        draft: z.object({ item_type: z.enum(ITEM_TYPES) }).loose(),
      })
      .loose(),
  ),
})

// Merges a backup into this browser. Records with the same id are replaced, so
// restoring the same file twice is harmless. Every question is re-validated.
export async function restoreBackup(file: File): Promise<{ sets: number; items: number }> {
  let parsed: z.infer<typeof envelope>
  try {
    parsed = envelope.parse(JSON.parse(await file.text()))
  } catch {
    throw new Error('That file is not a Question Studio backup.')
  }
  const items = parsed.items.map((item) => {
    const { item_type, ...payload } = item.draft
    return { ...item, draft: parseDraft(item_type, payload) } as unknown as StoredItem
  })
  // A set being written keeps changing until its run ends, which would undo
  // the restore of it.
  const generating = await unlessGenerating(
    [...parsed.sets.map((set) => set.id), ...parsed.items.map((item) => item.setId)],
    () =>
      db.transaction('rw', db.sources, db.sets, db.items, async () => {
        await db.sources.bulkPut(parsed.sources as unknown as StoredSource[])
        await db.sets.bulkPut(
          (parsed.sets as unknown as StoredSet[]).map((set) =>
            set.status === 'generating' ? { ...set, status: 'cancelled' as const } : set,
          ),
        )
        await db.items.bulkPut(items)
      }),
  )
  if (generating) {
    const title = (await db.sets.get(generating))?.title ?? parsed.sets.find((set) => set.id === generating)?.title
    throw new Error(`${title ? `“${title}”` : 'A set in the backup'} is still being written. Restore the backup once its questions are written.`)
  }
  return { sets: parsed.sets.length, items: items.length }
}
