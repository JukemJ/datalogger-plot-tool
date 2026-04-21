# Phase 5c — Layout persistence + docs sync

Two tracks land together. The feature work (layout persistence) is small and user-facing. The docs sync catches up README + CLAUDE.md for Phase 5a (MF4) and 5b (chart UX), which are merged but only partially reflected in the docs.

## Part A — Layout persistence

### Goal

On app launch, restore:

- Last-loaded DBC path (if the file still exists).
- Last-loaded trace path (if the file still exists).
- Pane layout: pane list, pane titles, per-pane trace keys + left/right axis assignment, active pane.
- UI state: filter text, open signal-groups, cursor A/B positions and mode.

On every relevant state change, persist the above (debounced) to a JSON file in Electron's `userData` directory.

Explicitly **not** persisted:

- `xRange` (zoom) — feels more natural to start un-zoomed; zoom state is tied to a session, not a workspace.
- Payload cache (it's derived; always regenerated from the trace).

### Storage

New file: [src/main/store.ts](src/main/store.ts).

```ts
import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname, join } from 'path'

export type Layout = {
  version: 1
  dbcPath: string | null
  tracePath: string | null
  panes: { id: string; title: string; traces: { key: string; axis: 'left' | 'right' }[] }[]
  activePaneId: string | null
  filter: string
  openGroups: string[]
  cursors: { a: number | null; b: number | null; mode: boolean }
}

const layoutPath = () => join(app.getPath('userData'), 'layout.json')

export async function readLayout(): Promise<Layout | null> { ... }
export async function writeLayout(l: Layout): Promise<void> { ... }
```

- `readLayout` returns `null` on missing file, parse error, or `version !== 1`. Don't throw — a corrupt layout should not block launch.
- `writeLayout` writes atomically: write to `layout.json.tmp` then `rename` over `layout.json`. Ensures no half-written file if Electron is killed mid-write.
- `mkdir(dirname(path), { recursive: true })` before first write. `userData` is created by Electron, but defensive mkdir is cheap.

### IPC

Two handlers in [src/main/index.ts](src/main/index.ts), alongside the existing `dbc:*` / `trace:*`:

```ts
ipcMain.handle('layout:read', async (): Promise<Layout | null> => readLayout())
ipcMain.handle('layout:write', async (_e, layout: Layout): Promise<void> => writeLayout(layout))
```

Preload bridge ([src/preload/index.ts](src/preload/index.ts)):

```ts
readLayout: () => ipcRenderer.invoke('layout:read'),
writeLayout: (l: Layout) => ipcRenderer.invoke('layout:write', l),
```

Export the `Layout` type from a shared location ([src/main/store.ts](src/main/store.ts)) and re-declare structurally in the renderer types block at the top of [src/renderer/src/App.tsx](src/renderer/src/App.tsx). No need for a cross-process type package.

### Restore flow

In `App`, add one effect that runs once on mount:

```ts
useEffect(() => {
  (async () => {
    const saved = await window.api.readLayout()
    if (!saved) return
    if (saved.dbcPath) {
      const result = await window.api.loadDbc(saved.dbcPath)
      if (!result.ok) { /* file gone — skip silently, leave UI empty */ return }
      // apply DBC state without clobbering the rest of the layout
      setDbc({ path: saved.dbcPath, summary: result.summary, decodable: result.decodable })
    }
    if (saved.tracePath && saved.dbcPath) {
      const result = await window.api.loadTrace(saved.tracePath)
      if (!result.ok) return
      setTrace({ path: saved.tracePath, frameCount: result.frameCount, skipped: result.skipped, warnings: result.warnings })
      setSignals(result.signals)
    }
    setPanes(saved.panes)
    setActivePaneId(saved.activePaneId ?? saved.panes[0]?.id ?? nextPaneId())
    setFilter(saved.filter)
    setOpenGroups(new Set(saved.openGroups))
    setCursorA(saved.cursors.a)
    setCursorB(saved.cursors.b)
    setCursorMode(saved.cursors.mode)
  })()
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [])
```

Two subtle correctness points:

1. **Order matters.** DBC load must succeed *before* trace load (trace decode depends on the DBC lookup maps in main-process state). Await sequentially, not in parallel. This mirrors the existing manual flow.
2. **Existing `loadDbcPath` / `loadTracePath` reset panes** — they clear `panes` and `payloadCache` to avoid stale references. The restore path cannot use them verbatim; inline the IPC calls and apply state directly, as above. Don't call `setPanes([freshPane])` during restore.

### Persist flow

One effect with debounced writes:

```ts
useEffect(() => {
  const handle = setTimeout(() => {
    window.api.writeLayout({
      version: 1,
      dbcPath: dbc?.path ?? null,
      tracePath: trace?.path ?? null,
      panes,
      activePaneId,
      filter,
      openGroups: Array.from(openGroups),
      cursors: { a: cursorA, b: cursorB, mode: cursorMode }
    })
  }, 400)
  return () => clearTimeout(handle)
}, [dbc, trace, panes, activePaneId, filter, openGroups, cursorA, cursorB, cursorMode])
```

- 400ms debounce is enough to coalesce rapid changes (typing in filter, dragging panes) into a single write.
- Don't persist on first render before restore completes — gate with a `restored` ref:

```ts
const restored = useRef(false)
// at end of restore effect:
restored.current = true
// at top of persist effect:
if (!restored.current) return
```

Otherwise the persist effect fires with empty initial state and blows away the saved layout before we read it.

### Missing-file handling

If `saved.dbcPath` exists but `loadDbc` rejects (file deleted, moved, or unreadable), leave the UI empty and let the user re-pick. Do **not** clear `saved.tracePath` from disk on that launch — the file might come back (network drive, USB unplugged). The next successful DBC+trace load will overwrite the layout naturally.

Surface the missing-file case in the UI: `setDbcError("Could not restore last DBC: <path>")`. That reuses the existing error-banner infra.

### Clear-layout action

Small escape hatch: add a "Reset layout" menu item or toolbar button that calls `writeLayout({ ...empty })` and reloads the window. Skip for this phase if it's awkward to place; users can delete `userData/layout.json` manually. Document the path in README.

### Edge cases

- Trace loaded but DBC missing: skip the trace too (decode depends on DBC). Same banner.
- Pane references signal keys that don't exist in the new load (user re-loaded a different trace out-of-band). The existing `payloads` fetch simply fails for those keys and the pane renders empty legends. Handle gracefully: in the draw effect, filter out traces whose payloads resolved to `null`. Already half-handled at [App.tsx:636](src/renderer/src/App.tsx#L636) (`.filter((t): t is NonNullable<typeof t> => t !== null)`) — verify the legend also tolerates missing payloads (it does, falls back to the raw key string).
- Schema change in the future: bump `version`. `readLayout` returns `null` on mismatch, user gets fresh layout. Don't bother with migrations until we have a real reason.

### Out of scope

- Multiple saved workspaces.
- Export/import layout to a user-chosen file.
- Persisting `xRange` (zoom).
- Persisting per-pane y-axis ranges (Plotly autoranges fine on reload).
- Syncing across machines.

---

## Part B — Docs sync

Two files, one commit, landed at the end of the phase so docs don't describe features not yet on `main`.

### [README.md](README.md)

Current state (verified): still describes the Phase-4 app. No mention of MF4, LTTB, cursors, enums. IPC block still says `trc:*`. Non-goals list still contains everything we shipped in 5a + 5b.

- **Line 3** — intro: change "PEAK TRC file" to "PEAK TRC or MDF 4.x bus-log file". Keep "plotting decoded J1939 signals" as-is.
- **Features (lines 5–11)** — rewrite:
  - "Load a `.dbc` (or `.dbc-json`) catalog and a PEAK `.trc` v2.1 or MDF 4.x (`.mf4`) bus-log trace"
  - Keep: custom decoder, stacked panes, signal picker, progress modal (all still accurate).
  - Add: "LTTB decimation on zoom — dense traces stay responsive"
  - Add: "A/B measurement cursors with per-trace readouts and Δ, shared across panes"
  - Add: "Value-table enum labels in hover tooltips and cursor readouts"
  - Add (new from 5c): "Layout persistence — last DBC, trace, pane config restored on launch"
- **Stack (lines 13–18)** — add one bullet: "MF4 parser in `src/main/mf4.ts` (classic CAN, CANedge + Rexgen files)". No other changes.
- **Layout (lines 39–49)**:
  - Add `mf4.ts` and `frame.ts` under `src/main/`.
  - Add `store.ts` under `src/main/` (new this phase).
  - Add `mf4.test.ts` under `src/main/`.
  - Add `src/renderer/src/lttb.ts`.
- **IPC channels (lines 51–56)** — replace entirely. Verify against [src/preload/index.ts](src/preload/index.ts); current real channels are:
  - `dbc:load`, `dbc:pick` — DBC catalog load
  - `trace:load`, `trace:pick` — TRC or MF4 parse + decode (branches on extension)
  - `trace:getSignal` — single signal payload
  - `trace:progress` — main → renderer: `{stage, current, total}`
  - `layout:read`, `layout:write` — persistence (new this phase)
- **Notes (lines 58–62)** — keep existing three bullets, add:
  - "Dense traces are downsampled in the renderer via LTTB with a 2000-point budget per trace, re-computed on zoom."
  - "Layout is persisted to `layout.json` in Electron's `userData` directory. Delete it to reset."
- **Non-goals (lines 64–66)** — rewrite. Keep: worker threads, CAN-FD, MF4 `##HL`/`##DL` chained data, `dz_zip_type=1` transposed deflate. Add: global `VAL_TABLE_` resolution (flagged in 5b as follow-up). Remove everything we shipped.

### [CLAUDE.md](CLAUDE.md)

- **Phase history** — add two entries:
  - `**Phase 5b** — chart UX: LTTB decimation, A/B measurement cursors, value-table enum labels`
  - `**Phase 5c** (current) — layout persistence (last DBC, trace, pane config), docs sync`
  - Move the old **Phase 4** "(current)" marker off.
- **Layout section** — add `store.ts` alongside other `src/main/` entries with a one-line description.
- **Conventions** — add:
  - "Decimation happens renderer-side at draw time against the current x-range; the main-process payload is always full-resolution. Don't decimate upstream."
  - "Layout JSON is a best-effort restore: missing files surface as errors, stale trace keys render as empty legends, schema-version mismatch falls back to a fresh layout. No migrations."
- **Outstanding TODOs** — leave the DBC long-form-names item untouched (user's regen still in progress).
- **Non-goals** — mirror the README rewrite.

---

## Suggested PR sequencing

1. **Commit 1** — `src/main/store.ts` + IPC handlers + preload bridge. No renderer changes yet; just the plumbing. Verify manually with devtools: `await window.api.writeLayout({...})` then `await window.api.readLayout()` round-trips.
2. **Commit 2** — restore effect in `App`. Verify: load DBC + trace + configure panes + cursors, relaunch app, state restored.
3. **Commit 3** — persist effect with debounce + `restored` ref. Verify: rapid filter typing produces one write, not many. Verify: empty state on first launch doesn't clobber any existing `layout.json` — easy to miss, easy to catch with the ref gate above.
4. **Commit 4** — missing-file error surfacing + README delete-to-reset documentation.
5. **Commit 5** — docs sync (Part B).

## Testing

- No new automated tests required. Storage is thin I/O; restore is UI state wiring.
- Manual test plan:
  - First launch with no `layout.json`: app opens to empty state as today.
  - Load DBC + trace + add panes + set cursors + relaunch: everything restored.
  - Load DBC + trace, rename the trace file on disk, relaunch: DBC restored, trace shows "could not restore" banner, UI usable.
  - Rapid filter typing → only one write settles (inspect `layout.json` mtime).
  - Delete `layout.json` manually → next launch is clean.
  - Regression: cursor mode + LTTB decimation + enum tooltips still work after restore.

## Open flags for the implementer

- Electron on Windows sometimes hands back `userData` paths with spaces (e.g. the user's OneDrive-backed profile). `fs/promises` handles these fine, but watch for any `path.join` that assumes no spaces. There aren't any in the planned code, but worth a glance.
- The `restored` ref trick is necessary but feels fragile. If it proves flaky, the alternative is gating the persist effect on `dbc !== null || trace !== null || panes.some((p) => p.traces.length > 0)` — only persist once the user has *done* something. Either works; the ref is simpler.
- If we later add worker threads (Phase 5d), the main-process decode state moves into the worker. `layout:read/write` is process-agnostic and doesn't care — no coupling risk.
