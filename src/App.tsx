import { Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { closeSearchPanel, openSearchPanel, searchPanelOpen, selectNextOccurrence } from '@codemirror/search'
import { basicSetup, EditorView } from 'codemirror'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  joinFilterParts,
  splitForFilter,
  type FilterParts,
} from './domain/filter'
import {
  aggregateTaskLines,
  collectFileRefs,
  getRefValueFromLine,
  formatWorkForecast,
  isUrlRef,
  normalizeDocumentText,
  parseTaskLine,
  shiftTaskDateLine,
  summarizeTodayTasks,
  toggleTaskStartEndLineWithNext,
  type SourcedTaskLine,
} from './domain/editaskText'
import { editaskHighlightExtensions } from './editor/editaskExtensions'
import { sourceGutter } from './editor/sourceGutter'
import { buildFileQuickSearchCandidates, quickSearchFiles } from './domain/fileQuickSearch'
import { db, firebaseEnabled } from './firebase/client'
import {
  ensureFileFromDefault,
  listFileIndex,
  loadFile,
  loadViewFiles,
  saveFile,
  subscribeFile,
  type EditaskFile,
  type EditaskFileIndex,
} from './firebase/fileRepository'
import { useAuthUser } from './hooks/useAuthUser'
import { matchesViewSelector, parseViewRef } from './domain/viewRef'

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict'

type CursorRestoreTarget = {
  lineText: string
  normalizedLineText: string
  trimmedText: string
  column: number
  trimmedColumn: number
  completed: boolean
}

type FilterInitialQuery = {
  query: string
  source: 'selection' | 'ref' | 'none'
}

type DiffPreview = {
  localOnly: string[]
  remoteOnly: string[]
  localOverflow: number
  remoteOverflow: number
}

type FileSort = 'updated' | 'name'
type FileDisplay = 'all' | 'refs'

type FileTreeNode = {
  label: string
  file?: EditaskFileIndex
  children: Map<string, FileTreeNode>
}

type FileTreeEntry =
  | { kind: 'folder'; label: string; path: string; file?: EditaskFileIndex; depth: number }
  | { kind: 'file'; file: EditaskFileIndex; depth: number }

