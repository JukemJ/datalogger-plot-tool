# CAN Trace Viewer — project notes

Electron + React + TypeScript app for loading a DBC + TRC and plotting decoded signals.

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
  - `decode.ts` — resolves frames via exact-ID then PGN map, extracts SA from 29-bit IDs, stores series keyed `${signalName}@${sa}`. Chunked (50k frames) with progress callback
  - `bits.ts` — pure `extractBits(data, startBit, length, endian, signed)` using BigInt. Split out for testing
  - `decode.test.ts` — 6 hand-computed Intel/Motorola/signed/factor+offset cases. Run via `npm test` (uses Node's `--experimental-strip-types`)
- `src/preload/index.ts` — `window.api` bridge: `loadDbc`, `loadTrc`, `pickDbc`, `pickTrc`, `getSignal`, `getPathForFile`, `onTrcProgress`
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
- `trc:load`, `trc:pick` — parses + decodes; returns signal summaries with `{key, signalName, messageName, sa, unit, count}`
- `trc:getSignal` — returns a single `SignalPayload` (timestamps + values)
- `trc:progress` — main → renderer event: `{stage: 'reading'|'parsing'|'decoding'|'indexing', current, total}`

## Conventions used in this codebase
- No unnecessary comments, no speculative abstractions
- Decoder is the one place with tests; no broader test framework
- The spec said `scattergl` but WebGL is unavailable on this machine — we use `scatter`. Don't revert
- TRC parser requires `$COLUMNS` header (v2.1 format). Column layout is not hardcoded
- Payload cache lives at module scope in `App.tsx` (`payloadCache: Map<key, SignalPayload>`) so switching panes doesn't re-fetch
- Never mock the decoder in tests — `bits.ts` stays pure and is tested directly

## Phase history
- **Phase 1** — drop-zone shell, DBC parsing only
- **Phase 2** — TRC v2.1 parsing, candied-based decode, single-signal Plotly chart
- **Phase 3** — replaced candied decode with custom J1939-aware decoder; per-SA signal series; multi-trace picker; message grouping
- **Phase 4** (current) — stacked panes with synced x-axis, dual Y, collapsible nav + progress modal, chunked parse/decode

## Non-goals (deliberately deferred)
- Worker threads (Phase 5)
- Decimation / LTTB
- MF4 support
- Value-table enum display
- Measurement cursors
- Saving/restoring layout
