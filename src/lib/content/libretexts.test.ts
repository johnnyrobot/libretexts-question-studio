import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPageInfo, getTree, parsePageLink } from './libretexts'

// What LibreTexts' proxy answers, with fetch stubbed: nothing here reaches the
// network.

// Deki's answer to an anonymous /tree call on 2026-10-26 (HTTP 403), recorded
// on LT-44.
const MISSING_TOKEN = JSON.stringify({
  arguments: { '@count': '1', argument: 'missing required token' },
  exception: 'MindTouch.Deki.Auth.Exceptions.TokenValidationFailedException',
  message: 'The request failed API token validation, missing required token',
  resource: 'System.API.Error.developer-token-validation-failed',
})

const TOKEN_REFUSED =
  "LibreTexts would not share that page right now (it asked for an access token). This is on LibreTexts' side; try again later."
const REFUSED =
  'LibreTexts would not share that page (it needs permission to read it). The page may not be public; if it is, try again later.'
const NOT_FOUND = 'LibreTexts could not find that page.'

function answer(body: string, status = 200) {
  const fetch = vi.fn(async () => new Response(body, { status }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a page LibreTexts will not share', () => {
  it('says LibreTexts asked for a token when the proxy passes the refusal on', async () => {
    answer(MISSING_TOKEN)
    await expect(getTree('chem', '123')).rejects.toThrow(TOKEN_REFUSED)
  })

  it('says LibreTexts asked for a token when the refusal comes with its 403', async () => {
    answer(MISSING_TOKEN, 403)
    await expect(getTree('chem', '123')).rejects.toThrow(TOKEN_REFUSED)
  })

  it.each([401, 403])('says LibreTexts would not share the page on a %i that names no token', async (status) => {
    answer('<html><body>Forbidden</body></html>', status)
    await expect(getPageInfo({ library: 'chem', id: '123' })).rejects.toThrow(REFUSED)
  })

  // Made up in Deki's shape: no such refusal was recorded.
  it.each([
    ['exception', 'MindTouch.Deki.Auth.Exceptions.AccessDeniedException'],
    ['resource', 'System.API.Error.permission-validation-failed'],
  ])('says LibreTexts would not share the page when the proxy passes on the %s %s', async (field, name) => {
    answer(JSON.stringify({ [field]: name, message: 'The request was refused.' }))
    await expect(getPageInfo({ library: 'chem', id: '123' })).rejects.toThrow(REFUSED)
  })
})

describe('a page that is not there', () => {
  it('still says LibreTexts could not find it on a 404', async () => {
    answer(JSON.stringify({ message: 'Not Found' }), 404)
    await expect(getPageInfo({ library: 'chem', path: 'Bookshelves/No_Such_Book' })).rejects.toThrow(NOT_FOUND)
  })

  it('still says LibreTexts could not find it when the proxy passes on another exception', async () => {
    // Made up in Deki's shape, like the refusals above.
    answer(JSON.stringify({ exception: 'MindTouch.Dream.DreamNotFoundException', message: 'Page not found' }))
    await expect(getTree('chem', '999999')).rejects.toThrow(NOT_FOUND)
  })
})

describe('a page named by a link to the app', () => {
  it('reads <library>-<id>', () => {
    expect(parsePageLink('human-378488')).toEqual({ library: 'human', id: '378488' })
  })

  it('ignores case and surrounding spaces', () => {
    expect(parsePageLink(' Chem-501189 ')).toEqual({ library: 'chem', id: '501189' })
  })

  it('names the libraries when the library is not one of them', () => {
    expect(() => parsePageLink('history-378488')).toThrow(
      '“history” is not a LibreTexts library. Use one of bio, biz, chem, eng, espanol, geo, human, k12, math, med, phys, socialsci, stats, workforce.',
    )
  })

  it.each(['human', 'human-', '378488', 'human-37a8', 'human-378488-2', ''])('says what a page link looks like for %j', (input) => {
    expect(() => parsePageLink(input)).toThrow(
      'That link does not name a LibreTexts page. A page link ends in ?page=<library>-<page number>, such as ?page=human-378488.',
    )
  })
})