function formatSavedAt(value: unknown): string {
  if (!value || typeof value !== 'object' || !('toDate' in value)) return '不明'
  const toDate = (value as { toDate?: unknown }).toDate
  if (typeof toDate !== 'function') return '不明'

  const date = toDate.call(value)
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '不明'
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function updatedAtMillis(value: unknown): number {
  if (!value || typeof value !== 'object' || !('toMillis' in value)) return 0
  const toMillis = (value as { toMillis?: unknown }).toMillis
  return typeof toMillis === 'function' ? Number(toMillis.call(value)) || 0 : 0
}

function buildFileTree(files: EditaskFileIndex[], sort: FileSort): FileTreeEntry[] {
  const root = new Map<string, FileTreeNode>()
  for (const file of files) {
    const parts = file.name.split('/').filter(Boolean)
    if (parts.length === 0) continue

    let children = root
    for (const [index, label] of parts.entries()) {
      let node = children.get(label)
      if (!node) {
        node = { label, children: new Map() }
        children.set(label, node)
      }
      if (index === parts.length - 1) node.file = file
      children = node.children
    }
  }

  const newestIn = (node: FileTreeNode): number =>
    Math.max(updatedAtMillis(node.file?.updatedAt), ...[...node.children.values()].map(newestIn), 0)
  const compareNodes = (a: FileTreeNode, b: FileTreeNode): number =>
    sort === 'name'
      ? a.label.localeCompare(b.label, 'ja')
      : newestIn(b) - newestIn(a) || a.label.localeCompare(b.label, 'ja')
  const entries: FileTreeEntry[] = []
  const visit = (nodes: Map<string, FileTreeNode>, depth: number, parentPath = '') => {
    for (const node of [...nodes.values()].sort(compareNodes)) {
      if (node.children.size > 0) {
        const path = parentPath ? `${parentPath}/${node.label}` : node.label
        entries.push({ kind: 'folder', label: node.label, path, file: node.file, depth })
        visit(node.children, depth + 1, path)
      } else if (node.file) {
        entries.push({ kind: 'file', file: node.file, depth })
      }
    }
  }
  visit(root, 0)
  return entries
}

// basicSetup starts with lineNumbers() and highlightActiveLineGutter().
const editaskSetup = (basicSetup as unknown as Extension[]).slice(2)

function fileNameFromHash(): string {
  const match = /^#\/files\/(.+)$/.exec(window.location.hash)
  return match ? decodeURIComponent(match[1]) : 'main'
}

function viewSpecFromHash(): string | undefined {
  const match = /^#\/views\/(.+)$/.exec(window.location.hash)
  return match ? decodeURIComponent(match[1]) : undefined
}

function updateHashFileName(fileName: string) {
  window.history.replaceState(null, '', `#/files/${encodeURIComponent(fileName)}`)
}

function downloadText(fileName: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${fileName || 'editask'}.txt`
  anchor.click()
  URL.revokeObjectURL(url)
}

function findLinePosition(text: string, lineText: string, column: number): number | undefined {
  let offset = 0
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (line === lineText) {
      return offset + Math.min(column, line.length)
    }
    offset += line.length + 1
  }
  return undefined
}

function viewUrl(spec: string): string {
  return `${window.location.origin}${window.location.pathname}#/views/${encodeURIComponent(spec)}`
}

function sourceMapForTasks(tasks: SourcedTaskLine[]): Map<number, string> {
  return new Map(tasks.map((task, index) => [index + 1, task.source]))
}

function buildLineDiffPreview(localText: string, remoteText: string, maxLines = 8): DiffPreview {
  const localLines = localText.split(/\r?\n/).filter((line) => line.trim())
  const remoteLines = remoteText.split(/\r?\n/).filter((line) => line.trim())
  const remoteCounts = new Map<string, number>()
  const localCounts = new Map<string, number>()

  remoteLines.forEach((line) => remoteCounts.set(line, (remoteCounts.get(line) ?? 0) + 1))
  localLines.forEach((line) => localCounts.set(line, (localCounts.get(line) ?? 0) + 1))

  const localOnly: string[] = []
  for (const line of localLines) {
    const count = remoteCounts.get(line) ?? 0
    if (count > 0) {
      remoteCounts.set(line, count - 1)
    } else {
      localOnly.push(line)
    }
  }

  const remoteOnly: string[] = []
  for (const line of remoteLines) {
    const count = localCounts.get(line) ?? 0
    if (count > 0) {
      localCounts.set(line, count - 1)
    } else {
      remoteOnly.push(line)
    }
  }

  return {
    localOnly: localOnly.slice(0, maxLines),
    remoteOnly: remoteOnly.slice(0, maxLines),
    localOverflow: Math.max(0, localOnly.length - maxLines),
    remoteOverflow: Math.max(0, remoteOnly.length - maxLines),
  }
}

function firstNonEmptyLine(text: string): string | undefined {
  return text.split(/\r?\n/).find((line) => line.trim())
}

function normalizeRestoreLine(lineText: string): string {
  return firstNonEmptyLine(normalizeDocumentText(lineText)) ?? lineText
}

function findRestorePosition(text: string, target: CursorRestoreTarget, fallback: number): number {
  const exactPosition = findLinePosition(text, target.lineText, target.column)
  if (exactPosition !== undefined) return exactPosition

  if (target.normalizedLineText && target.normalizedLineText !== target.lineText) {
    const normalizedPosition = findLinePosition(text, target.normalizedLineText, target.column)
    if (normalizedPosition !== undefined) return normalizedPosition
  }

  if (target.trimmedText) {
    let offset = 0
    const lines = text.split(/\r?\n/)
    for (const line of lines) {
      const index = line.indexOf(target.trimmedText)
      if (index >= 0) {
        return offset + index + Math.min(target.trimmedColumn, target.trimmedText.length)
      }
      offset += line.length + 1
    }
  }

  return Math.min(fallback, text.length)
}

function findSaveCursorPosition(text: string, target: CursorRestoreTarget, fallback: number): number {
  if (target.completed) return Math.min(fallback, text.length)
  return findRestorePosition(text, target, fallback)
}

function cursorOffsetInScroller(view: EditorView, position: number): number | undefined {
  const cursorRect = view.coordsAtPos(position)
  if (!cursorRect) return undefined
  return cursorRect.top - view.scrollDOM.getBoundingClientRect().top
}

function restoreCursorOffsetInScroller(view: EditorView, position: number, targetOffset: number | undefined) {
  if (targetOffset === undefined) return
  window.requestAnimationFrame(() => {
    const currentOffset = cursorOffsetInScroller(view, position)
    if (currentOffset === undefined) return
    view.scrollDOM.scrollTop += currentOffset - targetOffset
  })
}

function MissingFirebaseScreen() {
  return (
    <main className="login-screen">
      <section className="login-panel">
        <h1>EdiTask</h1>
        <p>Firebase environment variables are missing. Check Web/.env.local.</p>
      </section>
    </main>
  )
}

function LoginScreen() {
  const { signIn, error } = useAuthUser()

  return (
    <main className="login-screen">
      <section className="login-panel">
        <h1>EdiTask</h1>
        <p>Sign in with your Google account to start editing.</p>
        <button type="button" className="primary-button" onClick={signIn}>
          Sign in with Google
        </button>
        {error && <p className="error-text">{error}</p>}
      </section>
    </main>
  )
}

function EditorApp() {
  const { user, signOutUser } = useAuthUser()
  const editorHost = useRef<HTMLDivElement | null>(null)
  const editorView = useRef<EditorView | null>(null)
  const filterInputRef = useRef<HTMLInputElement | null>(null)
  const userRef = useRef(user)
  const fileNameRef = useRef(fileNameFromHash())
  const filterActiveRef = useRef(false)
  const filterOpenRef = useRef(false)
  const saveStateRef = useRef<SaveState>('idle')
  const skipNextFilterEffectRef = useRef(false)
  const parkedTextRef = useRef('')
  const pendingRemoteFileRef = useRef<EditaskFile | null>(null)
  const sourceGutterCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  const viewTasksRef = useRef<SourcedTaskLine[]>([])
  const [viewSpec] = useState(viewSpecFromHash)
  const viewOnly = viewSpec !== undefined
  const [fileName, setFileName] = useState(fileNameFromHash)
  const [filterQuery, setFilterQuery] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterActive, setFilterActive] = useState(false)
  const [filterVisibleCount, setFilterVisibleCount] = useState<number | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [conflictModalOpen, setConflictModalOpen] = useState(false)
  const [pendingRemoteFile, setPendingRemoteFile] = useState<EditaskFile | null>(null)
  const [conflictLocalContent, setConflictLocalContent] = useState('')
  const [todayTaskSummary, setTodayTaskSummary] = useState(() => summarizeTodayTasks(''))
  const [lastSyncedUpdatedAt, setLastSyncedUpdatedAt] = useState<unknown>(undefined)
  const [fileDrawerOpen, setFileDrawerOpen] = useState(false)
  const [fileList, setFileList] = useState<EditaskFileIndex[] | null>(null)
  const [fileListLoading, setFileListLoading] = useState(false)
  const [fileListError, setFileListError] = useState(false)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  const [fileDisplay, setFileDisplay] = useState<FileDisplay>('all')
  const [currentFileRefs, setCurrentFileRefs] = useState<Set<string>>(() => new Set())
  const [viewSources, setViewSources] = useState<Map<number, string>>(() => new Map())
  const [quickSearchQuery, setQuickSearchQuery] = useState('')
  const [quickSearchFocused, setQuickSearchFocused] = useState(false)
  const [quickSearchIndex, setQuickSearchIndex] = useState(0)
  const [fileSort, setFileSort] = useState<FileSort>(() =>
    window.localStorage.getItem('editask-file-sort') === 'name' ? 'name' : 'updated',
  )

  useEffect(() => {
    userRef.current = user
  }, [user])

  useEffect(() => {
    if (!viewOnly) fileNameRef.current = fileName
    document.title = viewOnly ? `View: ${viewSpec}` : fileName || 'EdiTask'
  }, [fileName, viewOnly, viewSpec])

  useEffect(() => {
    window.localStorage.setItem('editask-file-sort', fileSort)
  }, [fileSort])

  useEffect(() => {
    filterActiveRef.current = filterActive
  }, [filterActive])

  useEffect(() => {
    filterOpenRef.current = filterOpen
  }, [filterOpen])

  useEffect(() => {
    saveStateRef.current = saveState
  }, [saveState])

  const statusLabel = useMemo(() => {
    if (viewOnly) return 'View only'
    if (saveState === 'dirty') return 'Unsaved'
    if (saveState === 'saving') return 'Saving'
    if (saveState === 'saved') return 'Saved'
    if (saveState === 'error') return 'Error'
    if (saveState === 'conflict') return 'Conflict'
    return 'Idle'
  }, [saveState, viewOnly])

  const currentEditorFullText = useCallback((): string => {
    const view = editorView.current
    if (!view) return ''
    return filterActiveRef.current
      ? joinFilterParts(parkedTextRef.current, view.state.doc.toString())
      : view.state.doc.toString()
  }, [])

  const displayedFiles = useMemo(
    () =>
      fileDisplay === 'refs'
        ? (fileList ?? []).filter((file) =>
            [...currentFileRefs].some((selector) => matchesViewSelector(file.name, selector)),
          )
        : fileList ?? [],
    [currentFileRefs, fileDisplay, fileList],
  )
  const fileTree = useMemo(() => buildFileTree(displayedFiles, fileSort), [displayedFiles, fileSort])
  const quickSearchCandidates = useMemo(
    () => buildFileQuickSearchCandidates((fileList ?? []).map((file) => file.name)),
    [fileList],
  )
  const quickSearchResults = useMemo(
    () => quickSearchFiles(quickSearchCandidates, quickSearchQuery),
    [quickSearchCandidates, quickSearchQuery],
  )
  const quickSearchVisible = quickSearchFocused && quickSearchQuery.trim().length > 0
  const visibleFileTree = useMemo(
    () =>
      fileTree.filter((entry) => {
        const path = entry.kind === 'folder' ? entry.path : entry.file.name
        const parentParts = path.split('/').filter(Boolean)
        parentParts.pop()
        return !parentParts.some((_, index) => collapsedFolders.has(parentParts.slice(0, index + 1).join('/')))
      }),
    [collapsedFolders, fileTree],
  )

  const loadFileList = useCallback(async () => {
    if (!db || !user || fileListLoading) return
    setFileListLoading(true)
    setFileListError(false)
    try {
      setFileList(await listFileIndex(db, user.uid))
    } catch {
      setFileListError(true)
    } finally {
      setFileListLoading(false)
    }
  }, [fileListLoading, user])

  const openFileInNewTab = useCallback((nextName: string) => {
    const url = `${window.location.origin}${window.location.pathname}#/files/${encodeURIComponent(nextName)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [])

  const openFolderViewInNewTab = useCallback((path: string) => {
    window.open(viewUrl(`${path}/*`), '_blank', 'noopener,noreferrer')
  }, [])

  const openQuickSearchTarget = useCallback(
    (value: string) => {
      const target = value.trim().replace(/^(?:ref|r):/i, '')
      if (!target) return
      if (parseViewRef(target)) window.open(viewUrl(target), '_blank', 'noopener,noreferrer')
      else openFileInNewTab(target.replace(/\.txt$/i, '') || 'main')
      setQuickSearchQuery('')
      setQuickSearchIndex(0)
      setFileDrawerOpen(false)
    },
    [openFileInNewTab],
  )

  const conflictDiff = useMemo(() => {
    if (!conflictModalOpen || pendingRemoteFile === null) {
      return buildLineDiffPreview('', '')
    }
    return buildLineDiffPreview(conflictLocalContent, pendingRemoteFile.content)
  }, [conflictLocalContent, conflictModalOpen, pendingRemoteFile])

  const captureCursorRestoreTarget = useCallback((view: EditorView): CursorRestoreTarget => {
    const line = view.state.doc.lineAt(view.state.selection.main.head)
    const column = view.state.selection.main.head - line.from
    const leadingSpaces = line.text.length - line.text.trimStart().length
    const task = parseTaskLine(line.text)
    return {
      lineText: line.text,
      normalizedLineText: normalizeRestoreLine(line.text),
      trimmedText: line.text.trim(),
      column,
      trimmedColumn: Math.max(0, column - leadingSpaces),
      completed: task.raw === undefined && Boolean(task.end),
    }
  }, [])

  const loadCurrentFile = useCallback(async () => {
    const currentUser = userRef.current
    const currentFileName = fileNameRef.current
    if (!db || !currentUser) return

    try {
      const loaded = await loadFile(db, currentUser.uid, currentFileName)
      parkedTextRef.current = ''
      pendingRemoteFileRef.current = null
      setPendingRemoteFile(null)
      setConflictLocalContent('')
      setLastSyncedUpdatedAt(loaded.updatedAt)
      setConflictModalOpen(false)
      filterActiveRef.current = false
      filterOpenRef.current = false
      setFilterActive(false)
      setFilterOpen(false)
      setFilterQuery('')
      setFilterVisibleCount(null)
      editorView.current?.dispatch({
        changes: { from: 0, to: editorView.current.state.doc.length, insert: loaded.content },
      })
      setTodayTaskSummary(summarizeTodayTasks(loaded.content))
      setCurrentFileRefs(collectFileRefs(loaded.content))
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }, [])

  const loadVirtualView = useCallback(async () => {
    const currentUser = userRef.current
    const selectors = viewSpec ? parseViewRef(viewSpec) : undefined
    if (!db || !currentUser || !selectors) {
      setSaveState('error')
      return
    }

    try {
      const files = await loadViewFiles(db, currentUser.uid, selectors)
      const tasks = aggregateTaskLines(files)
      const content = tasks.map((task) => task.line).join('\n')
      parkedTextRef.current = ''
      filterActiveRef.current = false
      filterOpenRef.current = false
      setFilterActive(false)
      setFilterOpen(false)
      setFilterQuery('')
      setFilterVisibleCount(null)
      editorView.current?.dispatch({
        changes: { from: 0, to: editorView.current.state.doc.length, insert: content },
      })
      viewTasksRef.current = tasks
      setViewSources(sourceMapForTasks(tasks))
      setTodayTaskSummary(summarizeTodayTasks(content))
      setCurrentFileRefs(collectFileRefs(content))
      setSaveState('idle')
    } catch {
      setSaveState('error')
    }
  }, [viewSpec])

  const saveCurrentFile = useCallback(async () => {
    const currentUser = userRef.current
    const currentFileName = fileNameRef.current
    const view = editorView.current
    if (viewOnly || !db || !currentUser || !view) return

    setSaveState('saving')
    const editorText = view.state.doc.toString()
    const selectionHead = view.state.selection.main.head
    const filterActive = filterActiveRef.current
    const restoreTarget = captureCursorRestoreTarget(view)
    const restoreOffset = cursorOffsetInScroller(view, selectionHead)
    const visibleTextToSave = filterActive ? normalizeDocumentText(editorText) : editorText
    const textToSave = filterActive
      ? joinFilterParts(parkedTextRef.current, visibleTextToSave)
      : editorText
    const normalized = filterActive ? textToSave : normalizeDocumentText(textToSave)

    try {
      await saveFile(db, currentUser.uid, currentFileName, normalized)
      if (filterActive) {
        const nextSelection = findSaveCursorPosition(visibleTextToSave, restoreTarget, selectionHead)
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: visibleTextToSave },
          selection: { anchor: nextSelection },
          scrollIntoView: true,
        })
        restoreCursorOffsetInScroller(view, nextSelection, restoreOffset)
      } else {
        const nextSelection = findSaveCursorPosition(normalized, restoreTarget, selectionHead)
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: normalized },
          selection: { anchor: nextSelection },
          scrollIntoView: true,
        })
        restoreCursorOffsetInScroller(view, nextSelection, restoreOffset)
      }
      setTodayTaskSummary(summarizeTodayTasks(normalized))
      pendingRemoteFileRef.current = null
      setPendingRemoteFile(null)
      setConflictLocalContent('')
      setConflictModalOpen(false)
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }, [captureCursorRestoreTarget, viewOnly])

  const applyFilterParts = useCallback((parts: FilterParts, restore?: CursorRestoreTarget) => {
    parkedTextRef.current = parts.parkedText
    filterActiveRef.current = true
    setFilterActive(true)
    setFilterVisibleCount(parts.visibleCount)
    const restorePosition = restore
      ? findLinePosition(parts.visibleText, restore.lineText, restore.column)
      : undefined
    editorView.current?.dispatch({
      changes: {
        from: 0,
        to: editorView.current.state.doc.length,
        insert: parts.visibleText,
      },
      ...(restorePosition !== undefined
        ? { selection: { anchor: restorePosition }, scrollIntoView: true }
        : {}),
    })
    setSaveState((state) => (state === 'saving' || state === 'conflict' ? state : 'dirty'))
  }, [])

  const applyViewFilter = useCallback((query: string) => {
    const needle = query.trim()
    const tasks = needle
      ? viewTasksRef.current.filter((task) => task.line.includes(needle))
      : viewTasksRef.current
    const content = tasks.map((task) => task.line).join('\n')
    filterActiveRef.current = Boolean(needle)
    setFilterActive(Boolean(needle))
    setFilterVisibleCount(needle ? tasks.length : null)
    editorView.current?.dispatch({
      changes: { from: 0, to: editorView.current.state.doc.length, insert: content },
    })
    setViewSources(sourceMapForTasks(tasks))
  }, [])

  const applyFilter = useCallback(
    (query: string) => {
      const view = editorView.current
      if (!view) return
      if (viewOnly) {
        applyViewFilter(query)
        return
      }
      const baseText = filterActiveRef.current
        ? normalizeDocumentText(joinFilterParts(parkedTextRef.current, view.state.doc.toString()))
        : view.state.doc.toString()
      applyFilterParts(splitForFilter(baseText, query))
    },
    [applyFilterParts, applyViewFilter, viewOnly],
  )

  const getFilterInitialQuery = useCallback((view: EditorView): FilterInitialQuery => {
    const selectedText = view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    )
    const selectedLine = selectedText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    if (selectedLine) return { query: selectedLine, source: 'selection' }

    const line = view.state.doc.lineAt(view.state.selection.main.head)
    const ref = getRefValueFromLine(line.text)
    if (!ref || isUrlRef(ref)) return { query: '', source: 'none' }
    return { query: ref.replace(/\.txt$/i, ''), source: 'ref' }
  }, [])

  const closeFilter = useCallback(() => {
    const view = editorView.current
    if (!view) {
      filterActiveRef.current = false
      filterOpenRef.current = false
      setFilterOpen(false)
      setFilterQuery('')
      setFilterActive(false)
      setFilterVisibleCount(null)
      parkedTextRef.current = ''
      return
    }

    if (viewOnly) {
      const tasks = viewTasksRef.current
      const content = tasks.map((task) => task.line).join('\n')
      filterActiveRef.current = false
      filterOpenRef.current = false
      setFilterOpen(false)
      setFilterQuery('')
      setFilterActive(false)
      setFilterVisibleCount(null)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
      setViewSources(sourceMapForTasks(tasks))
      view.focus()
      return
    }

    if (!filterActiveRef.current) {
      filterOpenRef.current = false
      setFilterOpen(false)
      setFilterQuery('')
      setFilterVisibleCount(null)
      view.focus()
      return
    }

    const restoreTarget = captureCursorRestoreTarget(view)
    const selectionHead = view.state.selection.main.head
    const restoreOffset = cursorOffsetInScroller(view, view.state.selection.main.head)
    const fullText = filterActiveRef.current
      ? joinFilterParts(parkedTextRef.current, view.state.doc.toString())
      : view.state.doc.toString()
    const normalized = normalizeDocumentText(fullText)
    const restorePosition = findSaveCursorPosition(normalized, restoreTarget, selectionHead)
    parkedTextRef.current = ''
    filterActiveRef.current = false
    filterOpenRef.current = false
    setFilterOpen(false)
    setFilterQuery('')
    setFilterActive(false)
    setFilterVisibleCount(null)
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: normalized },
      selection: { anchor: restorePosition },
      scrollIntoView: true,
    })
    restoreCursorOffsetInScroller(view, restorePosition, restoreOffset)
    setSaveState((state) => (state === 'saving' || state === 'conflict' ? state : 'dirty'))
    view.focus()
  }, [captureCursorRestoreTarget, viewOnly])

  const openFilter = useCallback(() => {
    const view = editorView.current
    const initialQuery = view ? getFilterInitialQuery(view) : { query: '', source: 'none' as const }
    const restore = view ? captureCursorRestoreTarget(view) : undefined
    filterOpenRef.current = true
    setFilterOpen(true)
    if (initialQuery.query && view) {
      setFilterQuery(initialQuery.query)
      const baseText = filterActiveRef.current
        ? normalizeDocumentText(joinFilterParts(parkedTextRef.current, view.state.doc.toString()))
        : view.state.doc.toString()
      skipNextFilterEffectRef.current = true
      if (viewOnly) applyViewFilter(initialQuery.query)
      else applyFilterParts(splitForFilter(baseText, initialQuery.query), restore)
    } else {
      setFilterQuery('')
    }
    window.setTimeout(() => {
      if (initialQuery.source === 'ref' || initialQuery.source === 'selection') {
        view?.focus()
        return
      }
      filterInputRef.current?.focus()
      filterInputRef.current?.select()
    }, 0)
  }, [applyFilterParts, applyViewFilter, captureCursorRestoreTarget, getFilterInitialQuery, viewOnly])

  const toggleFilter = useCallback(() => {
    if (filterOpenRef.current) {
      closeFilter()
    } else {
      openFilter()
    }
    return true
  }, [closeFilter, openFilter])

  useEffect(() => {
    const handleGlobalFilterShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'f') return
      if (event.defaultPrevented) return

      const target = event.target instanceof Element ? event.target : undefined
      if (target?.closest('input, textarea, select')) return

      event.preventDefault()
      toggleFilter()
    }

    window.addEventListener('keydown', handleGlobalFilterShortcut)
    return () => window.removeEventListener('keydown', handleGlobalFilterShortcut)
  }, [toggleFilter])

  const toggleSearchPanel = useCallback((view: EditorView) => {
    if (searchPanelOpen(view.state)) {
      return closeSearchPanel(view)
    }
    return openSearchPanel(view)
  }, [])

  const toggleCurrentLineStartEnd = useCallback((view: EditorView) => {
    if (viewOnly) return true
    if (view.state.selection.ranges.some((range) => !range.empty)) {
      const selectionSnapshot = view.state.selection.ranges.map((range) => {
        const positionToLineColumn = (position: number) => {
          const line = view.state.doc.lineAt(position)
          return { lineNumber: line.number, column: position - line.from }
        }
        return {
          anchor: positionToLineColumn(range.anchor),
          head: positionToLineColumn(range.head),
        }
      })
      const lineNumbers = new Set<number>()
      for (const range of view.state.selection.ranges) {
        const from = Math.min(range.from, range.to)
        const to = Math.max(range.from, range.to)
        const firstLine = view.state.doc.lineAt(from).number
        const lastLine = view.state.doc.lineAt(Math.max(from, to - 1)).number
        for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
          lineNumbers.add(lineNumber)
        }
      }

      const nextLines: string[] = []
      const changes = [...lineNumbers]
        .sort((a, b) => a - b)
        .flatMap((lineNumber) => {
          const line = view.state.doc.line(lineNumber)
          const result = toggleTaskStartEndLineWithNext(line.text)
          if (result.nextLine) nextLines.push(result.nextLine)
          return result.line !== line.text ? [{ from: line.from, to: line.to, insert: result.line }] : []
        })
      if (nextLines.length > 0) {
        const docText = view.state.doc.toString()
        changes.push({
          from: view.state.doc.length,
          to: view.state.doc.length,
          insert: `${docText.endsWith('\n') || docText.length === 0 ? '' : '\n'}${nextLines.join('\n')}`,
        })
      }
      if (changes.length === 0) return true

      const nextDoc = view.state.update({ changes }).state.doc
      const selection = EditorSelection.create(
        selectionSnapshot.map((range) => {
          const lineColumnToPosition = ({ lineNumber, column }: { lineNumber: number; column: number }) => {
            const line = nextDoc.line(lineNumber)
            return line.from + Math.min(column, line.length)
          }
          return EditorSelection.range(lineColumnToPosition(range.anchor), lineColumnToPosition(range.head))
        }),
        view.state.selection.mainIndex,
      )
      view.dispatch({ changes, selection })
      return true
    }

    const line = view.state.doc.lineAt(view.state.selection.main.head)
    const result = toggleTaskStartEndLineWithNext(line.text)
    if (result.line === line.text && !result.nextLine) return true

    const changes = [{ from: line.from, to: line.to, insert: result.line }]
    if (result.nextLine) {
      const docText = view.state.doc.toString()
      changes.push({
        from: view.state.doc.length,
        to: view.state.doc.length,
        insert: `${docText.endsWith('\n') || docText.length === 0 ? '' : '\n'}${result.nextLine}`,
      })
    }

    view.dispatch({
      changes,
      selection: { anchor: line.from + Math.min(result.line.length, view.state.selection.main.head - line.from) },
    })
    return true
  }, [viewOnly])

  const shiftSelectedTaskDates = useCallback((view: EditorView, deltaDays: number) => {
    if (viewOnly) return true
    const selectionSnapshot = view.state.selection.ranges.map((range) => {
      const positionToLineColumn = (position: number) => {
        const line = view.state.doc.lineAt(position)
        return { lineNumber: line.number, column: position - line.from }
      }
      return {
        anchor: positionToLineColumn(range.anchor),
        head: positionToLineColumn(range.head),
      }
    })
    const lineNumbers = new Set<number>()
    for (const range of view.state.selection.ranges) {
      if (range.empty) {
        lineNumbers.add(view.state.doc.lineAt(range.head).number)
        continue
      }

      const from = Math.min(range.from, range.to)
      const to = Math.max(range.from, range.to)
      const firstLine = view.state.doc.lineAt(from).number
      const lastLine = view.state.doc.lineAt(Math.max(from, to - 1)).number
      for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
        lineNumbers.add(lineNumber)
      }
    }

    const changes = [...lineNumbers]
      .sort((a, b) => a - b)
      .flatMap((lineNumber) => {
        const line = view.state.doc.line(lineNumber)
        const result = shiftTaskDateLine(line.text, deltaDays)
        return result.changed ? [{ from: line.from, to: line.to, insert: result.line }] : []
      })

    if (changes.length === 0) return true

    const nextDoc = view.state.update({ changes }).state.doc
    const selection = EditorSelection.create(
      selectionSnapshot.map((range) => {
        const lineColumnToPosition = ({ lineNumber, column }: { lineNumber: number; column: number }) => {
          const line = nextDoc.line(lineNumber)
          return line.from + Math.min(column, line.length)
        }
        return EditorSelection.range(lineColumnToPosition(range.anchor), lineColumnToPosition(range.head))
      }),
      view.state.selection.mainIndex,
    )

    view.dispatch({ changes, selection })
    return true
  }, [viewOnly])

  const openRef = useCallback(async () => {
    const view = editorView.current
    if (!view) return

    const line = view.state.doc.lineAt(view.state.selection.main.head)
    const ref = getRefValueFromLine(line.text)
    if (!ref) {
      return
    }

    if (isUrlRef(ref)) {
      window.open(ref, '_blank', 'noopener,noreferrer')
      return
    }

    if (parseViewRef(ref)) {
      window.open(viewUrl(ref), '_blank', 'noopener,noreferrer')
      return
    }

    const nextName = ref.replace(/\.txt$/i, '') || 'main'
    const currentUser = userRef.current
    if (db && currentUser) {
      try {
        await ensureFileFromDefault(db, currentUser.uid, nextName)
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Failed to create ref file')
        return
      }
    }
    const url = `${window.location.origin}${window.location.pathname}#/files/${encodeURIComponent(nextName)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [])

  const exportCurrentFile = useCallback(() => {
    downloadText(fileNameRef.current, editorView.current?.state.doc.toString() ?? '')
  }, [])

  const doneCurrentLine = useCallback(() => {
    const view = editorView.current
    if (!view) return
    toggleCurrentLineStartEnd(view)
    view.focus()
  }, [toggleCurrentLineStartEnd])

  const openConflictResolver = useCallback(() => {
    if (pendingRemoteFileRef.current !== null) {
      setConflictModalOpen(true)
    }
  }, [])

  const resolveConflictWithLocal = useCallback(() => {
    setConflictModalOpen(false)
    void saveCurrentFile()
  }, [saveCurrentFile])

  const resolveConflictWithRemote = useCallback(() => {
    const view = editorView.current
    const remoteFile = pendingRemoteFileRef.current
    if (!view || remoteFile === null) return
    const remoteContent = remoteFile.content

    parkedTextRef.current = ''
    pendingRemoteFileRef.current = null
    setPendingRemoteFile(null)
    setConflictLocalContent('')
    filterActiveRef.current = false
    filterOpenRef.current = false
    setFilterActive(false)
    setFilterOpen(false)
    setFilterQuery('')
    setFilterVisibleCount(null)
    setConflictModalOpen(false)
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: remoteContent },
      selection: { anchor: Math.min(view.state.selection.main.head, remoteContent.length) },
      scrollIntoView: true,
    })
    setTodayTaskSummary(summarizeTodayTasks(remoteContent))
    setCurrentFileRefs(collectFileRefs(remoteContent))
    setLastSyncedUpdatedAt(remoteFile.updatedAt)
    setSaveState('saved')
    view.focus()
  }, [])

  useEffect(() => {
    if (!viewOnly) updateHashFileName(fileName)
  }, [fileName, viewOnly])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (viewOnly) void loadVirtualView()
      else void loadCurrentFile()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [fileName, loadCurrentFile, loadVirtualView, user, viewOnly])

  useEffect(() => {
    if (viewOnly || !db || !user) return undefined

    return subscribeFile(
      db,
      user.uid,
      fileName,
      (remoteFile) => {
        const view = editorView.current
        if (!view) return
        if (saveStateRef.current === 'saving') {
          setLastSyncedUpdatedAt(remoteFile.updatedAt)
          return
        }

        const currentContent = currentEditorFullText()
        if (currentContent === remoteFile.content) {
          setLastSyncedUpdatedAt(remoteFile.updatedAt)
          return
        }

        if (saveStateRef.current !== 'saved' || filterActiveRef.current) {
          pendingRemoteFileRef.current = remoteFile
          setPendingRemoteFile(remoteFile)
          setConflictLocalContent(currentContent)
          saveStateRef.current = 'conflict'
          setSaveState('conflict')
          return
        }

        const selectionHead = Math.min(view.state.selection.main.head, remoteFile.content.length)
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: remoteFile.content },
          selection: { anchor: selectionHead },
          scrollIntoView: true,
        })
        setTodayTaskSummary(summarizeTodayTasks(remoteFile.content))
        setCurrentFileRefs(collectFileRefs(remoteFile.content))
        setLastSyncedUpdatedAt(remoteFile.updatedAt)
        setSaveState('saved')
      },
      () => {
        if (saveStateRef.current === 'saved') setSaveState('error')
      },
    )
  }, [currentEditorFullText, fileName, user, viewOnly])

  useEffect(() => {
    if (!filterOpen) return undefined
    if (skipNextFilterEffectRef.current) {
      skipNextFilterEffectRef.current = false
      return undefined
    }
    if (!filterQuery.trim() && !filterActiveRef.current) {
      setFilterVisibleCount(null)
      return undefined
    }
    const timer = window.setTimeout(() => {
      applyFilter(filterQuery)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [applyFilter, filterOpen, filterQuery])

  useEffect(() => {
    if (!editorHost.current || editorView.current) return undefined

    editorView.current = new EditorView({
      parent: editorHost.current,
      doc: '',
      extensions: [
        editaskSetup,
        sourceGutterCompartment.current.of([]),
        readOnlyCompartment.current.of([
          EditorState.readOnly.of(viewOnly),
          EditorView.editable.of(!viewOnly),
        ]),
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-f',
              run: toggleSearchPanel,
              preventDefault: true,
              scope: 'editor search-panel',
            },
            {
              key: 'Mod-h',
              run: toggleSearchPanel,
              preventDefault: true,
              scope: 'editor search-panel',
            },
            {
              key: 'Mod-Shift-d',
              run: selectNextOccurrence,
              preventDefault: true,
            },
            {
              key: 'Mod-q',
              run: toggleCurrentLineStartEnd,
              preventDefault: true,
            },
            {
              key: 'Mod-Shift-ArrowUp',
              run: (view) => shiftSelectedTaskDates(view, -1),
              preventDefault: true,
            },
            {
              key: 'Mod-Shift-ArrowDown',
              run: (view) => shiftSelectedTaskDates(view, 1),
              preventDefault: true,
            },
          ]),
        ),
        editaskHighlightExtensions,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const currentText = filterActiveRef.current
              ? joinFilterParts(parkedTextRef.current, update.state.doc.toString())
              : update.state.doc.toString()
            setCurrentFileRefs(collectFileRefs(currentText))
            if (filterActiveRef.current) {
              setFilterVisibleCount(update.state.doc.length > 0 ? update.state.doc.lines : 0)
            }
            if (!viewOnly) {
              setSaveState((state) => (state === 'saving' || state === 'conflict' ? state : 'dirty'))
            }
          }
        }),
        EditorView.domEventHandlers({
          keydown(event) {
            if (event.ctrlKey && event.key.toLowerCase() === 's') {
              event.preventDefault()
              if (viewOnly) return true
              if (saveStateRef.current === 'conflict') openConflictResolver()
              else void saveCurrentFile()
              return true
            }
            if (event.ctrlKey && event.key.toLowerCase() === 'r') {
              event.preventDefault()
              void openRef()
              return true
            }
            if (event.key === 'Escape' && filterOpenRef.current) {
              event.preventDefault()
              closeFilter()
              return true
            }
            return false
          },
        }),
      ],
    })

    return () => {
      editorView.current?.destroy()
      editorView.current = null
    }
  }, [
    closeFilter,
    openConflictResolver,
    openRef,
    saveCurrentFile,
    shiftSelectedTaskDates,
    toggleCurrentLineStartEnd,
    toggleSearchPanel,
    viewOnly,
  ])

  useEffect(() => {
    const view = editorView.current
    if (!view) return
    view.dispatch({
      effects: [
        sourceGutterCompartment.current.reconfigure(viewOnly ? sourceGutter(viewSources) : []),
        readOnlyCompartment.current.reconfigure([
          EditorState.readOnly.of(viewOnly),
          EditorView.editable.of(!viewOnly),
        ]),
      ],
    })
  }, [filterActive, viewOnly, viewSources])

  return (
    <main className={`app-shell${fileDrawerOpen ? ' file-drawer-open' : ''}`}>
      {fileDrawerOpen && <div className="file-drawer-backdrop" onClick={() => setFileDrawerOpen(false)} />}
      <aside id="file-drawer" className="file-drawer" aria-label="Files">
        <form
          className="file-quick-search"
          onSubmit={(event) => {
            event.preventDefault()
            const selected = quickSearchResults[quickSearchIndex]
            openQuickSearchTarget(selected?.value ?? quickSearchQuery)
          }}
        >
          <input
            value={quickSearchQuery}
            onChange={(event) => {
              setQuickSearchQuery(event.target.value)
              setQuickSearchIndex(0)
            }}
            onFocus={() => setQuickSearchFocused(true)}
            onBlur={() => setQuickSearchFocused(false)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && quickSearchResults.length > 0) {
                event.preventDefault()
                setQuickSearchIndex((index) => Math.min(index + 1, quickSearchResults.length - 1))
              } else if (event.key === 'ArrowUp' && quickSearchResults.length > 0) {
                event.preventDefault()
                setQuickSearchIndex((index) => Math.max(index - 1, 0))
              } else if (event.key === 'Escape') {
                setQuickSearchQuery('')
                setQuickSearchIndex(0)
                event.currentTarget.blur()
              }
            }}
            placeholder="ファイルまたはViewを開く"
            aria-label="ファイルまたは統合ビューを開く"
            aria-autocomplete="list"
            aria-controls="file-quick-search-results"
            aria-expanded={quickSearchVisible}
          />
          <button type="submit" disabled={!quickSearchQuery.trim()}>
            開く
          </button>
          <button
            type="button"
            className="file-drawer-icon-button"
            onClick={() => setFileDrawerOpen(false)}
            aria-label="閉じる"
            title="閉じる"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
          {quickSearchVisible && (
            <div id="file-quick-search-results" className="file-quick-search-results" role="listbox">
              {quickSearchResults.length > 0 ? (
                quickSearchResults.map((candidate, index) => (
                  <button
                    key={`${candidate.kind}:${candidate.value}`}
                    type="button"
                    role="option"
                    aria-selected={index === quickSearchIndex}
                    className={index === quickSearchIndex ? 'active' : ''}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => openQuickSearchTarget(candidate.value)}
                  >
                    <span>{candidate.label}</span>
                    <small>{candidate.kind === 'folder' ? '配下を統合表示' : '編集'}</small>
                  </button>
                ))
              ) : (
                <p>一致するファイルはありません。入力名で開けます。</p>
              )}
            </div>
          )}
        </form>
        <div className="file-drawer-controls">
          <label htmlFor="file-sort">ファイル並び順</label>
          <select
            id="file-sort"
            value={fileSort}
            onChange={(event) => setFileSort(event.target.value as FileSort)}
          >
            <option value="updated">新しい順</option>
            <option value="name">abc順</option>
          </select>
          <button
            type="button"
            className="file-drawer-refresh-button"
            onClick={() => void loadFileList()}
            disabled={fileListLoading}
          >
            更新
          </button>
        </div>
        <div className="file-drawer-filter" aria-label="ファイル表示">
          <span>表示</span>
          <button
            type="button"
            className={fileDisplay === 'all' ? 'active' : ''}
            aria-pressed={fileDisplay === 'all'}
            onClick={() => setFileDisplay('all')}
          >
            すべて
          </button>
          <button
            type="button"
            className={fileDisplay === 'refs' ? 'active' : ''}
            aria-pressed={fileDisplay === 'refs'}
            onClick={() => setFileDisplay('refs')}
          >
            参照先
          </button>
        </div>
        <nav className="file-tree" aria-label="File tree">
          {fileListLoading && fileList === null ? (
            <p>読み込み中…</p>
          ) : fileListError ? (
            <p>ファイル一覧を取得できませんでした。</p>
          ) : fileTree.length === 0 ? (
            <p>ファイルはありません。</p>
          ) : (
            visibleFileTree.map((entry) =>
              entry.kind === 'folder' ? (
                <div
                  className="file-tree-folder"
                  key={`folder:${entry.path}`}
                  style={{ paddingInlineStart: `${12 + entry.depth * 16}px` }}
                >
                  <button
                    type="button"
                    className="file-tree-chevron-button"
                    aria-label={`${entry.label}を${collapsedFolders.has(entry.path) ? '展開' : '折りたたみ'}`}
                    aria-expanded={!collapsedFolders.has(entry.path)}
                    onClick={() => {
                      setCollapsedFolders((folders) => {
                        const nextFolders = new Set(folders)
                        if (nextFolders.has(entry.path)) nextFolders.delete(entry.path)
                        else nextFolders.add(entry.path)
                        return nextFolders
                      })
                    }}
                  >
                    <span className="file-tree-chevron" aria-hidden="true">›</span>
                  </button>
                  {entry.file ? (
                    <button
                      type="button"
                      className="file-tree-folder-file"
                      aria-current={entry.file.name === fileName ? 'page' : undefined}
                      title={`${entry.file.name}\n保存: ${formatSavedAt(entry.file.updatedAt)}`}
                      onClick={() => {
                        openFileInNewTab(entry.file!.name)
                        setFileDrawerOpen(false)
                      }}
                    >
                      <span>{entry.label}</span>
                      <small>{formatSavedAt(entry.file.updatedAt)}</small>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="file-tree-folder-label"
                      title={`${entry.path}/* を統合ビューで開く`}
                      onClick={() => {
                        openFolderViewInNewTab(entry.path)
                        setFileDrawerOpen(false)
                      }}
                    >
                      {entry.label}
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  className="file-tree-file"
                  key={`file:${entry.file.name}`}
                  aria-current={entry.file.name === fileName ? 'page' : undefined}
                  style={{ paddingInlineStart: `${12 + entry.depth * 16}px` }}
                  title={`${entry.file.name}\n保存: ${formatSavedAt(entry.file.updatedAt)}`}
                  onClick={() => {
                    openFileInNewTab(entry.file.name)
                    setFileDrawerOpen(false)
                  }}
                >
                  <span>{entry.file.name.split('/').filter(Boolean).at(-1)}</span>
                  <small>{formatSavedAt(entry.file.updatedAt)}</small>
                </button>
              ),
            )
          )}
        </nav>
      </aside>
      <header className="topbar">
        <div className="file-controls">
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => {
              const nextOpen = !fileDrawerOpen
              setFileDrawerOpen(nextOpen)
              if (nextOpen && fileList === null) void loadFileList()
            }}
            aria-expanded={fileDrawerOpen}
            aria-controls="file-drawer"
            aria-label="ファイル一覧"
            title="ファイル一覧"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 5h16M4 12h16M4 19h16" />
            </svg>
          </button>
          <img
            className="app-icon"
            src={`${import.meta.env.BASE_URL}favicon-32x32.png`}
            alt=""
            aria-hidden="true"
          />
          {viewOnly ? (
            <span className="view-name-label">View: {viewSpec}</span>
          ) : (
            <input
              className="file-name-input"
              value={fileName}
              onChange={(event) => setFileName(event.target.value.trim() || 'main')}
              onBlur={() => void loadCurrentFile()}
              aria-label="File name"
            />
          )}
          <button
            type="button"
            className={`save-state save-state-${saveState}`}
            onClick={() => {
              if (saveState === 'conflict') {
                openConflictResolver()
                return
              }
              if (saveState === 'dirty' || saveState === 'error') void saveCurrentFile()
            }}
            disabled={viewOnly || (saveState !== 'dirty' && saveState !== 'error' && saveState !== 'conflict')}
            title="Save"
          >
            {statusLabel}
          </button>
          {viewOnly && (
            <button type="button" onClick={toggleFilter} aria-pressed={filterOpen}>
              Filter
            </button>
          )}
        </div>
        <div className="session-controls">
          <span className="user-label">{user?.displayName ?? user?.email}</span>
          {!viewOnly && (
            <button type="button" onClick={doneCurrentLine}>
              Done
            </button>
          )}
          <button type="button" onClick={exportCurrentFile}>
            Export
          </button>
          <button type="button" onClick={() => void signOutUser()}>
            Logout
          </button>
        </div>
      </header>

      {conflictModalOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
            <h2 id="conflict-title">Conflict</h2>
            <p>他のタブでこのファイルが更新されています。どちらを正として残すか選んでください。</p>
            <div className="conflict-diff">
              <section className="conflict-file-option">
                <h3>現在のファイル</h3>
                <p className="conflict-file-meta">未保存の編集あり（最後の同期: {formatSavedAt(lastSyncedUpdatedAt)}）</p>
                <pre>
                  {conflictDiff.localOnly.length > 0
                    ? conflictDiff.localOnly.map((line) => `- ${line}`).join('\n')
                    : '差分なし'}
                  {conflictDiff.localOverflow > 0 ? `\n...他 ${conflictDiff.localOverflow} 行` : ''}
                </pre>
                <button type="button" onClick={resolveConflictWithLocal}>
                  この内容で保存
                </button>
              </section>
              <section className="conflict-file-option">
                <h3>リモートのファイル</h3>
                <p className="conflict-file-meta">
                  保存: {formatSavedAt(pendingRemoteFile?.updatedAt)}
                </p>
                <pre>
                  {conflictDiff.remoteOnly.length > 0
                    ? conflictDiff.remoteOnly.map((line) => `+ ${line}`).join('\n')
                    : '差分なし'}
                  {conflictDiff.remoteOverflow > 0 ? `\n...他 ${conflictDiff.remoteOverflow} 行` : ''}
                </pre>
                <button type="button" className="primary-button" onClick={resolveConflictWithRemote}>
                  リモートを読み込む
                </button>
              </section>
            </div>
          </section>
        </div>
      )}

      {filterOpen && (
        <section className="filter-bar">
          <label htmlFor="filter-input">Filter</label>
          <input
            id="filter-input"
            ref={filterInputRef}
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'f') {
                event.preventDefault()
                closeFilter()
                return
              }
              if (event.key === 'Escape') {
                closeFilter()
              }
            }}
            placeholder="Search"
          />
          <span>
            {filterActive
              ? `${filterVisibleCount ?? 0} visible lines`
              : 'Type to filter lines'}
          </span>
          <button
            type="button"
            onClick={() => {
              closeFilter()
            }}
          >
            Close
          </button>
        </section>
      )}

      <section className="workspace">
        <div className="editor-pane" ref={editorHost} />
      </section>

      <footer className="statusbar">
        <span>
          {'\u4eca\u65e5: '}{todayTaskSummary.remaining}{' \u5b8c\u4e86: '}{todayTaskSummary.completed}{' \u4f5c\u696d\u4e88\u6e2c: '}
          {formatWorkForecast(todayTaskSummary.estimatedMinutes)}
        </span>
        <span>Ctrl+S Save / Ctrl+F Find / Ctrl+Shift+F Filter / Ctrl+Shift+Up/Down Date / Ctrl+R ref</span>
      </footer>
    </main>
  )
}

function App() {
  const authState = useAuthUser()

  if (!firebaseEnabled) return <MissingFirebaseScreen />
  if (authState.loading) return <main className="login-screen">Loading...</main>
  if (!authState.user) return <LoginScreen />
  return <EditorApp />
}

export default App
