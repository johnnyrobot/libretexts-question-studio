import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { SAMPLE_DRAFTS } from '../qti/fixtures'
import { createBackup, restoreBackup } from './backup'
import { db } from './db'

describe('backup', () => {
  it('round-trips sets and questions and rejects other files', async () => {
    await db.sources.put({ id: 's', kind: 'paste', title: 'T', library: null, url: null, license: null, pages: [], createdAt: 1 })
    await db.sets.put({
      id: 'set', title: 'Set', sourceId: 's', provider: 'local', model: 'm', status: 'complete', error: null,
      requested: { itemTypes: [], count: 1 }, createdAt: 1, updatedAt: 1,
    })
    await db.items.put({
      id: 'i', setId: 'set', position: 0, status: 'approved', draft: SAMPLE_DRAFTS[0], sourcePageIndex: 0, critique: [],
      createdAt: 1, updatedAt: 1,
    })
    const blob = await createBackup()
    await Promise.all([db.items.clear(), db.sets.clear(), db.sources.clear()])
    const file = new File([await blob.text()], 'backup.json')
    expect(await restoreBackup(file)).toEqual({ sets: 1, items: 1 })
    expect((await db.items.get('i'))?.draft.stem).toBe(SAMPLE_DRAFTS[0].stem)
    await expect(restoreBackup(new File(['{"x":1}'], 'other.json'))).rejects.toThrow(/not a Question Studio backup/)
  })
})
