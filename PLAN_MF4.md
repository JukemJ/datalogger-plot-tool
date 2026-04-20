# Phase 5a — MF4 (bus-logging) support

Add support for loading MDF 4.x files produced by **Influx Rexgen 2** and **CSS Electronics CANedge** CAN loggers. CAN-FD is explicitly out of scope for this phase.

## Principle

These are **bus-event** MF4 files — each record is a raw CAN frame, not a pre-decoded signal. Therefore the existing [src/main/decode.ts](src/main/decode.ts) and DBC pipeline are reused **unchanged**. The only new work is parsing the MF4 container down to `{timestamp, id, extended, dlc, data}` frames, which are then handed to `decodeFrames()` exactly like TRC frames are today.

A sample file is already in the repo root: `running.mf4`. Use it as the primary fixture while developing.

## Deliverables

1. `src/main/mf4.ts` — parser that yields an array of frames in the same shape as `TrcFrame` (extended with an `extended: boolean` flag).
2. `src/main/mf4.test.ts` — tests for block parsing + DZ decompression against hand-crafted buffers, plus a smoke test that parses `running.mf4` and asserts non-zero frame count.
3. IPC handlers `mf4:load` / `mf4:pick` in [src/main/index.ts](src/main/index.ts) mirroring the TRC pair.
4. Preload bridge entries in [src/preload/index.ts](src/preload/index.ts): `loadMf4`, `pickMf4`.
5. Renderer changes in [src/renderer/src/App.tsx](src/renderer/src/App.tsx) — extend the trace drop zone to accept `.mf4` in addition to `.trc`, routing to the appropriate IPC channel based on extension. Progress modal reuses `trc:progress`-style events (rename the channel to `trace:progress` if cleaner, but non-breaking change is preferred — just emit on the same channel).

## Shared types

Promote `TrcFrame` to a more neutral name or add a sibling:

```ts
// src/main/frame.ts (new) — or keep in trc.ts and re-export
export type Frame = {
  timestamp: number   // seconds, relative to start-of-measurement
  id: number          // raw CAN ID (no extended-flag bit)
  extended: boolean   // true for 29-bit
  data: Uint8Array    // length === dlc
}
```

