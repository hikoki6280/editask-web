import { splitDocumentRegions } from './documentStructure'
import { isSeparatorLine } from './separatorLine'

type Weekday = '月' | '火' | '水' | '木' | '金' | '土' | '日'

export type TaskAttrs = {
  rep?: number
  days?: Set<Weekday>
  daysMonthday?: number
  hold?: number
  holdDow?: Weekday
  ref?: string
  estimateMinutes?: number
}

export type Task = {
  date?: DateOnly
  dow?: Weekday
  start?: string
  end?: string
  desc: string
  attrs: TaskAttrs
  raw?: string
}

export type DateOnly = {
  year: number
  month: number
  day: number
}

export type TodayTaskSummary = {
  remaining: number
  completed: number
  estimatedMinutes: number
}

const LINE_RE =
  /^\s*(?:(?<start>\d{2}:\d{2}|-)(?:\s+(?<end>\d{2}:\d{2}|-))?\s+)?(?<date>\d{4}\/\d{2}\/\d{2})(?:\s+(?<dow>[月火水木金土日]))?(?:\s+(?<rest>.*?))?\s*$/
const TOKEN_RE = /\b(?<key>rep|days|hold|m|ref|r):(?<val>\S+)/g
const DATE_OFFSET_RE = /(?<y>\d{4})\/(?<m>\d{2})\/(?<d>\d{2})(?<off>[+-]\d+)/g
const SHORT_N_RE = /^\s*n(?<off>[+-]\d+)?\s+(?<desc>.+)$/
const SHORT_MMDD_RE = /^\s*(?<m>\d{1,2})\/(?<d>\d{1,2})(?:\s+(?<desc>.*))?$/

const WEEKDAYS: Weekday[] = ['日', '月', '火', '水', '木', '金', '土']

export function todayJst(): DateOnly {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day') }
}

function toDate(date: DateOnly): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day))
}

function fromDate(date: Date): DateOnly {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }
}

function addDays(date: DateOnly, days: number): DateOnly {
  const next = toDate(date)
  next.setUTCDate(next.getUTCDate() + days)
  return fromDate(next)
}

function compareDate(a: DateOnly, b: DateOnly): number {
  return toDate(a).getTime() - toDate(b).getTime()
}

function dateOrdinal(date?: DateOnly): number {
  return date ? Math.floor(toDate(date).getTime() / 86400000) : 1_000_000_000
}

function formatDate(date: DateOnly): string {
  return `${date.year.toString().padStart(4, '0')}/${date.month.toString().padStart(2, '0')}/${date.day
    .toString()
    .padStart(2, '0')}`
}

function parseDate(value: string): DateOnly | undefined {
  const [year, month, day] = value.split('/').map(Number)
  if (!year || !month || !day) return undefined
  const parsed = toDate({ year, month, day })
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    return undefined
  }
  return { year, month, day }
}

function deriveDow(date: DateOnly): Weekday {
  return WEEKDAYS[toDate(date).getUTCDay()]
}

function parseDow(value: string): Weekday | undefined {
  return WEEKDAYS.includes(value as Weekday) ? (value as Weekday) : undefined
}

export function parseEstimateMinutes(value: string): number | undefined {
  const match = /^(?:(?<hours>\d+)h)?(?:(?<minutes>\d+)m)?$/.exec(value)
  if (!match?.groups || (!match.groups.hours && !match.groups.minutes)) return undefined

  const hours = match.groups.hours ? Number(match.groups.hours) : 0
  const minutes = match.groups.minutes ? Number(match.groups.minutes) : 0
  if (!Number.isSafeInteger(hours) || !Number.isSafeInteger(minutes)) return undefined
  return hours * 60 + minutes
}

export function formatEstimateMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}分`
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`
}

