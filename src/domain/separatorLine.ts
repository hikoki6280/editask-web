const DATED_LINE_RE =
  /^\s*(?:(?:\d{2}:\d{2}|-)(?:\s+(?:\d{2}:\d{2}|-))?\s+)?\d{4}\/\d{2}\/\d{2}(?:\s+[^\s-]+)?(?:\s+(?<rest>.*))?\s*$/

export function isSeparatorLine(line: string): boolean {
  if (line.trimStart().startsWith('--')) return true

  const match = DATED_LINE_RE.exec(line)
  const rest = match?.groups?.rest ?? ''
  return rest.trimStart().startsWith('--')
}
