import { describe, expect, it } from 'vitest'
import { pageLinkFromRoute, pageLinkRoute } from './router'

describe('a link that opens a LibreTexts page', () => {
  it.each([
    ['?page=human-378488', '/page/human-378488'],
    ['?human-378488', '/page/human-378488'],
    ['?page=human-378488&utm_source=slack', '/page/human-378488'],
    ['?history-378488', '/page/history-378488'],
    ['?page=nonsense', '/page/nonsense'],
  ])('turns %s into the route %s', (search, route) => {
    expect(pageLinkRoute(search)).toBe(route)
  })

  it.each(['', '?', '?utm_source=slack', '?debug', '?human-378488&debug'])('leaves %j alone', (search) => {
    expect(pageLinkRoute(search)).toBeNull()
  })

  it('gives the route back the page exactly as the link had it', () => {
    expect(pageLinkFromRoute(pageLinkRoute('?page=human-378488')!)).toBe('human-378488')
    expect(pageLinkFromRoute(pageLinkRoute('?page=a%2Fb%20c')!)).toBe('a/b c')
    expect(pageLinkFromRoute(pageLinkRoute('?page=')!)).toBe('')
  })

  it('finds no page in other routes', () => {
    expect(pageLinkFromRoute('/')).toBeUndefined()
    expect(pageLinkFromRoute('/new/abc')).toBeUndefined()
  })

  it('does not fail on a route edited by hand into bad percent-encoding', () => {
    expect(pageLinkFromRoute('/page/%E0')).toBe('%E0')
  })
})
