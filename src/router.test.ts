import { describe, expect, it } from 'vitest'
import { pageLinkAddress, pageLinkFromRoute } from './router'

const APP = 'https://qtistudio.libretexts.dev/'

describe('a link that opens a LibreTexts page', () => {
  it.each([
    ['?page=human-378488', '/#/page/human-378488'],
    ['?human-378488', '/#/page/human-378488'],
    ['?page=human-378488&utm_source=slack', '/#/page/human-378488'],
    ['?human-378488&fbclid=IwAR0abc', '/#/page/human-378488'],
    ['?utm_source=slack&human-378488', '/#/page/human-378488'],
    ['?page=human-378488#/library', '/#/page/human-378488'],
    ['?history-378488', '/#/page/history-378488'],
    ['?page=nonsense', '/#/page/nonsense'],
    ['?page=a%2Fb%20c', '/#/page/a%2Fb%20c'],
  ])('moves %s to the route in %s', (query, address) => {
    expect(pageLinkAddress(APP + query)).toBe(address)
  })

  it('keeps the path the app is served from', () => {
    expect(pageLinkAddress('https://example.org/apps/qs/?human-1')).toBe('/apps/qs/#/page/human-1')
  })

  it.each(['', '?', '?utm_source=slack', '?debug', '?human-378488=1', '?human-1&chem-2', '#/page/human-1', '#/library?page=human-1'])(
    'leaves %j alone',
    (rest) => {
      expect(pageLinkAddress(APP + rest)).toBeNull()
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
