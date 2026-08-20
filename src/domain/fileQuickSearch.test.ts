import { describe, expect, it } from 'vitest'
import { buildFileQuickSearchCandidates, quickSearchFiles } from './fileQuickSearch'

const candidates = buildFileQuickSearchCandidates(['home/main', 'home/project/today', 'work/today'])

describe('quickSearchFiles', () => {
  it('offers directories as recursive view candidates', () => {
    expect(candidates).toContainEqual({ kind: 'folder', value: 'home/*', label: 'home/' })
  })

  it('matches space-separated words without requiring their order', () => {
    expect(quickSearchFiles(candidates, 'today work')[0]).toMatchObject({ value: 'work/today' })
  })

  it('matches characters in order when letters are omitted', () => {
    expect(quickSearchFiles(candidates, 'hm')).toContainEqual(
      expect.objectContaining({ value: 'home/main' }),
    )
  })
})