function parseAttrs(text: string): TaskAttrs {
  const attrs: TaskAttrs = {}
  for (const match of text.matchAll(TOKEN_RE)) {
    const key = match.groups?.key
    const val = match.groups?.val ?? ''

    if (key === 'rep') {
      const rep = Number(val)
      if (Number.isInteger(rep) && rep >= 1) attrs.rep = rep
    } else if (key === 'days') {
      if (/^\d+$/.test(val)) {
        const monthday = Number(val)
        if (monthday >= 1) attrs.daysMonthday = monthday
      } else {
        const days = new Set<Weekday>()
        let valid = true
        for (const char of val) {
          const dow = parseDow(char)
          if (!dow) valid = false
          else days.add(dow)
        }
        if (valid && days.size > 0) attrs.days = days
      }
    } else if (key === 'hold') {
      if (/^\d+$/.test(val)) {
        attrs.hold = Number(val)
      } else {
        const dow = parseDow(val)
        if (dow) attrs.holdDow = dow
      }
    } else if (key === 'm') {
      attrs.estimateMinutes = parseEstimateMinutes(val)
    } else if (key === 'ref' || key === 'r') {
      attrs.ref = val
    }
  }
  return attrs
}

export function parseTaskLine(line: string): Task {
  const match = LINE_RE.exec(line)
  if (!match?.groups) {
    return { desc: line.trim(), attrs: {}, raw: line.replace(/\r?\n$/, '') }
  }

  const date = parseDate(match.groups.date ?? '')
  const start = match.groups.start && match.groups.start !== '-' ? match.groups.start : undefined
  const end = match.groups.end && match.groups.end !== '-' ? match.groups.end : undefined
  const desc = match.groups.rest ?? ''

  return {
    date,
    dow: match.groups.dow ? parseDow(match.groups.dow) : undefined,
    start,
    end,
    desc,
    attrs: parseAttrs(desc),
  }
}

export function formatTaskLine(task: Task): string {
  if (task.raw !== undefined) return task.raw

  const se =
    task.start || task.end
      ? `${(task.start ?? '').padEnd(5, ' ')} ${(task.end ?? '').padEnd(5, ' ')}`
      : '           '
  const parts = [se]
  if (task.date) parts.push(formatDate(task.date))
  if (task.dow) parts.push(task.dow)
  const desc = task.desc.trim()
  if (desc) parts.push(desc)
  return parts.filter((part) => part !== '').join(' ')
}

function nearestFutureDate(month: number, day: number, today: DateOnly): DateOnly | undefined {
  for (let offset = 0; offset < 5; offset += 1) {
    const candidate = parseDate(
      `${today.year + offset}/${month.toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}`,
    )
    if (candidate && compareDate(candidate, today) >= 0) return candidate
  }
  return undefined
}

function nearestWeekdayDate(today: DateOnly, targetDow: Weekday): DateOnly {
  let current = today
  for (let i = 0; i < 7; i += 1) {
    if (deriveDow(current) === targetDow) return current
    current = addDays(current, 1)
  }
  return today
}

function normalizeToTasks(text: string): Task[] {
  const today = todayJst()
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let lastDate: DateOnly | undefined

  for (let line of lines) {
    line = line.replace(DATE_OFFSET_RE, (...args: unknown[]) => {
      const groups = args.at(-1) as { y: string; m: string; d: string; off: string }
      const base = parseDate(`${groups.y}/${groups.m}/${groups.d}`)
      return base ? formatDate(addDays(base, Number(groups.off))) : String(args[0])
    })

    const stripped = line.trim()
    let converted = false
    const nMatch = SHORT_N_RE.exec(stripped)
    const mmddMatch = SHORT_MMDD_RE.exec(stripped)

    if (nMatch?.groups) {
      const base = nMatch.groups.off ? addDays(today, Number(nMatch.groups.off)) : today
      line = formatTaskLine({ date: base, dow: deriveDow(base), desc: nMatch.groups.desc.trim(), attrs: {} })
      converted = true
    } else if (mmddMatch?.groups?.m && mmddMatch.groups.d) {
      const base = nearestFutureDate(Number(mmddMatch.groups.m), Number(mmddMatch.groups.d), today)
      if (base) {
        line = formatTaskLine({
          date: base,
          dow: deriveDow(base),
          desc: (mmddMatch.groups.desc ?? '').trim(),
          attrs: {},
        })
        converted = true
      }
    }

    if (!converted) {
      const parsed = parseTaskLine(line)
      if (parsed.raw === undefined && parsed.date) {
        line = formatTaskLine({ ...parsed, dow: deriveDow(parsed.date) })
        lastDate = parsed.date
        out.push(line)
        continue
      }
      if (lastDate && stripped) {
        line = formatTaskLine({ date: lastDate, dow: deriveDow(lastDate), desc: stripped, attrs: {} })
      }
    }

    const parsed = parseTaskLine(line)
    if (parsed.raw === undefined && parsed.date) lastDate = parsed.date
    out.push(line)
  }

  return out.map(parseTaskLine)
}

