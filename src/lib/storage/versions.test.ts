import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { SAMPLE_DRAFTS } from '../qti/fixtures'
import { db, type StoredItem } from './db'
import { discardNewVersion, keepNewVersion } from './versions'

const [first, second] = SAMPLE_DRAFTS
const concept = (label: string) => ({ label, description: label, source_paragraphs: [0], quantitative: false })
const item: StoredItem = {
  id: 'q', setId: 'set', position: 0, status: 'approved', draft: first, sourcePageIndex: 0,
  critique: ['On the current version'], concept: concept('Current'), createdAt: 1, updatedAt: 1,
  newVersion: { draft: second, critique: ['On the new version'], concept: concept('New'), createdAt: 2 },
}

describe('choosing between a question’s versions', () => {
  beforeEach(async () => {
    await db.items.clear()
    await db.items.put(item)
  })

  it('keeps the new version as a question that needs review', async () => {
    await keepNewVersion('q')
    const kept = (await db.items.get('q'))!
    expect(kept).toMatchObject({ draft: second, critique: ['On the new version'], concept: concept('New'), status: 'draft', sourcePageIndex: 0 })
    expect(kept.newVersion).toBeUndefined()
    expect(kept.updatedAt).toBeGreaterThan(1)
  })

  it('goes back to the current version, as it was', async () => {
    await discardNewVersion('q')
    const { newVersion: _, ...current } = item
    void _
    expect(await db.items.get('q')).toEqual(current)
  })

  it('changes nothing on a question with no new version', async () => {
    const { newVersion: _, ...plain } = item
    void _
    await db.items.put(plain)
    await keepNewVersion('q')
    await keepNewVersion('gone')
    await discardNewVersion('gone')
    expect(await db.items.get('q')).toEqual(plain)
  })
})
