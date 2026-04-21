import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Plotly from 'plotly.js-dist-min'
import { lttb, sampleAt, snapTimestamp, statsInRange, stepSample } from './lttb'

type DbcSummary = { version: string; messageCount: number; signalCount: number }
type TraceSignalSummary = {
  key: string
  signalName: string
  messageName: string
  sa: number | null
  unit: string
  enum: Record<number, string> | null
  count: number
}
type SignalPayload = {
  key: string
  signalName: string
  messageName: string
  sa: number | null
  unit: string
  enum: Record<number, string> | null
  timestamps: Float64Array
  values: Float64Array
}

const LTTB_THRESHOLD = 2000
type ProgressStage = 'reading' | 'parsing' | 'decoding' | 'indexing'
type TraceProgress = { stage: ProgressStage; current: number; total: number }

type DbcLoaded = { path: string; summary: DbcSummary; decodable: boolean }
type TraceLoaded = {
  path: string
  frameCount: number
  skipped: number
  warnings: string[]
}

type PaneTrace = { key: string; axis: 'left' | 'right' }
type Pane = { id: string; title: string; traces: PaneTrace[] }

const payloadCache = new Map<string, SignalPayload>()

async function getPayload(key: string): Promise<SignalPayload | null> {
  const cached = payloadCache.get(key)
  if (cached) return cached
  const p = await window.api.getSignal(key)
  if (p) payloadCache.set(key, p)
  return p
}

function basename(p: string): string {
  const ix = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return ix >= 0 ? p.slice(ix + 1) : p
}

function formatSa(sa: number | null): string {
  return sa === null ? '—' : `0x${sa.toString(16).padStart(2, '0').toUpperCase()}`
}

function traceLabel(p: SignalPayload): string {
  return p.sa === null ? p.signalName : `${p.signalName} @ SA ${formatSa(p.sa)}`
}

function formatSample(v: number | null, p: SignalPayload): string {
  if (v === null) return '—'
  if (p.enum) {
    const nearest = Math.round(v)
    const label = p.enum[nearest]
    if (label !== undefined) return label
  }
  return v.toFixed(3)
}

function nextPaneId(): string {
  return `p${Math.random().toString(36).slice(2, 9)}`
}

