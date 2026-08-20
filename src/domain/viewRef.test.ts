import { describe, expect, it } from 'vitest'
import { matchesViewSelector, parseViewRef } from './viewRef'

describe('parseViewRef', () => {
  it('parses recursive and combined view selectors', () => {
    expect(parseViewRef('home/*')).toEqual(['home/*'])
    expect(parseViewRef('{fileA,home/*,work/today.txt}')).toEqual(['fileA', 'home/*', 'work/today'])
  })

  it('rejects unsupported wildcard placement', () => {
    expect(parseViewRef('home/*/today')).toBeUndefined()
    expect(parseViewRef('{fileA,}')).toBeUndefined()
  })
})

describe('matchesViewSelector', () => {
  it('matches descendants recursively and excludes the directory itself', () => {
    expect(matchesViewSelector('home/main', 'home/*')).toBe(true)
    expect(matchesViewSelector('home/project/task', 'home/*')).toBe(true)
    expect(matchesViewSelector('home', 'home/*')).toBe(false)
  })
})
