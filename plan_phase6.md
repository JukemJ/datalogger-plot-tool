# Phase 6 — Workers, cursor polish, export, stats

Four tracks. The worker refactor is architectural and lands first. Cursor polish + stats are small renderer-only changes. Export touches both processes. Docs sync at the end.

## Principle

- The worker refactor must be **transparent to the renderer**. IPC channel names, payload shapes, and progress events stay identical. The renderer should not know whether decode runs on the main process or a worker.
- Cursor polish and stats are additive — no breaking changes to cursor state or persistence (`layout.json` schema stays at `version: 1`).
- Export is a new surface but reuses existing data: the main-process `currentSeries` for CSV, Plotly's built-in image APIs for PNG.

---

## Part A — Worker threads (move parse + decode off main)

### Goal

Run TRC/MF4 parse and decode in a Node `worker_threads` worker so the main process stays responsive to IPC from the renderer during long loads. Progress events still flow through the existing `trace:progress` channel.

### Where it lives

- New file: [src/main/decode.worker.ts](src/main/decode.worker.ts) — the worker entrypoint. Uses `parentPort` from `worker_threads`.
- New file: [src/main/workerHost.ts](src/main/workerHost.ts) — main-process wrapper that spawns the worker, forwards progress, returns a Promise that resolves on `done` or rejects on `error`.
- [src/main/index.ts](src/main/index.ts) — `trace:load` handler delegates to `workerHost.ts` instead of calling `parseTrc` / `parseMf4` / `decodeFrames` directly.

### Worker contract

```ts
// main → worker
type WorkerRequest = { filePath: string; dbc: SerializedDbc }

// worker → main
type WorkerEvent =
  | { kind: 'progress'; stage: 'reading'|'parsing'|'decoding'|'indexing'; current: number; total: number }
  | { kind: 'done'; series: SerializedSeries; skipped: number; warnings: string[] }
  | { kind: 'error'; message: string }
```

Transfer the decoded `Float64Array`s back via `postMessage(payload, [transferList])` — avoids a second full-copy of the series data across the worker boundary.

### DBC serialization problem

The existing `LoadedDbc` holds live `Map<number, Message>` objects with candied's class instances inside. Those don't survive structured-clone cleanly (methods lost, prototypes stripped). Two options:

- **Option 1 (simpler): re-parse the DBC inside the worker.** Pass `dbcPath`, let the worker call `loadDbc(path)` itself. Doubles DBC parse time per trace load, but DBC parse is ~100ms on the user's files — negligible vs trace decode.
- **Option 2: serialize to a plain-data shape** (`SerializedDbc` = `{ messages: Array<{id, name, signals: Array<{...}>}> }`) and have the worker reconstruct lookup maps. More code, more drift risk.

**Go with Option 1.** The DBC path is already cached on main for the UI; the worker gets the same path and re-parses. Add a one-line note in CLAUDE.md.

### Renderer changes

None. `trace:load` still returns the same `TraceLoadResult`; `trace:progress` still fires on the same channel; `trace:getSignal` still reads from a main-process cache (see below).

### `currentSeries` cache

Today [src/main/index.ts](src/main/index.ts) keeps `currentSeries: Map<string, SignalSeries> | null` at module scope and `trace:getSignal` reads from it. After the worker refactor, the worker produces the series and ships it back to main via `postMessage`. Main caches it in the same module-level `currentSeries` and `trace:getSignal` reads from it unchanged. The worker exits after `done` — don't keep it alive between loads.

### Cancellation

Out of scope for this phase. If the user drops a second trace while the first is still loading, the current behavior is "both run, last write wins". Keep that. Cancellation adds UI (an "X" on the progress modal) and worker teardown complexity — not now.

### Error handling

Any throw inside the worker produces a `{ kind: 'error', message }` event; the host rejects the load promise; the `trace:load` IPC returns `{ ok: false, error }` as it does today.

`worker.on('exit', code)` with a non-zero code when no `done`/`error` was sent: treat as `{ ok: false, error: 'Worker exited unexpectedly' }`.

### Build

electron-vite builds workers if you import them via `?worker` or if you explicitly declare an entry in [electron.vite.config.ts](electron.vite.config.ts) under `main.build.lib.entry`. Easier: add the worker as a second entry:

```ts
main: {
  build: {
    rollupOptions: {
      input: {
        index: 'src/main/index.ts',
        'decode.worker': 'src/main/decode.worker.ts'
      }
    }
  }
}
```

