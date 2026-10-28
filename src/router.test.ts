import { describe, expect, it } from 'vitest'
import { pageLinkAddress, pageLinkFor, pageLinkFromRoute } from './router'

const APP = 'https://qtistudio.libretexts.dev/'

describe('a link that opens a LibreTexts page', () => {
  it.each([
    ['?page=human-378488', '#/page/human-378488'],
    ['?human-378488', '#/page/human-378488'],
    ['?page=human-378488&utm_source=slack', '#/page/human-378488'],
    ['?human-378488&fbclid=IwAR0abc', '#/page/human-378488'],
    ['?utm_source=slack&human-378488', '#/page/human-378488'],
    ['?page=human-378488#/library', '#/page/human-378488'],
    ['?history-378488', '#/page/history-378488'],
    ['?page=nonsense', '#/page/nonsense'],
    ['?page=a%2Fb%20c', '#/page/a%2Fb%20c'],
  ])('moves %s to the route in %s', (query, route) => {
    expect(pageLinkAddress(APP + query)).toBe(APP + route)
  })

  it('keeps the path the app is served from', () => {
    expect(pageLinkAddress('https://example.org/apps/qs/?human-1')).toBe('https://example.org/apps/qs/#/page/human-1')
  })

  it('stays on the same site when the address has a doubled slash', () => {
    expect(pageLinkAddress('https://qtistudio.libretexts.dev//?page=human-1')).toBe(
      'https://qtistudio.libretexts.dev//#/page/human-1',
    )
  })

  it.each(['', '?', '?utm_source=slack', '?debug', '?human-378488=1', '?human-1&chem-2', '#/page/human-1', '#/library?page=human-1'])(
    'leaves %j alone',
    (suffix) => {
      expect(pageLinkAddress(APP + suffix)).toBeNull()
    },
  )

  it('gives the page back from the route exactly as the link had it', () => {
    expect(pageLinkFromRoute('/page/human-378488')).toBe('human-378488')
    expect(pageLinkFromRoute('/page/a%2Fb%20c')).toBe('a/b c')
    expect(pageLinkFromRoute('/page/')).toBe('')
  })

  it('finds no page in other routes', () => {
    expect(pageLinkFromRoute('/')).toBeUndefined()
    expect(pageLinkFromRoute('/new/abc')).toBeUndefined()
  })

  it('does not fail on a route edited by hand into bad percent-encoding', () => {
    expect(pageLinkFromRoute('/page/%E0')).toBe('%E0')
  })
})

describe('a link to share a LibreTexts page', () => {
  it.each([
    [APP + '#/new', 'https://qtistudio.libretexts.dev/?page=human-378488'],
    ['http://localhost:5173/?page=bio-1#/page/bio-1', 'http://localhost:5173/?page=human-378488'],
    ['https://example.org/apps/qs/#/set/abc', 'https://example.org/apps/qs/?page=human-378488'],
  ])('from %s opens the app on the page: %s', (here, link) => {
    expect(pageLinkFor('human', '378488', here)).toBe(link)
  })

  it('is read back as the same page', () => {
    expect(pageLinkAddress(pageLinkFor('chem', '195199', APP + '#/set/abc'))).toBe(APP + '#/page/chem-195199')
  })
})