function App(): React.JSX.Element {
  const [dbc, setDbc] = useState<DbcLoaded | null>(null)
  const [trace, setTrace] = useState<TraceLoaded | null>(null)
  const [dbcError, setDbcError] = useState<string | null>(null)
  const [traceError, setTraceError] = useState<string | null>(null)
  const [signals, setSignals] = useState<TraceSignalSummary[]>([])
  const [filter, setFilter] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState<TraceProgress | null>(null)
  const [showDbcPicker, setShowDbcPicker] = useState(false)
  const [showTracePicker, setShowTracePicker] = useState(false)

  const [panes, setPanes] = useState<Pane[]>(() => [
    { id: nextPaneId(), title: 'Plot 1', traces: [] }
  ])
  const [activePaneId, setActivePaneId] = useState<string>(() => panes[0].id)

  const [xRange, setXRange] = useState<[number, number] | null>(null)
  const xRangeSource = useRef<string | null>(null)

  const [cursorA, setCursorA] = useState<number | null>(null)
  const [cursorB, setCursorB] = useState<number | null>(null)
  const [cursorMode, setCursorMode] = useState(false)
  const [cursorSnap, setCursorSnap] = useState(true)
  const nextCursor = useRef<'A' | 'B'>('A')
  const lastCursor = useRef<'A' | 'B' | null>(null)

  const loadedPayloadsForSnap = useCallback((): { timestamps: Float64Array }[] => {
    const seen = new Set<string>()
    const out: { timestamps: Float64Array }[] = []
    for (const p of [...payloadCache.values()]) {
      if (seen.has(p.key)) continue
      seen.add(p.key)
      out.push({ timestamps: p.timestamps })
    }
    return out
  }, [])

  const maybeSnap = useCallback(
    (t: number): number => (cursorSnap ? snapTimestamp(t, loadedPayloadsForSnap()) : t),
    [cursorSnap, loadedPayloadsForSnap]
  )

  const onCursorClick = useCallback(
    (t: number) => {
      const snapped = maybeSnap(t)
      if (nextCursor.current === 'A') {
        setCursorA(snapped)
        nextCursor.current = 'B'
        lastCursor.current = 'A'
      } else {
        setCursorB(snapped)
        nextCursor.current = 'A'
        lastCursor.current = 'B'
      }
    },
    [maybeSnap]
  )

  const onCursorDrag = useCallback(
    (which: 'A' | 'B', t: number) => {
      const snapped = maybeSnap(t)
      if (which === 'A') setCursorA(snapped)
      else setCursorB(snapped)
      lastCursor.current = which
    },
    [maybeSnap]
  )

  useEffect(() => {
    if (!cursorMode) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const which = lastCursor.current
      if (which === null) return
      const current = which === 'A' ? cursorA : cursorB
      if (current === null) return
      const ae = document.activeElement
      if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) return
      e.preventDefault()
      const dir = e.key === 'ArrowLeft' ? -1 : 1
      const mult = e.shiftKey ? 10 : 1
      let nextVal: number
      if (cursorSnap) {
        const payloads = loadedPayloadsForSnap()
        nextVal = current
        for (let i = 0; i < mult; i++) {
          const stepped = stepSample(nextVal, dir, payloads)
          if (stepped === null) break
          nextVal = stepped
        }
      } else {
        const span = xRange ? xRange[1] - xRange[0] : 1
        nextVal = current + dir * mult * 0.005 * span
      }
      if (which === 'A') setCursorA(nextVal)
      else setCursorB(nextVal)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cursorMode, cursorA, cursorB, cursorSnap, xRange, loadedPayloadsForSnap])

  const clearCursors = useCallback(() => {
    setCursorA(null)
    setCursorB(null)
    nextCursor.current = 'A'
    lastCursor.current = null
  }, [])

  useEffect(() => {
    const unsub = window.api.onTraceProgress((p) => setProgress(p))
    return unsub
  }, [])

  const restored = useRef(false)

  useEffect(() => {
    void (async () => {
      try {
        const saved = await window.api.readLayout()
        if (!saved) return
        if (saved.dbcPath) {
          const result = await window.api.loadDbc(saved.dbcPath)
          if (!result.ok) {
            setDbcError(`Could not restore last DBC: ${saved.dbcPath}`)
            return
          }
          setDbc({ path: saved.dbcPath, summary: result.summary, decodable: result.decodable })
          if (saved.tracePath) {
            const tr = await window.api.loadTrace(saved.tracePath)
            if (tr.ok) {
              setTrace({
                path: saved.tracePath,
                frameCount: tr.frameCount,
                skipped: tr.skipped,
                warnings: tr.warnings
              })
              setSignals(tr.signals)
            } else {
              setTraceError(`Could not restore last trace: ${saved.tracePath}`)
            }
          }
        }
        if (saved.panes.length > 0) {
          setPanes(saved.panes)
          setActivePaneId(saved.activePaneId ?? saved.panes[0].id)
        }
        setFilter(saved.filter)
        setOpenGroups(new Set(saved.openGroups))
        setCursorA(saved.cursors.a)
        setCursorB(saved.cursors.b)
        setCursorMode(saved.cursors.mode)
        setCursorSnap(saved.cursors.snap ?? true)
      } finally {
        restored.current = true
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!restored.current) return
    const handle = setTimeout(() => {
      void window.api.writeLayout({
        version: 1,
        dbcPath: dbc?.path ?? null,
        tracePath: trace?.path ?? null,
        panes,
        activePaneId,
        filter,
        openGroups: Array.from(openGroups),
        cursors: { a: cursorA, b: cursorB, mode: cursorMode, snap: cursorSnap }
      })
    }, 400)
    return () => clearTimeout(handle)
  }, [dbc, trace, panes, activePaneId, filter, openGroups, cursorA, cursorB, cursorMode, cursorSnap])

  const loadDbcPath = useCallback(async (filePath: string) => {
    setDbcError(null)
    setShowDbcPicker(false)
    const result = await window.api.loadDbc(filePath)
    if (result.ok) {
      setDbc({ path: filePath, summary: result.summary, decodable: result.decodable })
      setSignals([])
      setTrace(null)
      const fresh = { id: nextPaneId(), title: 'Plot 1', traces: [] }
      setPanes([fresh])
      setActivePaneId(fresh.id)
      payloadCache.clear()
    } else {
      setDbcError(result.error)
    }
  }, [])

  const loadTracePath = useCallback(async (filePath: string) => {
    setTraceError(null)
    setShowTracePicker(false)
    setProgress({ stage: 'reading', current: 0, total: 1 })
    const result = await window.api.loadTrace(filePath)
    setProgress(null)
    if (result.ok) {
      setTrace({
        path: filePath,
        frameCount: result.frameCount,
        skipped: result.skipped,
        warnings: result.warnings
      })
      setSignals(result.signals)
      payloadCache.clear()
      setPanes((prev) => prev.map((p) => ({ ...p, traces: [] })))
    } else {
      setTraceError(result.error)
    }
  }, [])

  const filtered = useMemo(() => {
    if (!filter) return signals
    const q = filter.toLowerCase()
    return signals.filter(
      (s) => s.signalName.toLowerCase().includes(q) || s.messageName.toLowerCase().includes(q)
    )
  }, [signals, filter])

  const grouped = useMemo(() => {
    const map = new Map<string, TraceSignalSummary[]>()
    for (const s of filtered) {
      const arr = map.get(s.messageName)
      if (arr) arr.push(s)
      else map.set(s.messageName, [s])
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered])

  const paneMembership = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const pane of panes) {
      for (const t of pane.traces) {
        const s = m.get(t.key) ?? new Set<string>()
        s.add(pane.id)
        m.set(t.key, s)
      }
    }
    return m
  }, [panes])

  const toggleSignal = useCallback(
    (key: string) => {
      setPanes((prev) =>
        prev.map((p) => {
          if (p.id !== activePaneId) return p
          const exists = p.traces.some((t) => t.key === key)
          return {
            ...p,
            traces: exists ? p.traces.filter((t) => t.key !== key) : [...p.traces, { key, axis: 'left' }]
          }
        })
      )
    },
    [activePaneId]
  )

  const toggleGroup = useCallback((name: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const addPane = useCallback(() => {
    setPanes((prev) => {
      const id = nextPaneId()
      const next = [...prev, { id, title: `Plot ${prev.length + 1}`, traces: [] }]
      setActivePaneId(id)
      return next
    })
  }, [])

  const removePane = useCallback(
    (id: string) => {
      setPanes((prev) => {
        const next = prev.filter((p) => p.id !== id)
        if (next.length === 0) {
          const fresh = { id: nextPaneId(), title: 'Plot 1', traces: [] }
          setActivePaneId(fresh.id)
          return [fresh]
        }
        if (id === activePaneId) setActivePaneId(next[0].id)
        return next
      })
    },
    [activePaneId]
  )

  const movePane = useCallback((id: string, dir: -1 | 1) => {
    setPanes((prev) => {
      const i = prev.findIndex((p) => p.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = prev.slice()
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }, [])

  const renamePane = useCallback((id: string, title: string) => {
    setPanes((prev) => prev.map((p) => (p.id === id ? { ...p, title } : p)))
  }, [])

  const flipTraceAxis = useCallback((paneId: string, key: string) => {
    setPanes((prev) =>
      prev.map((p) =>
        p.id !== paneId
          ? p
          : {
              ...p,
              traces: p.traces.map((t) =>
                t.key === key ? { ...t, axis: t.axis === 'left' ? 'right' : 'left' } : t
              )
            }
      )
    )
  }, [])

  const removeTrace = useCallback((paneId: string, key: string) => {
    setPanes((prev) =>
      prev.map((p) => (p.id !== paneId ? p : { ...p, traces: p.traces.filter((t) => t.key !== key) }))
    )
  }, [])

  const onPaneXZoom = useCallback((paneId: string, range: [number, number] | null) => {
    xRangeSource.current = paneId
    setXRange(range)
  }, [])

  const pickDbc = async (): Promise<void> => {
    const p = await window.api.pickDbc()
    if (p) loadDbcPath(p)
  }
  const pickTrace = async (): Promise<void> => {
    const p = await window.api.pickTrace()
    if (p) loadTracePath(p)
  }

  const fullyLoaded = dbc !== null && trace !== null

  return (
    <div className={`app${fullyLoaded ? ' app--loaded' : ''}`}>
      {fullyLoaded ? (
        <NavBar
          dbcName={basename(dbc!.path)}
          traceName={basename(trace!.path)}
          onChangeDbc={() => setShowDbcPicker(true)}
          onChangeTrace={() => setShowTracePicker(true)}
        />
      ) : (
        <header className="header">
          <h1>CAN Trace Viewer</h1>
        </header>
      )}

      {!fullyLoaded && (
        <main className="main">
          <div className="row">
            <FileZone
              label={dbc ? `DBC loaded: ${basename(dbc.path)}` : 'Drop a DBC (.dbc or .json)'}
              onFile={loadDbcPath}
              onBrowse={pickDbc}
            />
            <FileZone
              label={
                trace
                  ? `Trace loaded: ${basename(trace.path)}`
                  : 'Drop a trace file (.trc v2.1 or .mf4)'
              }
              onFile={loadTracePath}
              onBrowse={pickTrace}
            />
          </div>
          {dbcError && <section className="status status--err">DBC error: {dbcError}</section>}
          {traceError && (
            <section className="status status--err">Trace error: {traceError}</section>
          )}
          {dbc && !trace && (
            <section className="status status--ok">
              <div className="status__path">{dbc.path}</div>
              <dl className="summary">
                <dt>Messages</dt>
                <dd>{dbc.summary.messageCount}</dd>
                <dt>Signals</dt>
                <dd>{dbc.summary.signalCount}</dd>
              </dl>
            </section>
          )}
        </main>
      )}

      {fullyLoaded && (
        <div className="workspace">
          <aside className="picker">
            <div className="picker-toolbar">
              <input
                type="text"
                placeholder={`Filter ${signals.length} signals…`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="signal-list">
              {grouped.map(([msgName, sigs]) => {
                const isOpen = filter.length > 0 || openGroups.has(msgName)
                const selCount = sigs.filter((s) => paneMembership.has(s.key)).length
                return (
                  <div key={msgName} className="signal-group">
                    <button
                      type="button"
                      className="signal-group__header"
                      onClick={() => toggleGroup(msgName)}
                    >
                      <span className="caret">{isOpen ? '▾' : '▸'}</span>
                      <span className="msg-name">{msgName}</span>
                      <span className="sig-count">
                        {selCount > 0 ? `${selCount}/${sigs.length}` : sigs.length}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="signal-group__body">
                        {sigs.map((s) => {
                          const inActive = panes
                            .find((p) => p.id === activePaneId)
                            ?.traces.some((t) => t.key === s.key)
                          const members = paneMembership.get(s.key) ?? new Set<string>()
                          return (
                            <button
                              key={s.key}
                              className={inActive ? 'selected' : ''}
                              onClick={() => toggleSignal(s.key)}
                            >
                              <span className="pane-dots">
                                {panes.map((p, i) => (
                                  <span
                                    key={p.id}
                                    className={`pane-dot${members.has(p.id) ? ' pane-dot--on' : ''}`}
                                    title={p.title}
                                  >
                                    {i + 1}
                                  </span>
                                ))}
                              </span>
                              {s.signalName}
                              {s.unit && <span className="sig-unit">[{s.unit}]</span>}
                              <span className="sig-sa">SA {formatSa(s.sa)}</span>
                              <span className="sig-count">{s.count.toLocaleString()}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </aside>

          <section className="pane-stack">
            <div className="pane-stack__toolbar">
              <button type="button" onClick={addPane}>
                + Add plot
              </button>
              <button
                type="button"
                className={cursorMode ? 'btn--active' : ''}
                onClick={() => setCursorMode((v) => !v)}
                title="Click on a plot to place cursor A, then B"
              >
                Cursors: {cursorMode ? 'ON' : 'OFF'}
              </button>
              <button
                type="button"
                className={cursorSnap ? 'btn--active' : ''}
                onClick={() => setCursorSnap((v) => !v)}
                title="Snap cursor to nearest loaded sample"
              >
                Snap: {cursorSnap ? 'ON' : 'OFF'}
              </button>
              <button
                type="button"
                onClick={clearCursors}
                disabled={cursorA === null && cursorB === null}
              >
                Clear cursors
              </button>
              <button
                type="button"
                onClick={async () => {
                  const active = panes.find((p) => p.id === activePaneId)
                  if (!active || active.traces.length === 0) return
                  const r = await window.api.exportCsv({
                    keys: active.traces.map((t) => t.key),
                    xStart: xRange ? xRange[0] : null,
                    xEnd: xRange ? xRange[1] : null
                  })
                  if (!r.ok) setTraceError(r.error)
                }}
                disabled={(panes.find((p) => p.id === activePaneId)?.traces.length ?? 0) === 0}
                title="Export active pane as CSV (current zoom)"
              >
                Export CSV
              </button>
            </div>
            {panes.map((pane, idx) => (
              <PaneView
                key={pane.id}
                pane={pane}
                index={idx}
                total={panes.length}
                active={pane.id === activePaneId}
                onActivate={() => setActivePaneId(pane.id)}
                onRename={(t) => renamePane(pane.id, t)}
                onRemove={() => removePane(pane.id)}
                onMoveUp={() => movePane(pane.id, -1)}
                onMoveDown={() => movePane(pane.id, 1)}
                onFlipAxis={(k) => flipTraceAxis(pane.id, k)}
                onRemoveTrace={(k) => removeTrace(pane.id, k)}
                xRange={xRange}
                xRangeSource={xRangeSource.current}
                onXZoom={(r) => onPaneXZoom(pane.id, r)}
                cursorA={cursorA}
                cursorB={cursorB}
                cursorMode={cursorMode}
                onCursorClick={onCursorClick}
                onCursorDrag={onCursorDrag}
              />
            ))}
          </section>
        </div>
      )}

      {showDbcPicker && fullyLoaded && (
        <Modal onClose={() => setShowDbcPicker(false)} title="Change DBC">
          <FileZone
            label="Drop a DBC (.dbc or .json)"
            onFile={loadDbcPath}
            onBrowse={pickDbc}
          />
          {dbcError && <section className="status status--err">DBC error: {dbcError}</section>}
        </Modal>
      )}

      {showTracePicker && fullyLoaded && (
        <Modal onClose={() => setShowTracePicker(false)} title="Change Trace">
          <FileZone
            label="Drop a trace file (.trc v2.1 or .mf4)"
            onFile={loadTracePath}
            onBrowse={pickTrace}
          />
          {traceError && (
            <section className="status status--err">Trace error: {traceError}</section>
          )}
        </Modal>
      )}

      {progress && <ProgressOverlay progress={progress} />}
    </div>
  )
}

function NavBar({
  dbcName,
  traceName,
  onChangeDbc,
  onChangeTrace
}: {
  dbcName: string
  traceName: string
  onChangeDbc: () => void
  onChangeTrace: () => void
}): React.JSX.Element {
  return (
    <nav className="navbar">
      <span className="navbar__brand">CAN Trace Viewer</span>
      <span className="navbar__item">
        <span className="navbar__label">DBC:</span>
        <span className="navbar__file" title={dbcName}>
          {dbcName}
        </span>
        <button type="button" onClick={onChangeDbc}>
          Change
        </button>
      </span>
      <span className="navbar__item">
        <span className="navbar__label">Trace:</span>
        <span className="navbar__file" title={traceName}>
          {traceName}
        </span>
        <button type="button" onClick={onChangeTrace}>
          Change
        </button>
      </span>
    </nav>
  )
}

function Modal({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <span>{title}</span>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  )
}

function ProgressOverlay({ progress }: { progress: TraceProgress }): React.JSX.Element {
  const pct = progress.total > 0 ? Math.floor((progress.current / progress.total) * 100) : 0
  return (
    <div className="progress-backdrop">
      <div className="progress">
        <div className="progress__label">
          {progress.stage.charAt(0).toUpperCase() + progress.stage.slice(1)}… {pct}%
        </div>
        <div className="progress__bar">
          <div className="progress__fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  )
}

function FileZone({
  label,
  onFile,
  onBrowse
}: {
  label: string
  onFile: (path: string) => void
  onBrowse: () => void
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  return (
    <div
      className={`dropzone${dragging ? ' dropzone--active' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const file = e.dataTransfer.files?.[0]
        if (!file) return
        const path = window.api.getPathForFile(file)
        if (path) onFile(path)
      }}
    >
      <p>{label}</p>
      <button type="button" onClick={onBrowse}>
        Browse…
      </button>
    </div>
  )
}

function PaneView({
  pane,
  index,
  total,
  active,
  onActivate,
  onRename,
  onRemove,
  onMoveUp,
  onMoveDown,
  onFlipAxis,
  onRemoveTrace,
  xRange,
  xRangeSource,
  onXZoom,
  cursorA,
  cursorB,
  cursorMode,
  onCursorClick,
  onCursorDrag
}: {
  pane: Pane
  index: number
  total: number
  active: boolean
  onActivate: () => void
  onRename: (t: string) => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onFlipAxis: (k: string) => void
  onRemoveTrace: (k: string) => void
  xRange: [number, number] | null
  xRangeSource: string | null
  onXZoom: (r: [number, number] | null) => void
  cursorA: number | null
  cursorB: number | null
  cursorMode: boolean
  onCursorClick: (t: number) => void
  onCursorDrag: (which: 'A' | 'B', t: number) => void
}): React.JSX.Element {
  const divRef = useRef<HTMLDivElement>(null)
  const [payloads, setPayloads] = useState<Map<string, SignalPayload>>(new Map())
  const zoomDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetchAll = async (): Promise<void> => {
      const entries = await Promise.all(
        pane.traces.map(async (t): Promise<[string, SignalPayload] | null> => {
          const p = await getPayload(t.key)
          return p ? [t.key, p] : null
        })
      )
      if (cancelled) return
      const m = new Map<string, SignalPayload>()
      for (const e of entries) if (e) m.set(e[0], e[1])
      setPayloads(m)
    }
    fetchAll()
    return () => {
      cancelled = true
    }
  }, [pane.traces])

  const leftUnits = useMemo(() => {
    const s = new Set<string>()
    for (const t of pane.traces) if (t.axis === 'left') s.add(payloads.get(t.key)?.unit ?? '')
    return s
  }, [pane.traces, payloads])
  const rightUnits = useMemo(() => {
    const s = new Set<string>()
    for (const t of pane.traces) if (t.axis === 'right') s.add(payloads.get(t.key)?.unit ?? '')
    return s
  }, [pane.traces, payloads])

  const axisTitle = (units: Set<string>): string => {
    if (units.size === 0) return ''
    if (units.size === 1) return Array.from(units)[0]
    return 'mixed'
  }

  useEffect(() => {
    if (!divRef.current) return
    if (pane.traces.length === 0) {
      Plotly.purge(divRef.current)
      return
    }
    const x0 = xRange ? xRange[0] : undefined
    const x1 = xRange ? xRange[1] : undefined
    const traces = pane.traces
      .map((t) => {
        const p = payloads.get(t.key)
        if (!p) return null
        const sampled = lttb(p.timestamps, p.values, LTTB_THRESHOLD, x0, x1)
        const label = traceLabel(p)
        const text = p.enum
          ? sampled.y.map((v) => p.enum![Math.round(v)] ?? v.toFixed(3))
          : undefined
        return {
          type: 'scatter' as const,
          mode: 'lines' as const,
          x: sampled.x,
          y: sampled.y,
          name: label,
          yaxis: t.axis === 'right' ? 'y2' : 'y',
          text,
          hovertemplate: p.enum
            ? `%{text}<br>t=%{x:.3f}s<extra>${label}</extra>`
            : `%{y:.3f}${p.unit ? ' ' + p.unit : ''}<br>t=%{x:.3f}s<extra>${label}</extra>`
        }
      })
      .filter((t): t is NonNullable<typeof t> => t !== null)

    const shapes: Partial<Plotly.Shape>[] = []
    const annotations: Partial<Plotly.Annotations>[] = []
    let aShapeIdx = -1
    let bShapeIdx = -1
    const addCursor = (x: number, color: string, label: string): number => {
      const idx = shapes.length
      shapes.push({
        type: 'line',
        xref: 'x',
        yref: 'paper',
        x0: x,
        x1: x,
        y0: 0,
        y1: 1,
        line: { color, width: 1, dash: 'dash' }
      })
      annotations.push({
        xref: 'x',
        yref: 'paper',
        x,
        y: 1,
        yanchor: 'bottom',
        text: label,
        showarrow: false,
        font: { color, size: 11 },
        bgcolor: '#1a1b1e'
      })
      return idx
    }
    if (cursorA !== null) aShapeIdx = addCursor(cursorA, '#4aa3ff', 'A')
    if (cursorB !== null) bShapeIdx = addCursor(cursorB, '#ff8c5a', 'B')

    const layout: Partial<Plotly.Layout> = {
      margin: { l: 60, r: 60, t: 10, b: 40 },
      paper_bgcolor: '#1a1b1e',
      plot_bgcolor: '#1a1b1e',
      font: { color: '#e6e6e6' },
      xaxis: { gridcolor: '#333', ...(xRange ? { range: xRange } : {}) },
      yaxis: { gridcolor: '#333', title: { text: axisTitle(leftUnits) } },
      yaxis2: {
        gridcolor: '#444',
        overlaying: 'y',
        side: 'right',
        title: { text: axisTitle(rightUnits) },
        showgrid: false
      },
      showlegend: false,
      shapes,
      annotations
    }
    Plotly.react(divRef.current, traces, layout, {
      responsive: true,
      displaylogo: false,
      edits: { shapePosition: true }
    })

    const relayoutHandler = (ev: Plotly.PlotRelayoutEvent): void => {
      for (const k of Object.keys(ev)) {
        const m = k.match(/^shapes\[(\d+)\]\.x0$/)
        if (!m) continue
        const idx = Number(m[1])
        const x = (ev as Record<string, unknown>)[k]
        if (typeof x !== 'number') continue
        if (idx === aShapeIdx) onCursorDrag('A', x)
        else if (idx === bShapeIdx) onCursorDrag('B', x)
      }
      if (zoomDebounce.current) clearTimeout(zoomDebounce.current)
      zoomDebounce.current = setTimeout(() => {
        if (ev['xaxis.autorange']) {
          onXZoom(null)
          return
        }
        const rx0 = ev['xaxis.range[0]']
        const rx1 = ev['xaxis.range[1]']
        if (typeof rx0 === 'number' && typeof rx1 === 'number') onXZoom([rx0, rx1])
      }, 16)
    }
    const clickHandler = (ev: Plotly.PlotMouseEvent): void => {
      if (!cursorMode) return
      const x = ev.points?.[0]?.x
      if (typeof x === 'number') onCursorClick(x)
    }
    const el = divRef.current as unknown as {
      on: (ev: string, cb: (e: unknown) => void) => void
      removeAllListeners: (ev: string) => void
    }
    el.on('plotly_relayout', relayoutHandler as (e: unknown) => void)
    el.on('plotly_click', clickHandler as (e: unknown) => void)
    return () => {
      el.removeAllListeners?.('plotly_relayout')
      el.removeAllListeners?.('plotly_click')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.traces, payloads, leftUnits, rightUnits, xRange, cursorA, cursorB, cursorMode])

  useEffect(() => {
    if (!divRef.current || pane.traces.length === 0) return
    if (xRangeSource === pane.id) return
    Plotly.relayout(
      divRef.current,
      xRange ? { 'xaxis.range': xRange } : { 'xaxis.autorange': true }
    )
  }, [xRange, xRangeSource, pane.id, pane.traces.length])

  const cursorRows = useMemo(() => {
    if (cursorA === null && cursorB === null) return null
    const rows = pane.traces.map((t) => {
      const p = payloads.get(t.key)
      if (!p)
        return {
          key: t.key,
          name: t.key,
          unit: '',
          a: null,
          b: null,
          delta: null,
          isEnum: false,
          stats: null as null | { min: string; max: string; mean: string; count: number }
        }
      const a =
        cursorA !== null ? sampleAt(p.timestamps, p.values, cursorA, !!p.enum) : null
      const b =
        cursorB !== null ? sampleAt(p.timestamps, p.values, cursorB, !!p.enum) : null
      const delta = a !== null && b !== null ? b - a : null
      let stats: { min: string; max: string; mean: string; count: number } | null = null
      if (cursorA !== null && cursorB !== null) {
        const raw = statsInRange(p.timestamps, p.values, cursorA, cursorB)
        if (raw) {
          if (p.enum) {
            const mnLbl = p.enum[Math.round(raw.min)]
            const same = raw.min === raw.max && mnLbl !== undefined
            stats = same
              ? { min: mnLbl, max: mnLbl, mean: mnLbl, count: raw.count }
              : { min: '—', max: '—', mean: '—', count: raw.count }
          } else {
            stats = {
              min: raw.min.toFixed(3),
              max: raw.max.toFixed(3),
              mean: raw.mean.toFixed(3),
              count: raw.count
            }
          }
        }
      }
      return {
        key: t.key,
        name: traceLabel(p),
        unit: p.unit,
        a: a !== null ? formatSample(a, p) : null,
        b: b !== null ? formatSample(b, p) : null,
        delta,
        isEnum: !!p.enum,
        stats
      }
    })
    return rows
  }, [pane.traces, payloads, cursorA, cursorB])

  return (
    <div
      className={`pane${active ? ' pane--active' : ''}`}
      onClick={onActivate}
      onFocus={onActivate}
    >
      <div className="pane__header">
        <input
          className="pane__title"
          value={pane.title}
          onChange={(e) => onRename(e.target.value)}
        />
        <div className="pane__actions">
          <button
            type="button"
            disabled={pane.traces.length === 0}
            onClick={async () => {
              if (!divRef.current) return
              const dataUrl = await Plotly.toImage(divRef.current, {
                format: 'png',
                width: 1920,
                height: 1080
              })
              const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
              const bin = atob(base64)
              const bytes = new Uint8Array(bin.length)
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
              await window.api.exportPng({
                bytes,
                suggestedName: `${pane.title || 'plot'}.png`
              })
            }}
            title="Export pane as PNG"
          >
            PNG
          </button>
          {total > 1 && (
            <>
              <button type="button" disabled={index === 0} onClick={onMoveUp} title="Move up">
                ↑
              </button>
              <button
                type="button"
                disabled={index === total - 1}
                onClick={onMoveDown}
                title="Move down"
              >
                ↓
              </button>
              <button type="button" onClick={onRemove} title="Remove pane">
                ×
              </button>
            </>
          )}
        </div>
      </div>
      {pane.traces.length === 0 ? (
        <div className="pane__placeholder">Toggle signals from the picker to add them here</div>
      ) : (
        <>
          <div ref={divRef} className="plot" />
          {cursorRows && (
            <div className="cursor-readout">
              <div className="cursor-readout__time">
                {cursorA !== null && <span>A = {cursorA.toFixed(3)}s</span>}
                {cursorB !== null && <span>B = {cursorB.toFixed(3)}s</span>}
                {cursorA !== null && cursorB !== null && (
                  <span>Δt = {(cursorB - cursorA).toFixed(3)}s</span>
                )}
              </div>
              <div className="cursor-readout__rows">
                {cursorRows.map((r) => (
                  <div key={r.key} className="cursor-readout__row">
                    <span className="cursor-readout__name">{r.name}</span>
                    {r.a !== null && (
                      <span>
                        A={r.a}
                        {r.unit && !r.isEnum ? ` ${r.unit}` : ''}
                      </span>
                    )}
                    {r.b !== null && (
                      <span>
                        B={r.b}
                        {r.unit && !r.isEnum ? ` ${r.unit}` : ''}
                      </span>
                    )}
                    {r.delta !== null && !r.isEnum && (
                      <span>
                        Δ={r.delta.toFixed(3)}
                        {r.unit ? ` ${r.unit}` : ''}
                      </span>
                    )}
                    {r.stats && (
                      <>
                        <span>min={r.stats.min}</span>
                        <span>max={r.stats.max}</span>
                        <span>mean={r.stats.mean}</span>
                        <span className="cursor-readout__count">n={r.stats.count}</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="pane__legend">
            {pane.traces.map((t) => {
              const p = payloads.get(t.key)
              return (
                <span key={t.key} className="legend-item">
                  <span className="legend-name">{p ? traceLabel(p) : t.key}</span>
                  {p?.unit && <span className="legend-unit">[{p.unit}]</span>}
                  <button
                    type="button"
                    className={`legend-axis legend-axis--${t.axis}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onFlipAxis(t.key)
                    }}
                    title="Toggle left/right axis"
                  >
                    {t.axis === 'left' ? 'L' : 'R'}
                  </button>
                  <button
                    type="button"
                    className="legend-remove"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRemoveTrace(t.key)
                    }}
                    title="Remove from pane"
                  >
                    ×
                  </button>
                </span>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

export default App