Then resolve the worker path at runtime as `join(__dirname, 'decode.worker.js')`. Verify the output filename against `out/main/` after first build.

### Testing

- Existing `decode.test.ts` and `mf4.test.ts` still pass — they import the pure functions directly, not via worker. No changes needed.
- Manual: load a large MF4 (>20 MB). During load, switch panes, type in the filter, drag cursors. Confirm the UI never stalls. Compare total load time before/after — worker overhead should be <100ms.

### Out of scope

- Cancellation.
- Multiple concurrent workers.
- Keeping the worker alive across loads (pool of one).
- Worker-side progress throttling beyond what's already in `decodeFrames`.

---

## Part B — Cursor polish

### Drag to move

Clicking an existing cursor should start a drag; moving the mouse updates that cursor's position; releasing ends the drag. Uses Plotly's `plotly_click` + `plotly_hover` + `mouseup` on the plot div.

Simpler approach that avoids wrestling with Plotly internals: **use Plotly shape dragging**. Set `editable: true` on the cursor shapes and listen for `plotly_relayout` — the relayout event fires with keys like `'shapes[0].x0'` / `'shapes[0].x1'`. Parse those, map back to `cursorA` / `cursorB`, call `setCursorA` / `setCursorB`.

```ts
// in the existing relayout handler at PaneView
for (const k of Object.keys(ev)) {
  const m = k.match(/^shapes\[(\d+)\]\.x0$/)
  if (!m) continue
  const shapeIdx = Number(m[1])
  const which = shapeIdx === cursorAShapeIdx ? 'A' : shapeIdx === cursorBShapeIdx ? 'B' : null
  if (which === 'A') setCursorA(ev[k] as number)
  else if (which === 'B') setCursorB(ev[k] as number)
}
```

