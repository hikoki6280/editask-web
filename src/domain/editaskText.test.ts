import { describe, expect, it } from 'vitest'
import {
  collectFileRefs,
  formatEstimateMinutes,
  formatWorkForecast,
  isCompletedTaskLine,
  isStartedTaskLine,
  normalizeDocumentText,
  parseEstimateMinutes,
  shiftTaskDateLine,
  summarizeTodayTasks,
  toggleTaskStartEndLine,
  toggleTaskStartEndLineWithNext,
} from './editaskText'

const MON = '\u6708'
const THU = '\u6728'
const FRI = '\u91d1'
const SAT = '\u571f'
const WED = '\u6c34'

describe('toggleTaskStartEndLine', () => {
  it('cycles start, end, and clear for a task line', () => {
    const initial = `            2026/06/25 ${THU} task`
    const started = toggleTaskStartEndLine(initial, '09:10')
    const ended = toggleTaskStartEndLine(started, '10:20')
    const cleared = toggleTaskStartEndLine(ended, '11:30')

    expect(started).toContain('09:10')
    expect(started).not.toContain('10:20')
    expect(ended).toContain('09:10 10:20')
    expect(cleared).toBe(initial)
  })
})

describe('isCompletedTaskLine', () => {
  it('detects ended tasks on or before today', () => {
    expect(
      isCompletedTaskLine(`09:10 10:20 2026/06/25 ${THU} task`, {
        year: 2026,
        month: 6,
        day: 25,
      }),
    ).toBe(true)
  })
})

describe('isStartedTaskLine', () => {
  it('detects a started task without an end time', () => {
    expect(isStartedTaskLine(`09:10       2026/06/26 ${FRI} task`)).toBe(true)
    expect(isStartedTaskLine(`09:10 10:20 2026/06/26 ${FRI} task`)).toBe(false)
    expect(isStartedTaskLine(`            2026/06/26 ${FRI} task`)).toBe(false)
  })
})

describe('shiftTaskDateLine', () => {
  it('moves a task date and updates the weekday', () => {
    const result = shiftTaskDateLine(`            2026/06/25 ${THU} task`, 1, {
      year: 2026,
      month: 6,
      day: 25,
    })

    expect(result.changed).toBe(true)
    expect(result.line).toContain(`2026/06/26 ${FRI}`)
  })

  it('does not move a task date before today', () => {
    const result = shiftTaskDateLine(`            2026/06/26 ${FRI} task`, -1, {
      year: 2026,
      month: 6,
      day: 26,
    })

    expect(result.changed).toBe(false)
    expect(result.line).toContain(`2026/06/26 ${FRI}`)
  })
})

describe('summarizeTodayTasks', () => {
  it('counts today remaining tasks excluding separators and memo blocks', () => {
    const summary = summarizeTodayTasks(
      [
        `            2026/06/26 ${FRI} task`,
        `09:10 10:20 2026/06/26 ${FRI} done`,
        `            2026/06/26 ${FRI} -- section`,
        `            2026/06/27 ${SAT} future`,
        '"""',
        `            2026/06/26 ${FRI} memo task`,
        '"""',
      ].join('\n'),
      { year: 2026, month: 6, day: 26 },
    )

    expect(summary).toEqual({ remaining: 1, completed: 1, estimatedMinutes: 0 })
  })

  it('sums valid m estimates for today remaining tasks', () => {
    const summary = summarizeTodayTasks(
      [
        '            2026/06/26 task m:10m',
        '            2026/06/26 task m:2h',
        '            2026/06/26 task m:2h10m',
        '            2026/06/26 task m:70m',
        '            2026/06/26 task m:1h70m',
        '            2026/06/26 task m:abc',
        '09:10 10:20 2026/06/26 done m:10m',
        '            2026/06/27 future m:10m',
        '"""',
        '            2026/06/26 memo m:10m',
        '"""',
      ].join('\n'),
      { year: 2026, month: 6, day: 26 },
    )

    expect(summary.estimatedMinutes).toBe(10 + 120 + 130 + 70 + 130)
  })
})

