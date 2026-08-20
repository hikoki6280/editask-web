export function parseViewRef(value: string): string[] | undefined {
  const trimmed = value.trim()
  const selectors =
    trimmed.startsWith('{') && trimmed.endsWith('}')
      ? trimmed.slice(1, -1).split(',').map((selector) => selector.trim())
      : trimmed.includes('*')
        ? [trimmed]
        : undefined

  if (!selectors || selectors.length === 0 || selectors.some((selector) => !selector)) return undefined

  const normalized = selectors.map((selector) =>
    selector.includes('*') ? selector : selector.replace(/\.txt$/i, '') || 'main',
  )
  if (normalized.some((selector) => selector.includes('*') && !/^[^*]+\/\*$/.test(selector))) {
    return undefined
  }
  return normalized
}

export function matchesViewSelector(fileName: string, selector: string): boolean {
  if (!selector.endsWith('/*')) return fileName === selector
  return fileName.startsWith(selector.slice(0, -1))
}