function classifySection(date: DateOnly | undefined, today: DateOnly): number {
  if (!date) return 3
  const compared = compareDate(date, today)
  if (compared === 0) return 0
  return compared > 0 ? 1 : 2
}

function sortTasks(tasks: Task[]): Task[] {
  const today = todayJst()

  const adjusted = tasks.map((task) => {
    if (task.raw !== undefined) return task
    let base: DateOnly | undefined
    if (task.attrs.hold !== undefined) base = addDays(today, task.attrs.hold)
    else if (task.attrs.holdDow) base = nearestWeekdayDate(today, task.attrs.holdDow)
    return base ? { ...task, date: base, dow: deriveDow(base) } : task
  })

  const promoted = adjusted.map((task) => {
    if (task.raw === undefined && task.date && compareDate(task.date, today) < 0 && !task.end) {
      return { ...task, date: today, dow: deriveDow(today) }
    }
    return task
  })

  const normalizedDone = promoted.map((task) => {
    if (task.raw === undefined && task.date && compareDate(task.date, today) > 0 && task.end) {
      return { ...task, date: today, dow: deriveDow(today) }
    }
    return task
  })

  return normalizedDone
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      const sectionA = classifySection(a.task.date, today)
      const sectionB = classifySection(b.task.date, today)
      if (sectionA !== sectionB) return sectionA - sectionB

      const innerA = sectionA === 0 && a.task.end ? 0 : sectionA === 0 ? 1 : 0
      const innerB = sectionB === 0 && b.task.end ? 0 : sectionB === 0 ? 1 : 0
      if (innerA !== innerB) return innerA - innerB

      const dateA = dateOrdinal(a.task.date)
      const dateB = dateOrdinal(b.task.date)
      if (dateA !== dateB) return dateA - dateB

      const descCompare = a.task.desc.trim().localeCompare(b.task.desc.trim(), 'ja')
      if (descCompare !== 0) return descCompare
      return a.index - b.index
    })
    .map(({ task }) => task)
}

function renderTasks(tasks: Task[]): string {
  return tasks.map(formatTaskLine).join('\n')
}

function currentJstTimeText(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date())
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00'
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00'
  return `${hour}:${minute}`
}

export function toggleTaskStartEndLine(line: string, nowText = currentJstTimeText()): string {
  const task = parseTaskLine(line)
  if (task.raw !== undefined) return line

  if (!task.start && !task.end) {
    return formatTaskLine({ ...task, start: nowText })
  }
  if (task.start && !task.end) {
    return formatTaskLine({ ...task, end: nowText })
  }
  return formatTaskLine({ ...task, start: undefined, end: undefined })
}

