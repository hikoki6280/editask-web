import { RangeSetBuilder, StateField, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { isMemoDelimiter, type DocumentLineKind } from '../domain/documentStructure'
import { isCompletedTaskLine, isStartedTaskLine, isUrlRef, parseEstimateMinutes } from '../domain/editaskText'
import { isSeparatorLine } from '../domain/separatorLine'

const attrMark = Decoration.mark({ class: 'cm-editask-attr' })
const invalidAttrMark = Decoration.mark({ class: 'cm-editask-invalid-attr' })
const refMark = Decoration.mark({ class: 'cm-editask-ref' })
const refUrlMark = Decoration.mark({ class: 'cm-editask-ref-url' })
const separatorLine = Decoration.line({ class: 'cm-editask-separator' })
const memoLine = Decoration.line({ class: 'cm-editask-memo' })
const completedLine = Decoration.line({ class: 'cm-editask-completed' })
const startedLine = Decoration.line({ class: 'cm-editask-started' })

const tokenRe = /\b(?<key>rep|days|hold|m|ref|r):(?<val>\S+)/g
const dateLineRe =
  /^\s*(?:(?:\d{2}:\d{2}|-)(?:\s+(?:\d{2}:\d{2}|-))?\s+)?\d{4}\/\d{2}\/\d{2}(?:\s+(?<dow>[月火水木金土日]))?/

function classifyDocumentLine(lineText: string, inMemo: boolean): { kind: DocumentLineKind; nextInMemo: boolean } {
  if (isMemoDelimiter(lineText)) {
    return { kind: 'memoDelimiter', nextInMemo: !inMemo }
  }
  return { kind: inMemo ? 'memoBody' : 'content', nextInMemo: inMemo }
}

function buildLineKinds(doc: Text, startLineNumber = 1, prefixKinds: DocumentLineKind[] = []): DocumentLineKind[] {
  const kinds = prefixKinds.slice()
  let inMemo = false
  for (const kind of prefixKinds) {
    if (kind === 'memoDelimiter') inMemo = !inMemo
  }

  for (let lineNumber = startLineNumber; lineNumber <= doc.lines; lineNumber += 1) {
    const classified = classifyDocumentLine(doc.line(lineNumber).text, inMemo)
    kinds[lineNumber - 1] = classified.kind
    inMemo = classified.nextInMemo
  }
  return kinds
}

const documentLineKindsField = StateField.define<DocumentLineKind[]>({
  create: (state) => buildLineKinds(state.doc),
  update: (value, transaction) => {
    if (!transaction.docChanged) return value

    let firstChangedLine = transaction.state.doc.lines
    transaction.changes.iterChanges((_fromA, _toA, fromB) => {
      firstChangedLine = Math.min(firstChangedLine, transaction.state.doc.lineAt(fromB).number)
    })

    const prefixKinds = value.slice(0, Math.max(0, firstChangedLine - 1))
    return buildLineKinds(transaction.state.doc, firstChangedLine, prefixKinds)
  },
})

function addLineDecorations(builder: RangeSetBuilder<Decoration>, lineFrom: number, lineText: string, kind: DocumentLineKind) {
  if (kind !== 'content') {
    builder.add(lineFrom, lineFrom, memoLine)
  }

  if (kind === 'content' && isCompletedTaskLine(lineText)) {
    builder.add(lineFrom, lineFrom, completedLine)
  }

  if (kind === 'content' && isStartedTaskLine(lineText)) {
    builder.add(lineFrom, lineFrom, startedLine)
  }

  if (kind === 'content' && isSeparatorLine(lineText)) {
    builder.add(lineFrom, lineFrom, separatorLine)
  }
}

function addInlineDecorations(builder: RangeSetBuilder<Decoration>, lineFrom: number, lineText: string) {
  const dateMatch = dateLineRe.exec(lineText)
  const dow = dateMatch?.groups?.dow
  if (dow && dateMatch?.index !== undefined) {
    const dowStart = lineText.indexOf(dow, dateMatch.index)
    builder.add(lineFrom + dowStart, lineFrom + dowStart + dow.length, Decoration.mark({ class: `cm-dow-${dow}` }))
  }

  for (const match of lineText.matchAll(tokenRe)) {
    const key = match.groups?.key ?? ''
    const val = match.groups?.val ?? ''
    const from = lineFrom + (match.index ?? 0)
    const to = from + match[0].length
    if (
      (key === 'days' && !/^[月火水木金土日]+$|^\d+$/.test(val)) ||
      (key === 'hold' && !/^\d+$|^[月火水木金土日]$/.test(val)) ||
      (key === 'm' && parseEstimateMinutes(val) === undefined)
    ) {
      builder.add(from, to, invalidAttrMark)
    } else if (key === 'ref' || key === 'r') {
      builder.add(from, to, isUrlRef(val) ? refUrlMark : refMark)
    } else {
      builder.add(from, to, attrMark)
    }
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const lineKinds = view.state.field(documentLineKindsField)

  for (const range of view.visibleRanges) {
    let line = view.state.doc.lineAt(range.from)
    while (line.from <= range.to) {
      const lineText = line.text
      const kind = lineKinds[line.number - 1] ?? 'content'
      addLineDecorations(builder, line.from, lineText, kind)
      addInlineDecorations(builder, line.from, lineText)

      if (line.to >= range.to || line.number >= view.state.doc.lines) break
      line = view.state.doc.line(line.number + 1)
    }
  }

  return builder.finish()
}

export const editaskHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

export const editaskHighlightExtensions = [documentLineKindsField, editaskHighlight]
