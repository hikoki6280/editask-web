export type FileQuickSearchCandidate = {
  kind: 'file' | 'folder'
  value: string
  label: string
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP')
}

function scoreToken(text: string, token: string): number | undefined {
  if (text === token) return 2_000
  if (text.startsWith(token)) return 1_800

  const boundaryIndex = text.split('/').findIndex((part) => part.startsWith(token))
  if (boundaryIndex >= 0) return 1_400 - boundaryIndex * 10

  const substringIndex = text.indexOf(token)
  if (substringIndex >= 0) return 1_000 - substringIndex

  let cursor = 0
  let gaps = 0
  for (const char of token) {
    const index = text.indexOf(char, cursor)
    if (index < 0) return undefined
    gaps += index - cursor
    cursor = index + 1
  }
  return 500 - Math.min(gaps, 400)
}

function scoreCandidate(candidate: FileQuickSearchCandidate, query: string): number | undefined {
  const tokens = normalize(query)
    .replace(/[{}*,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.length === 0) return 0

  const text = normalize(candidate.value.replace(/\/\*$/, ''))
  return tokens.reduce<number | undefined>((total, token) => {
    if (total === undefined) return undefined
    const score = scoreToken(text, token)
    return score === undefined ? undefined : total + score
  }, 0)
}

export function buildFileQuickSearchCandidates(fileNames: string[]): FileQuickSearchCandidate[] {
  const candidates: FileQuickSearchCandidate[] = []
  const folders = new Set<string>()

  for (const name of fileNames) {
    candidates.push({ kind: 'file', value: name, label: name })
    const parts = name.split('/').filter(Boolean)
    for (let index = 1; index < parts.length; index += 1) {
      folders.add(parts.slice(0, index).join('/'))
    }
  }

  for (const path of folders) {
    candidates.push({ kind: 'folder', value: `${path}/*`, label: `${path}/` })
  }
  return candidates
}

export function quickSearchFiles(
  candidates: FileQuickSearchCandidate[],
  query: string,
  limit = 8,
): FileQuickSearchCandidate[] {
  return candidates
    .flatMap((candidate) => {
      const score = scoreCandidate(candidate, query)
      return score === undefined ? [] : [{ candidate, score }]
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.candidate.label.localeCompare(b.candidate.label, 'ja') ||
        a.candidate.kind.localeCompare(b.candidate.kind),
    )
    .slice(0, limit)
    .map(({ candidate }) => candidate)
}
