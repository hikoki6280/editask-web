import { describe, expect, it } from 'vitest'
import {
  formatEstimateMinutes,
  isCompletedTaskLine,
  isStartedTaskLine,
  parseEstimateMinutes,
  shiftTaskDateLine,
  summarizeTodayTasks,
  toggleTaskStartEndLine,
  toggleTaskStartEndLineWithNext,
} from './editaskText'

describe('toggleTaskStartEndLine', () => {
  it('cycles start, end, and clear for a task line', () => {
    const initial = '            2026/06/25 木 task'
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
      isCompletedTaskLine('09:10 10:20 2026/06/25 木 task', {
        year: 2026,
        month: 6,
        day: 25,
      }),
    ).toBe(true)
  })
})

describe('isStartedTaskLine', () => {
  it('detects a started task without an end time', () => {
    expect(isStartedTaskLine('09:10       2026/06/26 金 task')).toBe(true)
    expect(isStartedTaskLine('09:10 10:20 2026/06/26 金 task')).toBe(false)
    expect(isStartedTaskLine('            2026/06/26 金 task')).toBe(false)
  })
})

describe('shiftTaskDateLine', () => {
  it('moves a task date and updates the weekday', () => {
    const result = shiftTaskDateLine('            2026/06/25 木 task', 1, {
      year: 2026,
      month: 6,
      day: 25,
    })

    expect(result.changed).toBe(true)
    expect(result.line).toContain('2026/06/26 金')
  })

  it('does not move a task date before today', () => {
    const result = shiftTaskDateLine('            2026/06/26 金 task', -1, {
      year: 2026,
      month: 6,
      day: 26,
    })

    expect(result.changed).toBe(false)
    expect(result.line).toContain('2026/06/26 金')
  })
})

describe('summarizeTodayTasks', () => {
  it('counts today remaining tasks excluding separators and memo blocks', () => {
    const summary = summarizeTodayTasks(
      [
        '            2026/06/26 金 task',
        '09:10 10:20 2026/06/26 金 done',
        '            2026/06/26 金 -- section',
        '            2026/06/27 土 future',
        '"""',
        '            2026/06/26 金 memo task',
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

describe('formatEstimateMinutes', () => {
  it('formats estimate minutes for the status bar', () => {
    expect(formatEstimateMinutes(0)).toBe('0分')
    expect(formatEstimateMinutes(10)).toBe('10分')
    expect(formatEstimateMinutes(60)).toBe('1時間0分')
    expect(formatEstimateMinutes(130)).toBe('2時間10分')
  })
})

describe('toggleTaskStartEndLineWithNext', () => {
  it('creates the next routine line when a rep task ends', () => {
    const result = toggleTaskStartEndLineWithNext(
      '09:10       2026/06/25 木 task rep:7',
      '10:20',
    )

    expect(result.ended).toBe(true)
    expect(result.line).toContain('09:10 10:20')
    expect(result.nextLine).toContain('2026/07/02')
    expect(result.nextLine).toContain('task rep:7')
    expect(result.nextLine).not.toContain('09:10')
  })

  it('moves the next routine date forward to a days weekday', () => {
    const result = toggleTaskStartEndLineWithNext(
      '09:10       2026/06/25 木 task rep:1 days:月',
      '10:20',
    )

    expect(result.nextLine).toContain('2026/06/29')
  })

  it('moves the next routine date to the requested day in the next month', () => {
    const result = toggleTaskStartEndLineWithNext(
      '09:10       2026/06/25 木 task rep:1 days:15',
      '10:20',
    )

    expect(result.nextLine).toContain('2026/07/15')
  })
})
