import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, deleteEverything, type StoredSet } from './db'
import { FakeLocks } from './fixtures'

describe('deleting everything while a set is being written', () => {
  const set = (id: string, title: string, status: StoredSet['status']): StoredSet => ({
    id, title, sourceId: 's', provider: 'local', model: 'm', status, error: null,
    requested: { itemTypes: [], count: 1 }, createdAt: 1, updatedAt: 1,
  })

  beforeEach(async () => {
    await Promise.all([db.items.clear(), db.sets.clear(), db.sources.clear(), db.exports.clear(), db.pages.clear()])
    await db.sources.put({ id: 's', kind: 'paste', title: 'T', library: null, url: null, license: null, pages: [], createdAt: 1 })
    await db.sets.bulkPut([set('done', 'Stems', 'complete'), set('set', 'Leaf quiz', 'generating')])
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // A tab, this one or another, holds a set's lock while it writes the set's
  // questions (LT-74); clearing under it would leave them orphaned (LT-89).
  it('refuses, naming the set and changing nothing, while a tab writes it', async () => {
    const locks = new FakeLocks()
    vi.stubGlobal('navigator', { locks })
    void locks.request('generation:set', () => new Promise(() => {}))

    expect(await deleteEverything()).toBe('Leaf quiz')
    expect(await db.sets.count()).toBe(2)
    expect(await db.sources.count()).toBe(1)

    locks.closeTab()
    expect(await deleteEverything()).toBeNull()
    expect(await db.sets.count()).toBe(0)
    expect(await db.sources.count()).toBe(0)
  })

  // As on an http address other than localhost: no tab can tell, so it clears
  // as it did before LT-89.
  it('clears everything without Web Locks', async () => {
    vi.stubGlobal('navigator', {})
    expect(await deleteEverything()).toBeNull()
    expect(await db.sets.count()).toBe(0)
  })
})