export function shiftTaskDateLine(
  line: string,
  deltaDays: number,
  today = todayJst(),
): { line: string; changed: boolean } {
  const task = parseTaskLine(line)
  if (task.raw !== undefined || !task.date) return { line, changed: false }

  let nextDate = addDays(task.date, deltaDays)
  if (compareDate(nextDate, today) < 0) nextDate = today
  if (compareDate(nextDate, task.date) === 0) return { line, changed: false }

  return {
    line: formatTaskLine({ ...task, date: nextDate, dow: deriveDow(nextDate), raw: undefined }),
    changed: true,
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function nextMonthDate(base: DateOnly, monthday: number): DateOnly {
  const nextMonth = base.month === 12 ? 1 : base.month + 1
  const nextYear = base.month === 12 ? base.year + 1 : base.year
  return {
    year: nextYear,
    month: nextMonth,
    day: Math.min(monthday, daysInMonth(nextYear, nextMonth)),
  }
}

function nextDateWithAttrs(base: DateOnly, attrs: TaskAttrs): DateOnly | undefined {
  if (!attrs.rep || attrs.rep < 1) return undefined

  let nextDate = addDays(base, attrs.rep)
  if (attrs.daysMonthday !== undefined) {
    return nextMonthDate(nextDate, attrs.daysMonthday)
  }

  const days = attrs.days ?? new Set<Weekday>()
  for (let i = 0; days.size > 0 && i < 14; i += 1) {
    if (days.has(deriveDow(nextDate))) return nextDate
    nextDate = addDays(nextDate, 1)
  }
  return nextDate
}

export type ToggleTaskStartEndResult = {
  line: string
  ended: boolean
  nextLine?: string
}

export function toggleTaskStartEndLineWithNext(
  line: string,
  nowText = currentJstTimeText(),
): ToggleTaskStartEndResult {
  const task = parseTaskLine(line)
  if (task.raw !== undefined) return { line, ended: false }

  if (!task.start && !task.end) {
    return { line: formatTaskLine({ ...task, start: nowText }), ended: false }
  }

  if (task.start && !task.end) {
    const endedTask = { ...task, end: nowText }
    const nextDate = task.date ? nextDateWithAttrs(task.date, task.attrs) : undefined
    const nextLine = nextDate
      ? formatTaskLine({
          ...task,
          date: nextDate,
          dow: deriveDow(nextDate),
          start: undefined,
          end: undefined,
        })
      : undefined

    return {
      line: formatTaskLine(endedTask),
      ended: true,
      nextLine,
    }
  }

  return { line: formatTaskLine({ ...task, start: undefined, end: undefined }), ended: false }
}

export function isCompletedTaskLine(line: string, today = todayJst()): boolean {
  const task = parseTaskLine(line)
  if (task.raw !== undefined || !task.date || !task.end) return false
  return compareDate(task.date, today) <= 0
}

export function isStartedTaskLine(line: string): boolean {
  const task = parseTaskLine(line)
  return task.raw === undefined && Boolean(task.start) && !task.end
}

export function summarizeTodayTasks(text: string, today = todayJst()): TodayTaskSummary {
  let remaining = 0
  let completed = 0
  let estimatedMinutes = 0

  for (const region of splitDocumentRegions(text)) {
    if (region.kind === 'memo') continue

    for (const line of region.text.split(/\r?\n/)) {
      const task = parseTaskLine(line)
      if (task.raw !== undefined || !task.date || compareDate(task.date, today) !== 0) continue
      const separator = isSeparatorLine(line)

      if (task.end) {
        if (!separator) completed += 1
      } else {
        if (!separator) remaining += 1
        estimatedMinutes += task.attrs.estimateMinutes ?? 0
      }
    }
  }

  return { remaining, completed, estimatedMinutes }
}

export function normalizeDocumentText(text: string): string {
  return splitDocumentRegions(text)
    .map((region) => {
      if (region.kind === 'memo' || !region.text.trim()) return region.text
      const sortedText = renderTasks(sortTasks(normalizeToTasks(region.text)))
      return region.text.match(/[\r\n]$/) && sortedText ? `${sortedText}\n` : sortedText
    })
    .join('')
}

export function getRefValueFromLine(line: string): string | undefined {
  const match = /\b(?:ref|r):(?<val>\S*)/.exec(line)
  return match?.groups?.val
}

export function isUrlRef(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value.trim())
}
