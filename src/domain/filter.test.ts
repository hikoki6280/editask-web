import { describe, expect, it } from 'vitest'
import { splitForFilter } from './filter'

const THU = '\u6728'

describe('splitForFilter', () => {
  it('keeps separator lines visible outside memo blocks', () => {
    const section = `            2026/06/25 ${THU} -- TODAY TODO hold:0 ----------------`
    const result = splitForFilter(
      [
        'aaa',
        '-- section',
        section,
        'bbb keyword',
        '"""',
        '-- memo keyword',
        '"""',
        'ccc',
      ].join('\n'),
      'keyword',
    )

    expect(result.visibleText).toBe(['-- section', section, 'bbb keyword'].join('\n'))
    expect(result.parkedText).toBe(['aaa', '"""', '-- memo keyword', '"""', 'ccc'].join('\n'))
  })
})
