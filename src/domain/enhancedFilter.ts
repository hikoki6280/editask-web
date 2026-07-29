import { splitDocumentRegions } from './documentStructure'
import { isSeparatorLine } from './separatorLine'

export type EnhancedFilterParts = {
  parkedText: string
  visibleText: string
  visibleCount: number
}

function joinLines(lines: string[]): string {
  return lines.join('\n')
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/)
}

export function joinEnhancedFilterParts(parkedText: string, visibleText: string): string {
  if (!parkedText) return visibleText
  if (!visibleText) return parkedText
  return `${parkedText}\n${visibleText}`
}

export function splitForEnhancedFilter(text: string, query: string): EnhancedFilterParts {
  const needle = query.trim()
  if (!needle) {
    return {
      parkedText: '',
      visibleText: text,
      visibleCount: text ? text.split(/\r?\n/).length : 0,
    }
  }

  const parked: string[] = []
  const visible: string[] = []

  splitDocumentRegions(text).forEach((region) => {
    const lines = splitLines(region.text).filter((line, index, all) => line !== '' || index < all.length - 1)
    if (region.kind === 'memo') {
      parked.push(...lines)
      return
    }

    lines.forEach((line) => {
      const isSeparator = isSeparatorLine(line)
      const isMatch = line.includes(needle)

      if (isSeparator || isMatch) {
        visible.push(line)
      } else {
        parked.push(line)
      }
    })
  })

  return {
    parkedText: joinLines(parked),
    visibleText: joinLines(visible),
    visibleCount: visible.length,
  }
}
