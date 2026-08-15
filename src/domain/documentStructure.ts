export type DocumentRegionKind = 'content' | 'memo'

export type DocumentLineKind = 'content' | 'memoDelimiter' | 'memoBody'

export type DocumentRegion = {
  kind: DocumentRegionKind
  text: string
}

export function isMemoDelimiter(line: string): boolean {
  return line.trim() === '"""'
}

export function classifyDocumentLines(text: string): DocumentLineKind[] {
  const lines = text.split(/\r?\n/)
  let inMemo = false

  return lines.map((line) => {
    if (isMemoDelimiter(line)) {
      inMemo = !inMemo
      return 'memoDelimiter'
    }
    return inMemo ? 'memoBody' : 'content'
  })
}

export function splitDocumentRegions(text: string): DocumentRegion[] {
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? ['']
  const normalizedLines = lines.filter((line, index) => line !== '' || index === 0)
  const regions: DocumentRegion[] = []
  let currentKind: DocumentRegionKind = 'content'
  let currentLines: string[] = []
  let inMemo = false

  const flush = () => {
    if (currentLines.length > 0) {
      regions.push({ kind: currentKind, text: currentLines.join('') })
      currentLines = []
    }
  }

  for (const line of normalizedLines) {
    const delimiter = isMemoDelimiter(line)
    const nextKind: DocumentRegionKind = inMemo || delimiter ? 'memo' : 'content'
    if (nextKind !== currentKind) {
      flush()
      currentKind = nextKind
    }

    currentLines.push(line)

    if (delimiter) {
      inMemo = !inMemo
      if (!inMemo) {
        flush()
        currentKind = 'content'
      }
    }
  }

  flush()
  return regions.length > 0 ? regions : [{ kind: 'content', text }]
}