describe('parseEstimateMinutes', () => {
  it('parses supported estimate formats', () => {
    expect(parseEstimateMinutes('0m')).toBe(0)
    expect(parseEstimateMinutes('0h10m')).toBe(10)
    expect(parseEstimateMinutes('2h0m')).toBe(120)
    expect(parseEstimateMinutes('70m')).toBe(70)
    expect(parseEstimateMinutes('1h70m')).toBe(130)
  })

  it('rejects unsupported estimate formats', () => {
    expect(parseEstimateMinutes('h10m')).toBeUndefined()
    expect(parseEstimateMinutes('2.5h')).toBeUndefined()
    expect(parseEstimateMinutes('abc')).toBeUndefined()
  })
})

describe('collectFileRefs', () => {
  it('collects local refs and excludes URLs and memo blocks', () => {
    const refs = collectFileRefs(
      [
        '            2026/06/26 task r:projectA',
        '            2026/06/26 task ref:projectB.txt',
        '            2026/06/26 task ref:https://example.com',
        '"""',
        '            2026/06/26 memo r:hidden',
        '"""',
      ].join('\n'),
    )

    expect(refs).toEqual(new Set(['projectA', 'projectB']))
  })
})

describe('formatEstimateMinutes', () => {
  it('formats estimate minutes for the status bar', () => {
    expect(formatEstimateMinutes(0)).toBe('\u0030\u5206')
    expect(formatEstimateMinutes(10)).toBe('\u0031\u0030\u5206')
    expect(formatEstimateMinutes(60)).toBe('\u0031\u6642\u9593\u0030\u5206')
    expect(formatEstimateMinutes(130)).toBe('\u0032\u6642\u9593\u0031\u0030\u5206')
  })
})

describe('formatWorkForecast', () => {
  it('shows the completion time and remaining estimate', () => {
    expect(formatWorkForecast(70, new Date(2026, 5, 26, 20, 0))).toBe('21:10 (残り1時間10分)')
  })

  it('marks a completion time on the following day', () => {
    expect(formatWorkForecast(50, new Date(2026, 5, 26, 23, 20))).toBe('翌日 00:10 (残り50分)')
  })
})

describe('normalizeDocumentText', () => {
  it('removes blank content lines and keeps at most one trailing newline', () => {
    expect(
      normalizeDocumentText(
        [
          '            2026/07/01 task b',
          '',
          '   ',
          '            2026/07/01 task a',
          '',
          '',
        ].join('\n'),
      ),
    ).toBe(`            2026/07/01 ${WED} task a\n            2026/07/01 ${WED} task b\n`)
  })

  it('keeps blank lines inside memo blocks', () => {
    expect(normalizeDocumentText(['"""', 'memo', '', 'body', '"""'].join('\n'))).toBe(
      ['"""', 'memo', '', 'body', '"""'].join('\n'),
    )
  })
})

describe('toggleTaskStartEndLineWithNext', () => {
  it('creates the next routine line when a rep task ends', () => {
    const result = toggleTaskStartEndLineWithNext(`09:10       2026/06/25 ${THU} task rep:7`, '10:20')

    expect(result.ended).toBe(true)
    expect(result.line).toContain('09:10 10:20')
    expect(result.nextLine).toContain('2026/07/02')
    expect(result.nextLine).toContain('task rep:7')
    expect(result.nextLine).not.toContain('09:10')
  })

  it('moves the next routine date forward to a days weekday', () => {
    const result = toggleTaskStartEndLineWithNext(`09:10       2026/06/25 ${THU} task rep:1 days:${MON}`, '10:20')

    expect(result.nextLine).toContain('2026/06/29')
  })

  it('moves the next routine date to the requested day in the next month', () => {
    const result = toggleTaskStartEndLineWithNext(`09:10       2026/06/25 ${THU} task rep:1 days:15`, '10:20')

    expect(result.nextLine).toContain('2026/07/15')
  })
})
