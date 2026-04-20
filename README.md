# CAN Trace Viewer

Electron + React + TypeScript app for loading a DBC + PEAK TRC file and plotting decoded J1939 signals.

## Features

- Load a `.dbc` (or `.dbc-json`) catalog and a PEAK `.trc` v2.1 trace
- Custom J1939-aware decoder with per-source-address (SA) signal series
- Stacked chart panes with synced x-axis and dual Y axes (left/right)
- Signal picker sidebar grouped by message, with pane-membership indicators
- Progress modal for chunked parse/decode of large traces

## Stack

- [electron-vite](https://electron-vite.org) — main / preload / renderer split
- [`candied`](https://www.npmjs.com/package/candied) — DBC parsing only (its decoder is not used)
- [`plotly.js-dist-min`](https://plotly.com/javascript/) — SVG `scatter` charts
- Custom decoder in `src/main/bits.ts` + `src/main/decode.ts`

## Prerequisites

- Node.js 20+
- npm

## Scripts

```bash
npm install
npm run dev           # launch in development
npm test              # run decoder unit tests
npm run typecheck
npm run build         # typecheck + production build
npm run build:unpack  # unpacked build under dist/
npm run build:win     # Windows installer
npm run build:mac
npm run build:linux
```

## Layout

- `src/main/` — Node side
  - `index.ts` — Electron bootstrap, IPC handlers, progress emitter
  - `dbc.ts` — DBC loader; builds `idToMessage` / `pgnToMessage` lookups; J1939 helpers
  - `trc.ts` — TRC v2.1 parser (requires `$COLUMNS` header; chunked with progress)
  - `decode.ts` — frame resolution by exact ID then PGN; series keyed `${signalName}@${sa}`
  - `bits.ts` — pure `extractBits` (BigInt); tested directly
  - `decode.test.ts` — Intel/Motorola/signed/factor+offset cases
- `src/preload/index.ts` — `window.api` bridge
- `src/renderer/src/App.tsx` — single-file React UI (picker + pane stack)

## IPC channels

- `dbc:load`, `dbc:pick` — catalog load (no decode)
- `trc:load`, `trc:pick` — parse + decode; returns signal summaries
- `trc:getSignal` — single signal payload (timestamps + values)
- `trc:progress` — main → renderer: `{stage, current, total}`

## Notes

- WebGL is unavailable in the target environment — charts use SVG `scatter`, not `scattergl`.
- TRC parser reads the `$COLUMNS` header rather than hardcoding the column layout.
- Renderer-side payload cache avoids re-fetching when switching panes.

## Non-goals (deferred)

Worker threads, decimation / LTTB, MF4 support, value-table enums, measurement cursors, layout persistence.
