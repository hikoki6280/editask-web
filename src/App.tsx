import { Prec, type Extension } from '@codemirror/state'
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
  getRefValueFromLine,
  formatEstimateMinutes,
  isUrlRef,
  normalizeDocumentText,
  parseTaskLine,
  shiftTaskDateLine,
  summarizeTodayTasks,
  toggleTaskStartEndLineWithNext,
} from './domain/editaskText'
import { editaskHighlightExtensions } from './editor/editaskExtensions'
import { db, firebaseEnabled } from './firebase/client'
import { ensureFileFromDefault, loadFile, saveFile, subscribeFile } from './firebase/fileRepository'
import { useAuthUser } from './hooks/useAuthUser'

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

// basicSetup starts with lineNumbers() and highlightActiveLineGutter().
const editaskSetup = (basicSetup as unknown as Extension[]).slice(2)

function fileNameFromHash(): string {
  const match = /^#\/files\/(.+)$/.exec(window.location.hash)
  return match ? decodeURIComponent(match[1]) : 'main'
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
  const pendingRemoteContentRef = useRef<string | null>(null)
  const [fileName, setFileName] = useState(fileNameFromHash)
  const [filterQuery, setFilterQuery] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterActive, setFilterActive] = useState(false)
  const [filterVisibleCount, setFilterVisibleCount] = useState<number | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [conflictModalOpen, setConflictModalOpen] = useState(false)
  const [conflictVersion, setConflictVersion] = useState(0)
  const [todayTaskSummary, setTodayTaskSummary] = useState(() => summarizeTodayTasks(''))

  useEffect(() => {
    userRef.current = user
  }, [user])

  useEffect(() => {
    fileNameRef.current = fileName
    document.title = fileName || 'EdiTask'
  }, [fileName])

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
    if (saveState === 'dirty') return 'Unsaved'
    if (saveState === 'saving') return 'Saving'
    if (saveState === 'saved') return 'Saved'
    if (saveState === 'error') return 'Error'
    if (saveState === 'conflict') return 'Conflict'
    return 'Idle'
  }, [saveState])

  const currentEditorFullText = useCallback((): string => {
    const view = editorView.current
    if (!view) return ''
    return filterActiveRef.current
      ? joinFilterParts(parkedTextRef.current, view.state.doc.toString())
      : view.state.doc.toString()
  }, [])

  const conflictDiff = useMemo(() => {
    if (!conflictModalOpen || pendingRemoteContentRef.current === null) {
      return buildLineDiffPreview('', '')
    }
    return buildLineDiffPreview(currentEditorFullText(), pendingRemoteContentRef.current)
  }, [conflictModalOpen, conflictVersion, currentEditorFullText])

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
      pendingRemoteContentRef.current = null
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
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }, [])

  const saveCurrentFile = useCallback(async () => {
    const currentUser = userRef.current
    const currentFileName = fileNameRef.current
    const view = editorView.current
    if (!db || !currentUser || !view) return

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
      pendingRemoteContentRef.current = null
      setConflictModalOpen(false)
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }, [captureCursorRestoreTarget])

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

  const applyFilter = useCallback(
    (query: string) => {
      const view = editorView.current
      if (!view) return
      const baseText = filterActiveRef.current
        ? normalizeDocumentText(joinFilterParts(parkedTextRef.current, view.state.doc.toString()))
        : view.state.doc.toString()
      applyFilterParts(splitForFilter(baseText, query))
    },
    [applyFilterParts],
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
  }, [captureCursorRestoreTarget])

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
      applyFilterParts(splitForFilter(baseText, initialQuery.query), restore)
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
  }, [applyFilterParts, captureCursorRestoreTarget, getFilterInitialQuery])

  const toggleFilter = useCallback(() => {
    if (filterOpenRef.current) {
      closeFilter()
    } else {
      openFilter()
    }
    return true
  }, [closeFilter, openFilter])

  const toggleSearchPanel = useCallback((view: EditorView) => {
    if (searchPanelOpen(view.state)) {
      return closeSearchPanel(view)
    }
    return openSearchPanel(view)
  }, [])

  const toggleCurrentLineStartEnd = useCallback((view: EditorView) => {
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
  }, [])

  const shiftSelectedTaskDates = useCallback((view: EditorView, deltaDays: number) => {
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
    view.dispatch({ changes })
    return true
  }, [])

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
    if (pendingRemoteContentRef.current !== null) {
      setConflictModalOpen(true)
    }
  }, [])

  const resolveConflictWithLocal = useCallback(() => {
    setConflictModalOpen(false)
    void saveCurrentFile()
  }, [saveCurrentFile])

  const resolveConflictWithRemote = useCallback(() => {
    const view = editorView.current
    const remoteContent = pendingRemoteContentRef.current
    if (!view || remoteContent === null) return

    parkedTextRef.current = ''
    pendingRemoteContentRef.current = null
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
    setSaveState('saved')
    view.focus()
  }, [])

  useEffect(() => {
    updateHashFileName(fileName)
  }, [fileName])

  useEffect(() => {
    void loadCurrentFile()
  }, [fileName, loadCurrentFile, user])

  useEffect(() => {
    if (!db || !user) return undefined

    return subscribeFile(
      db,
      user.uid,
      fileName,
      (remoteFile) => {
        const view = editorView.current
        if (!view) return
        if (saveStateRef.current === 'saving') return

        const currentContent = currentEditorFullText()
        if (currentContent === remoteFile.content) return

        if (saveStateRef.current !== 'saved' || filterActiveRef.current) {
          pendingRemoteContentRef.current = remoteFile.content
          setConflictVersion((version) => version + 1)
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
        setSaveState('saved')
      },
      () => {
        if (saveStateRef.current === 'saved') setSaveState('error')
      },
    )
  }, [currentEditorFullText, fileName, user])

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
              key: 'Mod-Shift-f',
              run: toggleFilter,
              preventDefault: true,
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
            if (filterActiveRef.current) {
              setFilterVisibleCount(update.state.doc.length > 0 ? update.state.doc.lines : 0)
            }
            setSaveState((state) => (state === 'saving' || state === 'conflict' ? state : 'dirty'))
          }
        }),
        EditorView.domEventHandlers({
          keydown(event) {
            if (event.ctrlKey && event.key.toLowerCase() === 's') {
              event.preventDefault()
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
    toggleFilter,
    toggleSearchPanel,
  ])

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="file-controls">
          <img
            className="app-icon"
            src={`${import.meta.env.BASE_URL}favicon-32x32.png`}
            alt=""
            aria-hidden="true"
          />
          <input
            className="file-name-input"
            value={fileName}
            onChange={(event) => setFileName(event.target.value.trim() || 'main')}
            onBlur={() => void loadCurrentFile()}
            aria-label="File name"
          />
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
            disabled={saveState !== 'dirty' && saveState !== 'error' && saveState !== 'conflict'}
            title="Save"
          >
            {statusLabel}
          </button>
        </div>
        <div className="session-controls">
          <span className="user-label">{user?.displayName ?? user?.email}</span>
          <button type="button" onClick={doneCurrentLine}>
            Done
          </button>
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
              <section>
                <h3>ローカルのみ</h3>
                <pre>
                  {conflictDiff.localOnly.length > 0
                    ? conflictDiff.localOnly.map((line) => `- ${line}`).join('\n')
                    : '差分なし'}
                  {conflictDiff.localOverflow > 0 ? `\n...他 ${conflictDiff.localOverflow} 行` : ''}
                </pre>
              </section>
              <section>
                <h3>リモートのみ</h3>
                <pre>
                  {conflictDiff.remoteOnly.length > 0
                    ? conflictDiff.remoteOnly.map((line) => `+ ${line}`).join('\n')
                    : '差分なし'}
                  {conflictDiff.remoteOverflow > 0 ? `\n...他 ${conflictDiff.remoteOverflow} 行` : ''}
                </pre>
              </section>
            </div>
            <div className="conflict-actions">
              <button type="button" onClick={resolveConflictWithLocal}>
                この内容で保存
              </button>
              <button type="button" className="primary-button" onClick={resolveConflictWithRemote}>
                リモートを読み込む
              </button>
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
          {formatEstimateMinutes(todayTaskSummary.estimatedMinutes)}
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