Update [src/main/decode.ts](src/main/decode.ts) to consume `Frame` instead of `TrcFrame`. The existing `is29Bit()` check currently inspects the `EXTENDED_ID_FLAG` bit on `frame.id`; rework it to consult `frame.extended` instead. Update `trc.ts` to set `extended` based on the TRC row (today TRC doesn't encode IDE explicitly — set `extended = id > 0x7ff`, matching the current heuristic). **This refactor lands in the same PR** since the decoder contract is changing.

## MF4 parser — scope

Support the subset required for bus-logging files:

- **Block tree:** HD → DG → CG → CN → (CC optional) → DT or DZ.
- **Channel groups:** parse only CGs whose acquisition source / channel names match `CAN_DataFrame`. Skip others silently.
- **Data blocks:** support `##DT` (uncompressed) and `##DZ` with `zip_type=0` (deflate, no transpose). Error clearly on anything else (`zip_type=1` transpose, HL/DL linked/list chains) — we'll add those if a real file requires it.
- **Record layout:** read field bit offsets + sizes from the CN blocks. Do **not** hardcode offsets — CANedge and Rexgen lay out `CAN_DataFrame` records differently.
- **Required CN fields** (by `cn_cn_name` or by standard `CAN_DataFrame.*` naming):
  - `Timestamp` — master channel; scale by the CG/CN conversion if present, else raw seconds.
  - `ID` — 29-bit value; IDE flag is a separate field.
  - `IDE` — 0 = 11-bit, 1 = 29-bit. Sets `Frame.extended`.
  - `DLC` — 0..8 for this phase.
  - `DataLength` — actual byte count (may equal DLC for classic CAN).
  - `DataBytes` — byte array channel (composite/byte-array type).

If a required field is missing, skip the whole CG with a warning in the return value (surface to the UI via the load result).

## Block parsing mechanics

MF4 layout reference (ASAM MDF 4.1, sufficient for this scope):

- **ID block** at offset 0, 64 bytes. Validate `file_id == "MDF     "` and `version >= 400`.
- **HD block** at offset 64. Read `hd_dg_first` (link to first DG).
- **Block header** (24 bytes): `id` (4 bytes, e.g. `##DG`), reserved (4), `length` (u64), `link_count` (u64). Followed by `link_count` u64 links, then block-specific data.
- **DG → CG → CN:** follow `dg_cg_first`, `cg_cn_first`, `cn_tx_name` (TX block for the name) / `cn_md_unit`, and sibling `_next` links.
- **DT/DZ data:** DG's `dg_data` link points to DT or DZ.
  - `##DT`: record stream starts immediately after the header.
  - `##DZ`: header fields include `dz_org_block_type` (expect `DT`), `dz_zip_type` (expect 0), `dz_org_data_length`, `dz_data_length`; payload is deflate-compressed. Use Node's `zlib.inflateRawSync` **or** `zlib.inflateSync` — test which matches MDF's encoding (MDF uses zlib-wrapped deflate, so `inflateSync`).
- **Record stream:** `cg_data_bytes` + `cg_inval_bytes` = bytes per record. If `cg_inval_bytes > 0`, skip the trailing invalidation bits in this phase (assume all samples valid; warn on load).

## Bit extraction for MF4 channels

Reuse [src/main/bits.ts](src/main/bits.ts) — the same `extractBits()` used for DBC signals works for MF4 CN fields. MF4 byte order: CN `cn_byte_order` is 0 (little-endian) for logger files; map to `'Intel'` when calling `extractBits`. `DataBytes` is a byte-array channel; read it as a raw slice of the record, **not** via `extractBits`.

## Chunking & progress

Match the TRC pattern:

- `stage: 'reading'` for file read + decompression (emit 0/1 and 1/1).
- `stage: 'parsing'` while iterating records; yield every 10k records.
- Hand off to `decodeFrames()` which already emits `indexing` and `decoding`.

## IPC

```ts
// main/index.ts
ipcMain.handle('mf4:load', async (evt, filePath): Promise<TrcLoadResult> => { ... })
ipcMain.handle('mf4:pick', async (evt) => { /* dialog with .mf4 filter */ })
```

Reuse the `TrcLoadResult` / `TrcSignalSummary` shape — consider renaming to `TraceLoadResult` / `TraceSignalSummary` in the same PR since both TRC and MF4 now feed it. `currentSeries` is a single module-scope map; loading a new MF4 replaces it exactly like TRC does.

## Renderer

- [src/renderer/src/App.tsx](src/renderer/src/App.tsx): the trace drop zone accepts `.trc` and `.mf4`. Branch on extension:

```ts
const ext = path.extname(filePath).toLowerCase()
const result = ext === '.mf4'
  ? await window.api.loadMf4(filePath)
  : await window.api.loadTrc(filePath)
```

- Drop-zone label: update from "Drop a .trc file" to "Drop a .trc or .mf4 file".
- Progress modal: no changes needed if we emit on the same channel.

## Testing

1. `mf4.test.ts` — unit tests for:
   - Block-header parsing (24-byte header with 2 links).
   - DZ inflate against a known short deflate stream.
   - Record-iteration with a synthetic 2-record buffer.
2. Smoke test: parse `running.mf4`, assert `frames.length > 0` and that at least one frame has `extended === true` (safe bet for a real trace). Keep runtime under a few seconds — the file is ~23 MB.
3. Regression: existing `decode.test.ts` must still pass after the `TrcFrame → Frame` refactor.

Run via `npm test` (existing command).

## Out of scope (explicit)

- CAN-FD (64-byte payloads, FD flags). Record structure differs; add in a follow-up.
- `##HL` / `##DL` linked/header list data chains. `running.mf4` almost certainly has a single DT/DZ.
- `dz_zip_type = 1` (deflate + transpose).
- VLSD (variable-length signal data) channels.
- Unsorted data groups (`dg_rec_id_size > 0`).
- CC (conversion) block evaluation beyond master-channel linear conversion on timestamps.
- Invalidation bits.

On encountering any of these, throw a descriptive error naming the unsupported feature so the user knows what to file.

## Suggested PR sequencing

1. Commit 1: introduce `Frame` type; refactor `trc.ts` + `decode.ts`; tests green.
2. Commit 2: `mf4.ts` parser + unit tests (synthetic buffers only).
3. Commit 3: IPC + preload + renderer wiring; smoke test against `running.mf4`.
4. Commit 4: CLAUDE.md update — add MF4 layout notes, move "MF4 support" from non-goals to phase history as **Phase 5a**.

## Open flags for the implementer

- If `running.mf4` uses `##HL` (header list — one or more DT blocks chained), the plan above will throw. In that case: extend to walk the HL → DL → DT chain before shipping. Check the DG's `dg_data` link's 4-byte block id first and branch.
- If either logger writes timestamps as integer raw values with a CC linear conversion, apply the conversion when reading the master channel. If raw float64 seconds, no conversion needed. Inspect `running.mf4`'s master CN `cn_cc_conversion` link.
