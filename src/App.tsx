import { Prec, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from '@codemirror/search'
import { basicSetup, EditorView } from 'codemirror'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  joinEnhancedFilterParts,
  splitForEnhancedFilter,
  type EnhancedFilterParts,
} from './domain/enhancedFilter'
import {
  getRefValueFromLine,
  formatEstimateMinutes,
  isUrlRef,
  normalizeDocumentText,
  shiftTaskDateLine,
  summarizeTodayTasks,
  toggleTaskStartEndLineWithNext,
} from './domain/editaskText'
import { editaskHighlightExtensions } from './editor/editaskExtensions'
import { db, firebaseEnabled } from './firebase/client'
import { deleteFile, ensureFileFromDefault, loadFile, saveFile } from './firebase/fileRepository'
import { useAuthUser } from './hooks/useAuthUser'

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

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
  const enhancedFilterInputRef = useRef<HTMLInputElement | null>(null)
  const userRef = useRef(user)
  const fileNameRef = useRef(fileNameFromHash())
  const enhancedFilterActiveRef = useRef(false)
  const enhancedFilterOpenRef = useRef(false)
  const parkedTextRef = useRef('')
  const [fileName, setFileName] = useState(fileNameFromHash)
  const [enhancedFilterQuery, setEnhancedFilterQuery] = useState('')
  const [enhancedFilterOpen, setEnhancedFilterOpen] = useState(false)
  const [enhancedFilterActive, setEnhancedFilterActive] = useState(false)
  const [enhancedFilterVisibleCount, setEnhancedFilterVisibleCount] = useState<number | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [todayTaskSummary, setTodayTaskSummary] = useState(() => summarizeTodayTasks(''))

  useEffect(() => {
    userRef.current = user
  }, [user])

  useEffect(() => {
    fileNameRef.current = fileName
    document.title = fileName || 'EdiTask'
  }, [fileName])

  useEffect(() => {
    enhancedFilterActiveRef.current = enhancedFilterActive
  }, [enhancedFilterActive])

  useEffect(() => {
    enhancedFilterOpenRef.current = enhancedFilterOpen
  }, [enhancedFilterOpen])

  const statusLabel = useMemo(() => {
    if (saveState === 'dirty') return 'Unsaved'
    if (saveState === 'saving') return 'Saving'
    if (saveState === 'saved') return 'Saved'
    if (saveState === 'error') return 'Error'
    return 'Idle'
  }, [saveState])

  const loadCurrentFile = useCallback(async () => {
    const currentUser = userRef.current
    const currentFileName = fileNameRef.current
    if (!db || !currentUser) return

    try {
      const loaded = await loadFile(db, currentUser.uid, currentFileName)
      parkedTextRef.current = ''
      enhancedFilterActiveRef.current = false
      enhancedFilterOpenRef.current = false
      setEnhancedFilterActive(false)
      setEnhancedFilterOpen(false)
      setEnhancedFilterQuery('')
      setEnhancedFilterVisibleCount(null)
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
    if (!db || !currentUser || !editorView.current) return

    setSaveState('saving')
    const editorText = editorView.current.state.doc.toString()
    const selectionHead = editorView.current.state.selection.main.head
    const textToSave = enhancedFilterActiveRef.current
      ? joinEnhancedFilterParts(parkedTextRef.current, editorText)
      : editorText
    const normalized = normalizeDocumentText(textToSave)

    try {
      await saveFile(db, currentUser.uid, currentFileName, normalized)
      if (enhancedFilterActiveRef.current) {
      } else {
        const nextSelection = Math.min(selectionHead, normalized.length)
        editorView.current.dispatch({
          changes: { from: 0, to: editorView.current.state.doc.length, insert: normalized },
          selection: { anchor: nextSelection },
          scrollIntoView: true,
        })
      }
      setTodayTaskSummary(summarizeTodayTasks(normalized))
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }, [])

  const deleteCurrentFile = useCallback(async () => {
    const currentUser = userRef.current
    const currentFileName = fileNameRef.current
    if (!db || !currentUser || !editorView.current) return

    const confirmed = window.confirm(`Delete "${currentFileName}"? This cannot be undone.`)
    if (!confirmed) return

    setSaveState('saving')
    try {
      await deleteFile(db, currentUser.uid, currentFileName)
      parkedTextRef.current = ''
      enhancedFilterActiveRef.current = false
      enhancedFilterOpenRef.current = false
      setEnhancedFilterActive(false)
      setEnhancedFilterOpen(false)
      setEnhancedFilterQuery('')
      setEnhancedFilterVisibleCount(null)
      editorView.current.dispatch({
        changes: { from: 0, to: editorView.current.state.doc.length, insert: '' },
      })
      setTodayTaskSummary(summarizeTodayTasks(''))
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }, [])

  const applyEnhancedFilterParts = useCallback((parts: EnhancedFilterParts) => {
    parkedTextRef.current = parts.parkedText
    enhancedFilterActiveRef.current = true
    setEnhancedFilterActive(true)
    setEnhancedFilterVisibleCount(parts.visibleCount)
    editorView.current?.dispatch({
      changes: {
        from: 0,
        to: editorView.current.state.doc.length,
        insert: parts.visibleText,
      },
    })
    setSaveState((state) => (state === 'saving' ? state : 'dirty'))
  }, [])

  const applyEnhancedFilter = useCallback(
    (query: string) => {
      const view = editorView.current
      if (!view) return
      const baseText = enhancedFilterActiveRef.current
        ? normalizeDocumentText(joinEnhancedFilterParts(parkedTextRef.current, view.state.doc.toString()))
        : view.state.doc.toString()
      applyEnhancedFilterParts(splitForEnhancedFilter(baseText, query))
    },
    [applyEnhancedFilterParts],
  )

  const closeEnhancedFilter = useCallback(() => {
    const view = editorView.current
    if (!view) {
      enhancedFilterActiveRef.current = false
      enhancedFilterOpenRef.current = false
      setEnhancedFilterOpen(false)
      setEnhancedFilterQuery('')
      setEnhancedFilterActive(false)
      setEnhancedFilterVisibleCount(null)
      parkedTextRef.current = ''
      return
    }

    if (!enhancedFilterActiveRef.current) {
      enhancedFilterOpenRef.current = false
      setEnhancedFilterOpen(false)
      setEnhancedFilterQuery('')
      setEnhancedFilterVisibleCount(null)
      view.focus()
      return
    }

    const fullText = enhancedFilterActiveRef.current
      ? joinEnhancedFilterParts(parkedTextRef.current, view.state.doc.toString())
      : view.state.doc.toString()
    const normalized = normalizeDocumentText(fullText)
    parkedTextRef.current = ''
    enhancedFilterActiveRef.current = false
    enhancedFilterOpenRef.current = false
    setEnhancedFilterOpen(false)
    setEnhancedFilterQuery('')
    setEnhancedFilterActive(false)
    setEnhancedFilterVisibleCount(null)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: normalized } })
    setSaveState((state) => (state === 'saving' ? state : 'dirty'))
    view.focus()
  }, [])

  const openEnhancedFilter = useCallback(() => {
    enhancedFilterOpenRef.current = true
    setEnhancedFilterOpen(true)
    window.setTimeout(() => enhancedFilterInputRef.current?.focus(), 0)
  }, [])

  const toggleEnhancedFilter = useCallback(() => {
    if (enhancedFilterOpenRef.current) {
      closeEnhancedFilter()
    } else {
      openEnhancedFilter()
    }
    return true
  }, [closeEnhancedFilter, openEnhancedFilter])

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
      window.alert('ref not found')
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

  useEffect(() => {
    updateHashFileName(fileName)
  }, [fileName])

  useEffect(() => {
    void loadCurrentFile()
  }, [fileName, loadCurrentFile, user])

  useEffect(() => {
    if (!enhancedFilterOpen) return undefined
    if (!enhancedFilterQuery.trim() && !enhancedFilterActiveRef.current) {
      setEnhancedFilterVisibleCount(null)
      return undefined
    }
    const timer = window.setTimeout(() => {
      applyEnhancedFilter(enhancedFilterQuery)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [applyEnhancedFilter, enhancedFilterOpen, enhancedFilterQuery])

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
              run: toggleEnhancedFilter,
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
            if (enhancedFilterActiveRef.current) {
              setEnhancedFilterVisibleCount(update.state.doc.length > 0 ? update.state.doc.lines : 0)
            }
            setSaveState((state) => (state === 'saving' ? state : 'dirty'))
          }
        }),
        EditorView.domEventHandlers({
          keydown(event) {
            if (event.ctrlKey && event.key.toLowerCase() === 's') {
              event.preventDefault()
              void saveCurrentFile()
              return true
            }
            if (event.ctrlKey && event.key.toLowerCase() === 'r') {
              event.preventDefault()
              void openRef()
              return true
            }
            if (event.key === 'Escape' && enhancedFilterOpenRef.current) {
              event.preventDefault()
              closeEnhancedFilter()
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
    closeEnhancedFilter,
    openRef,
    saveCurrentFile,
    shiftSelectedTaskDates,
    toggleCurrentLineStartEnd,
    toggleEnhancedFilter,
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
          <span className={`save-state save-state-${saveState}`}>{statusLabel}</span>
        </div>
        <div className="session-controls">
          <span className="user-label">{user?.displayName ?? user?.email}</span>
          <button type="button" onClick={exportCurrentFile}>
            Export
          </button>
          <button type="button" className="danger-button" onClick={() => void deleteCurrentFile()}>
            Delete
          </button>
          <button type="button" onClick={() => void signOutUser()}>
            Logout
          </button>
        </div>
      </header>

      {enhancedFilterOpen && (
        <section className="enhanced-filter-bar">
          <label htmlFor="enhanced-filter-input">Enhanced Filter</label>
          <input
            id="enhanced-filter-input"
            ref={enhancedFilterInputRef}
            value={enhancedFilterQuery}
            onChange={(event) => setEnhancedFilterQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'f') {
                event.preventDefault()
                closeEnhancedFilter()
                return
              }
              if (event.key === 'Escape') {
                closeEnhancedFilter()
              }
            }}
            placeholder="Search"
          />
          <span>
            {enhancedFilterActive
              ? `${enhancedFilterVisibleCount ?? 0} visible lines`
              : 'Type to filter lines'}
          </span>
          <button
            type="button"
            onClick={() => {
              closeEnhancedFilter()
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
          今日: {todayTaskSummary.remaining} 完了: {todayTaskSummary.completed} 作業予測:{' '}
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
