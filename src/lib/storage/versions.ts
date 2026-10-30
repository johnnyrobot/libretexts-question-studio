import { db } from './db'

// A new version of a question (writeNewVersion in pipeline.ts) waits beside
// the current one until the instructor keeps one of them. The page it was
// written from stays the same, so the question's credits do too.

// The new version replaces the current one and, being unread, needs review.
export async function keepNewVersion(itemId: string): Promise<void> {
  await db.transaction('rw', db.items, async () => {
    const item = await db.items.get(itemId)
    if (!item?.newVersion) return
    const { draft, critique, concept } = item.newVersion
    await db.items.update(itemId, { draft, critique, concept, status: 'draft', newVersion: undefined, updatedAt: Date.now() })
  })
}

export async function discardNewVersion(itemId: string): Promise<void> {
  await db.items.update(itemId, { newVersion: undefined })
}
