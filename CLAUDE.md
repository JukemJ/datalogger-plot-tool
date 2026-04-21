# CAN Trace Viewer — project notes

Electron + React + TypeScript app for loading a DBC + TRC/MF4 and plotting decoded signals.

## Stack
- electron-vite scaffolding (main / preload / renderer split)
- `candied` for DBC parsing only — its decoder is NOT used
- `plotly.js-dist-min` for charting (SVG `scatter` — WebGL is unavailable in this environment, do not switch back to `scattergl`)
- Custom J1939-aware decoder in `src/main/bits.ts` + `src/main/decode.ts`

## Layout
- `src/main/` — Node side
  - `index.ts` — Electron bootstrap, IPC handlers, progress emitter
  - `dbc.ts` — loads .dbc (via candied) or .dbc-json; builds `idToMessage` and `pgnToMessage` lookup tables; `pgnOf` / `saOf` helpers; `isJ1939Message` via `VFrameFormat=J1939PG` attribute with fallback to 29-bit + non-zero PGN
  - `trc.ts` — TRC v2.1 parser. Reads `$COLUMNS` header (required) to locate fields. Chunked parsing (10k lines) with `setImmediate` yields + `onProgress` callback
  - `mf4.ts` — MDF 4.x bus-event parser (classic CAN, CANedge + Rexgen). Emits `Frame[]` into the same decode pipeline
  - `frame.ts` — shared `Frame` type + `ProgressCb` so parsers and decoder don't depend on each other
  - `decode.ts` — resolves frames via exact-ID then PGN map, extracts SA from 29-bit IDs, stores series keyed `${signalName}@${sa}`. Chunked (50k frames) with progress callback. `SignalSeries` carries optional `enum: Record<number,string>`
  - `bits.ts` — pure `extractBits(data, startBit, length, endian, signed)` using BigInt. Split out for testing
  - `store.ts` — atomic read/write of `layout.json` in Electron's `userData` directory; returns `null` on missing/corrupt/version-mismatch
  - `decode.test.ts` — 6 hand-computed Intel/Motorola/signed/factor+offset cases. Run via `npm test` (uses Node's `--experimental-strip-types`)
  - `mf4.test.ts` — block header, zlib inflate, record iterator, end-to-end smoke on `running.mf4`
- `src/preload/index.ts` — `window.api` bridge: `loadDbc`, `loadTrace`, `pickDbc`, `pickTrace`, `getSignal`, `readLayout`, `writeLayout`, `getPathForFile`, `onTraceProgress`
- `src/renderer/src/lttb.ts` — pure LTTB decimation + `sampleAt` interpolator (used by cursor readouts)
- `src/renderer/src/App.tsx` — single-file React app
  - Empty state: large drop zones centered
  - Loaded state: slim top navbar + 360px picker sidebar + pane stack
  - Pane model: `{ id, title, traces: { key, axis: 'left'|'right' }[] }`
  - X-axis sync across panes via `plotly_relayout` → App-level `xRange` state → effect in each pane applies relayout (skipping source pane)
  - Dual Y axes: `yaxis` (left) / `yaxis2` (right, overlaying y). Custom legend UI with L/R toggle buttons; unit shown as axis title (or "mixed")
  - Pane-membership "dots" in picker show which panes contain each signal
  - Progress modal driven by `onTrcProgress`

## IPC channels
- `dbc:load`, `dbc:pick` — returns summary/catalog; catalog load does not decode
- `trace:load`, `trace:pick` — parses + decodes (branches on `.trc` vs `.mf4`); returns signal summaries with `{key, signalName, messageName, sa, unit, enum, count}`
- `trace:getSignal` — returns a single `SignalPayload` (timestamps + values + enum)
- `trace:progress` — main → renderer event: `{stage: 'reading'|'parsing'|'decoding'|'indexing', current, total}`
- `layout:read`, `layout:write` — workspace JSON persistence

## Conventions used in this codebase
- No unnecessary comments, no speculative abstractions
- Decoder is the one place with tests; no broader test framework
- The spec said `scattergl` but WebGL is unavailable on this machine — we use `scatter`. Don't revert
- TRC parser requires `$COLUMNS` header (v2.1 format). Column layout is not hardcoded
- Payload cache lives at module scope in `App.tsx` (`payloadCache: Map<key, SignalPayload>`) so switching panes doesn't re-fetch
- Never mock the decoder in tests — `bits.ts` stays pure and is tested directly
- Decimation happens renderer-side at draw time against the current x-range; the main-process payload is always full-resolution. Don't decimate upstream.
- Layout JSON is a best-effort restore: missing files surface as errors, stale trace keys render as empty legends, schema-version mismatch falls back to a fresh layout. No migrations — bump `version` and let it reset.

## Phase history
- **Phase 1** — drop-zone shell, DBC parsing only
- **Phase 2** — TRC v2.1 parsing, candied-based decode, single-signal Plotly chart
- **Phase 3** — replaced candied decode with custom J1939-aware decoder; per-SA signal series; multi-trace picker; message grouping
- **Phase 4** — stacked panes with synced x-axis, dual Y, collapsible nav + progress modal, chunked parse/decode
- **Phase 5a** — MF4 (MDF 4.x) bus-log support via `src/main/mf4.ts`; unified behind `trace:*` IPC
- **Phase 5b** — renderer-side LTTB decimation (2000-point budget, x-range aware), shared A/B measurement cursors with interpolated readout, value-table enum display in hover tooltip + cursor readout (`enum` field piped through `SignalSeries` / `SignalPayload`)
- **Phase 5c** (current) — layout persistence (DBC + trace paths, panes, filter, open groups, cursors) via `src/main/store.ts` and `layout:*` IPC; docs sync

## Display names
- Long-symbol resolution lives in `src/main/dbc.ts` (`longMessageName` / `longSignalName`). `BA_ "SystemMessageLongSymbol"` and `BA_ "SystemSignalLongSymbol"` override the truncated `BO_` / `SG_` symbols when present. Short symbol stays as the fallback. Lookups (`idToMessage`, `pgnToMessage`, candied's internal signal map) always key off the raw short symbol — display names are cosmetic only, applied once at catalog + decode time.

## Non-goals (deliberately deferred)
- Worker threads
- CAN-FD
- MF4 `##HL` / `##DL` chained data blocks, `dz_zip_type=1` transposed deflate
- Snap-to-sample / draggable cursors, keyboard nudging
- Enum-aware y-axis tick labels (mixed enum + continuous panes make this awkward)
- Multiple saved workspaces / export-import layout / cross-machine sync