Track `cursorAShapeIdx` / `cursorBShapeIdx` based on insertion order in the shapes array (they're deterministic — A before B when both exist).

`editable: true` applies to all shapes globally in Plotly's config. That's fine — we only have cursor shapes, no decorative ones.

### Snap to nearest sample

When a cursor lands (via click or drag end), snap the x to the nearest timestamp from the set of currently-loaded payloads across all panes. Keeps readouts aligned to real samples instead of interpolated noise.

```ts
function snapTimestamp(t: number, payloads: SignalPayload[]): number {
  let best = t
  let bestDist = Infinity
  for (const p of payloads) {
    const xs = p.timestamps
    if (xs.length === 0) continue
    // binary search for nearest
    let lo = 0, hi = xs.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (xs[mid] < t) lo = mid + 1
      else hi = mid
    }
    for (const i of [lo - 1, lo]) {
      if (i < 0 || i >= xs.length) continue
      const d = Math.abs(xs[i] - t)
      if (d < bestDist) { bestDist = d; best = xs[i] }
    }
  }
  return best
}
```

Call `snapTimestamp` inside `onCursorClick` and inside the drag-end branch of the relayout handler. Payload collection: flatten `panes.flatMap(p => p.traces).map(t => payloadCache.get(t.key))`. Tolerate missing payloads (skip `null`).

Add a toggle to disable snap for users who want free positioning — checkbox next to the cursor toggle in the toolbar, default **on**. State lives in `App`: `const [cursorSnap, setCursorSnap] = useState(true)`. Persist in `layout.json` under `cursors.snap`. This is a schema addition, not a breaking change — make the field optional in the type and default to `true` on load:

```ts
cursors: { a: saved.cursors.a, b: saved.cursors.b, mode: saved.cursors.mode, snap: saved.cursors.snap ?? true }
```

Keep `version: 1` — additive optional fields don't warrant a bump.

### Keyboard nudge

When cursor mode is on and at least one cursor is set, arrow keys nudge the *most-recently-placed* cursor by one sample (with snap) or by a small fixed fraction of the visible range (without snap).

- `←` / `→` — one sample left/right (snap on) or 0.5% of visible range (snap off).
- `Shift+←` / `Shift+→` — 10× that.
- Active cursor = the last one the user placed or dragged; track in a ref alongside `nextCursor`.

Attach a window-level `keydown` listener inside `App` with the existing cursor-mode dependency; avoid stealing keys when an input is focused:

```ts
if (document.activeElement instanceof HTMLInputElement) return
```

### Out of scope

- Click-outside to deselect active cursor for nudge.
- Touch/pen cursor manipulation.
- Per-pane cursors (cursors remain global — x-axis is shared).

---

## Part C — Export

### CSV

New main-process handler `trace:exportCsv`:

```ts
ipcMain.handle('trace:exportCsv', async (evt, args: {
  keys: string[]
  xStart: number | null
  xEnd: number | null
}): Promise<{ ok: true; path: string } | { ok: false; error: string }>
```

Flow:

1. Show `dialog.showSaveDialog` with `.csv` filter.
2. Build a unified timestamp axis = sorted union of timestamps across the requested keys, filtered to `[xStart, xEnd]` if given. For sparse series this can be large; cap at 1M rows with a warning (CSV past that point is rarely useful).
3. For each row, write timestamp + per-signal value, interpolating via `sampleAt`-equivalent (numeric) or "last known" for enum signals. Reuse the logic used in cursor readouts — extract to a shared helper if not already.
4. Write CSV with `,` separators, `\n` line endings, header row: `timestamp,<name1>,<name2>,...`. Quote names containing commas or quotes.

Unified-timestamp union is the "right" export shape for multi-signal CSV. Alternative "long" format (one row per sample, with a `signal` column) is also valid and smaller for sparse data; pick **wide format** because it's what Excel users expect. Document the choice in README.

Renderer: add an "Export CSV" button near the cursor toolbar. Exports the signals currently plotted in the active pane, over the current `xRange` (or full range if no zoom). Multi-pane export is out of scope — users can trigger per pane.

### PNG

Plotly ships `Plotly.toImage(gd, {format: 'png', width, height})` → returns a data URL. From the renderer:

1. Button next to Export CSV: "Export PNG".
2. Call `Plotly.toImage(divRef.current, { format: 'png', width: 1920, height: 1080, scale: 2 })`.
3. Convert data URL to `Uint8Array`, send over new IPC `trace:exportPng(bytes, suggestedName)`.
4. Main shows save dialog and writes bytes.

Single pane per click. Multi-pane "export all" is out of scope.

### Errors

Save-dialog cancel → return `{ ok: true, path: '' }` and the renderer treats empty path as silent cancel. Write failure → `{ ok: false, error }` shown in a transient toast (reuse the existing error-banner infra or add a `setStatus` message near the toolbar).

### Out of scope

- Excel (`.xlsx`).
- JSON export.
- Copy-to-clipboard as image.
- Exporting raw CAN frames (vs. decoded signals).

---

## Part D — Stats in cursor readouts

When both A and B are set, augment each trace's readout row with min/max/mean over `[A, B]`:

```
<name>:  A=<va>  B=<vb>  Δ=<vb-va>  min=<mn>  max=<mx>  mean=<mu>
```

### Computation

Helper in [src/renderer/src/lookup.ts](src/renderer/src/lookup.ts) (new if not already extracted) or alongside `sampleAt` in [src/renderer/src/lttb.ts](src/renderer/src/lttb.ts):

```ts
export function statsInRange(
  xs: Float64Array, ys: Float64Array, a: number, b: number
): { min: number; max: number; mean: number; count: number } | null {
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  // binary-search the half-open [lo, hi] index range
  const i0 = firstIndexAtOrAfter(xs, lo)
  const i1 = firstIndexAtOrAfter(xs, hi)
  if (i1 <= i0) return null
  let mn = Infinity, mx = -Infinity, sum = 0
  for (let i = i0; i < i1; i++) {
    const v = ys[i]
    if (v < mn) mn = v
    if (v > mx) mx = v
    sum += v
  }
  return { min: mn, max: mx, mean: sum / (i1 - i0), count: i1 - i0 }
}
```

Mean is unweighted — CAN samples are not evenly-spaced but mean-of-samples is what users expect from a quick readout. Time-weighted mean (area under the curve / duration) is more "correct" but surprising; defer.

### Rendering

Extend the cursor-readout table rendering at [src/renderer/src/App.tsx:861](src/renderer/src/App.tsx#L861). For enum signals, replace min/max/mean with `—` (no meaningful aggregation for labels) unless all values in range are identical, in which case show that label.

### Out of scope

- Time-weighted statistics.
- Std dev / variance.
- Histogram in the readout.
- Stats over full trace when cursors aren't set.

---

## Suggested PR sequencing

1. **Commit 1** — worker scaffolding: worker file, host wrapper, vite config entry, wire `trace:load` through the host. Verify the existing decode still works; no functional change.
2. **Commit 2** — worker-side DBC re-parse + progress forwarding. Smoke-test against `pete_j1939.dbc` + `running.mf4`.
3. **Commit 3** — cursor drag (via `editable: true` on shapes).
4. **Commit 4** — snap-to-sample (with persisted toggle in `layout.json`).
5. **Commit 5** — keyboard nudge.
6. **Commit 6** — stats in readout table.
7. **Commit 7** — CSV export (main handler + renderer button).
8. **Commit 8** — PNG export.
9. **Commit 9** — docs sync (Part E below).

## Part E — Docs updates

### [README.md](README.md)

- **Features** — add four bullets: worker-backed parse/decode (UI stays responsive), draggable cursors with snap-to-sample + keyboard nudge, min/max/mean stats between cursors, CSV/PNG export.
- **Layout** — add `src/main/decode.worker.ts` and `src/main/workerHost.ts` under `src/main/`. Add `src/renderer/src/lookup.ts` if the stats helper lands there.
- **IPC channels** — add `trace:exportCsv` and `trace:exportPng`.
- **Notes** — add: "Trace parse + decode run in a Node worker; the main process and UI stay responsive during load. Progress events flow through `trace:progress` unchanged."
- **Non-goals** — remove `worker threads`. Remove the CAN-FD entry (user confirmed not needed). Remaining deferred: MF4 `##HL`/`##DL` chains, `dz_zip_type=1` transposed deflate, cancellation of in-flight loads, multi-pane export, time-weighted stats, `.xlsx` / JSON export.

### [CLAUDE.md](CLAUDE.md)

- **Phase history** — add `**Phase 6** (current) — workers, cursor polish, export, readout stats`. Demote Phase 5c's "current" marker.
- **Layout** — add `decode.worker.ts` / `workerHost.ts` with one-line descriptions.
- **Conventions** — add:
  - "Trace parse + decode run in a `worker_threads` worker. The worker re-parses the DBC from `dbcPath` on each load rather than receiving serialized candied objects (simpler, avoids structured-clone issues with class instances). Decode output `Float64Array`s are transferred back, not copied."
  - "Cursors dragged via Plotly `editable: true` shapes; position changes surface through `plotly_relayout`. Snap-to-sample is on by default; toggle in toolbar persisted to `layout.json`."
- **Non-goals** — mirror the README rewrite. Remove CAN-FD explicitly.
- **Outstanding TODOs** — the DBC long-name item is done (landed in `plan_dbc_longnames`); remove it if still listed.

Land the docs commit only after the feature commits are merged — same discipline as prior phases.

## Testing

- Existing unit tests (`decode.test.ts`, `mf4.test.ts`, any lttb tests) continue to pass unchanged. Worker refactor does not touch pure functions.
- Manual:
  - Big MF4 load with UI interaction (typing, pane drag, cursor placement) mid-load — no stalls.
  - Cursor drag on pane 1 moves the cursor on pane 2 in sync (they're global).
  - Snap on: placed cursor always lands on a real sample. Snap off: lands exactly where clicked.
  - Keyboard nudge respects snap mode; doesn't fire while an input is focused.
  - CSV export: open in Excel, confirm column count + first/last timestamp match the zoom range. Enum signals show labels, not numbers.
  - PNG export: resulting file opens in a viewer; cursors and legend render correctly.
  - Regression: layout restore from Phase 5c still works; enum hover/readout still works; LTTB decimation still active.

## Open flags for the implementer

- `editable: true` in Plotly's layout may let users drag **any** shape — if we later add decorative shapes (grid overlays, annotation boxes), revisit. Today we only have cursor shapes; safe.
- Worker `parentPort!.postMessage(series, transferList)` — the `transferList` must include every `ArrayBuffer` backing every `Float64Array` in the series map. Iterate carefully; missing one will silently copy (slow) rather than error.
- Node's built-in `zlib.inflateSync` used by MF4 parsing runs **synchronously on the calling thread**. That thread is now the worker — good, no main-process block. No changes to [src/main/mf4.ts](src/main/mf4.ts) needed.
- If the worker's DBC re-parse ever becomes measurable (DBC files >10 MB, unlikely for J1939), switch to Option 2 (serialized plain-data DBC). Not today.
