import { describe, expect, it } from 'vitest'
import { splitForEnhancedFilter } from './enhancedFilter'

describe('splitForEnhancedFilter', () => {
  it('keeps separator lines visible outside memo blocks', () => {
    const result = splitForEnhancedFilter(
      [
        'aaa',
        '-- section',
        '            2026/06/25 木 -- TODAY TODO hold:0 ----------------',
        'bbb keyword',
        '"""',
        '-- memo keyword',
        '"""',
        'ccc',
      ].join('\n'),
      'keyword',
    )

    expect(result.visibleText).toBe(
      ['-- section', '            2026/06/25 木 -- TODAY TODO hold:0 ----------------', 'bbb keyword'].join(
        '\n',
      ),
    )
    expect(result.parkedText).toBe(['aaa', '"""', '-- memo keyword', '"""', 'ccc'].join('\n'))
  })
})
