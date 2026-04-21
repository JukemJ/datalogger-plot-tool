# CAN Trace Viewer

Electron + React + TypeScript app for loading a DBC + PEAK TRC or MDF 4.x bus-log file and plotting decoded J1939 signals.

## Features

- Load a `.dbc` (or `.dbc-json`) catalog and a PEAK `.trc` v2.1 or MDF 4.x (`.mf4`) bus-log trace
- Custom J1939-aware decoder with per-source-address (SA) signal series
- Stacked chart panes with synced x-axis and dual Y axes (left/right)
- Signal picker sidebar grouped by message, with pane-membership indicators
- Progress modal for chunked parse/decode of large traces
- LTTB decimation on zoom — dense traces stay responsive
- A/B measurement cursors with per-trace readouts and Δ, shared across panes
- Value-table enum labels in hover tooltips and cursor readouts
- Layout persistence — last DBC, trace, pane config, filter, open groups, and cursors restored on launch
- Trace parse + decode run in a Node worker — the UI stays responsive during large loads
- Draggable cursors with snap-to-sample and arrow-key nudging (Shift = 10×)
- Min/max/mean statistics between A and B in the cursor readout
- CSV export (wide format, current x-range) and PNG export (1920×1080) per pane

## Stack

- [electron-vite](https://electron-vite.org) — main / preload / renderer split
- [`candied`](https://www.npmjs.com/package/candied) — DBC parsing only (its decoder is not used)
- [`plotly.js-dist-min`](https://plotly.com/javascript/) — SVG `scatter` charts
- Custom decoder in `src/main/bits.ts` + `src/main/decode.ts`
- MF4 parser in `src/main/mf4.ts` (classic CAN, CANedge + Rexgen files)

## Prerequisites

- Node.js 20+
- npm

## Scripts

```bash
npm install
npm run dev           # launch in development
npm test              # run decoder + MF4 unit tests
npm run typecheck
npm run build         # typecheck + production build
npm run build:unpack  # unpacked build under dist/
npm run build:win     # Windows installer
npm run build:mac
npm run build:linux
```

## Layout

- `src/main/` — Node side
  - `index.ts` — Electron bootstrap, IPC handlers, progress emitter, CSV/PNG export
  - `decode.worker.ts` — `worker_threads` entry that runs parse + decode off the main thread
  - `workerHost.ts` — main-side wrapper that spawns one worker per trace load
  - `dbc.ts` — DBC loader; builds `idToMessage` / `pgnToMessage` lookups; J1939 helpers
  - `trc.ts` — TRC v2.1 parser (requires `$COLUMNS` header; chunked with progress)
  - `mf4.ts` — MDF 4.x bus-event parser (classic CAN, CANedge + Rexgen)
  - `frame.ts` — shared `Frame` type + `ProgressCb`
  - `decode.ts` — frame resolution by exact ID then PGN; series keyed `${signalName}@${sa}`
  - `bits.ts` — pure `extractBits` (BigInt); tested directly
  - `store.ts` — reads/writes `layout.json` in Electron's `userData` directory
  - `decode.test.ts` — Intel/Motorola/signed/factor+offset cases
  - `mf4.test.ts` — block parser, inflate, record iterator, end-to-end smoke
- `src/preload/index.ts` — `window.api` bridge
- `src/renderer/src/App.tsx` — single-file React UI (picker + pane stack)
- `src/renderer/src/lttb.ts` — LTTB decimation + interpolated `sampleAt`

## IPC channels

- `dbc:load`, `dbc:pick` — DBC catalog load
- `trace:load`, `trace:pick` — TRC or MF4 parse + decode (branches on extension)
- `trace:getSignal` — single signal payload (timestamps + values)
- `trace:progress` — main → renderer: `{stage, current, total}`
- `layout:read`, `layout:write` — workspace persistence
- `trace:exportCsv` — wide-format CSV for the active pane, capped at 1M rows
- `trace:exportPng` — writes a PNG byte buffer from `Plotly.toImage` to a user-chosen path

## Notes

- WebGL is unavailable in the target environment — charts use SVG `scatter`, not `scattergl`.
- TRC parser reads the `$COLUMNS` header rather than hardcoding the column layout.
- Renderer-side payload cache avoids re-fetching when switching panes.
- Dense traces are downsampled in the renderer via LTTB with a 2000-point budget per trace, re-computed on zoom.
- Layout is persisted to `layout.json` in Electron's `userData` directory. Delete it to reset.
- Trace parse + decode run in a Node worker; progress events flow through `trace:progress` unchanged. The worker re-parses the DBC from its path rather than receiving serialized candied objects.
- CSV export uses wide format — one row per unique timestamp across the pane's signals, columns per signal. Enum signals write labels when available; unresolved labels fall back to the raw value.

## Non-goals (deferred)

MF4 `##HL`/`##DL` chained data blocks, MF4 `dz_zip_type=1` (transposed deflate), cancellation of in-flight loads, multi-pane export, `.xlsx` / JSON export, time-weighted statistics.
