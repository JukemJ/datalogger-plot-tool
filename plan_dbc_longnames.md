# Phase 5c-prep — DBC long-symbol display names

Resolves the Phase-4 TODO flagged in [CLAUDE.md](CLAUDE.md). Small, isolated, lands before Phase 5c so restored layouts reference the correct display names.

## Context

The new [pete_j1939.dbc](pete_j1939.dbc) uses DBC attributes to carry full names past the 32-char `BO_` / `SG_` symbol limit:

- `BA_ "SystemMessageLongSymbol" BO_ <id> "<full-message-name>"` — 155 entries out of 413 messages.
- `BA_ "SystemSignalLongSymbol" SG_ <id> <sig> "<full-signal-name>"` — 11 entries.

Most symbols already fit in 32 chars and have **no** override. The resolver must fall back to `msg.name` / `sig.name` when no attribute is present — don't overwrite every name.

No global `VAL_TABLE_` entries in this file (all 155 value tables are inline `VAL_`). Global-table resolution flagged in Phase 5b's open flags is **not** needed; remove that follow-up flag.

## Principle

- **Short symbols remain the lookup keys.** `idToMessage`, `pgnToMessage`, and candied's internal signal lookup all continue to key off the raw `BO_` / `SG_` symbol. Never change lookup logic.
- **Long symbols are a display-only concern.** Resolve them once at DBC-load time and carry the resolved name through `MessageInfo`, `SignalInfo`, and the decoder's `meta` map into `SignalSeries`. Renderer uses the resolved name verbatim.
- **Fallback is the short symbol.** Missing attribute, empty string, whitespace-only, or a value that equals the short symbol → use the short symbol. Treat these as "no override present".

## Changes

### [src/main/dbc.ts](src/main/dbc.ts)

Add two helpers near the existing `pgnOf` / `saOf` / `isJ1939Message`:

```ts
function longMessageName(msg: Message): string {
  const v = msg.attributes.get('SystemMessageLongSymbol')?.value
  if (typeof v !== 'string') return msg.name
  const cleaned = v.replace(/"/g, '').trim()
  return cleaned.length > 0 ? cleaned : msg.name
}

function longSignalName(sig: Signal): string {
  const v = sig.attributes.get('SystemSignalLongSymbol')?.value
  if (typeof v !== 'string') return sig.name
  const cleaned = v.replace(/"/g, '').trim()
  return cleaned.length > 0 ? cleaned : sig.name
}
```

The quote-stripping mirrors the existing `VFrameFormat` handling at [dbc.ts:43](src/main/dbc.ts#L43) — candied sometimes returns the raw quoted string. Verify once against the real DBC; if candied already unquotes, the `.replace` is a harmless no-op.

**Verify the signal-side API.** candied's `Signal` may expose attributes under a different key than `.attributes` (e.g. `attributeValues`). Check [node_modules/candied/lib/dbc/Dbc.d.ts](node_modules/candied/lib/dbc/Dbc.d.ts) before writing; if the shape differs, adjust `longSignalName` accordingly. The message-side `.attributes.get(...)` pattern is already known to work from [dbc.ts:40](src/main/dbc.ts#L40).

Extend `SignalInfo` to carry the resolved name:

```ts
export type SignalInfo = { name: string; unit: string }
// becomes:
export type SignalInfo = { name: string; unit: string }   // unchanged shape
```

Keep the shape unchanged — `name` just starts carrying the resolved long symbol instead of the short one. That means the field stays in the same place; downstream consumers don't need type changes. Same for `MessageInfo.name`.

In `catalogFromData`, replace:

```ts
for (const [, sig] of msg.signals) signals.push({ name: sig.name, unit: sig.unit ?? '' })
messages.push({ id: msg.id, name: msg.name, signals })
```

with:

```ts
for (const [, sig] of msg.signals) signals.push({ name: longSignalName(sig), unit: sig.unit ?? '' })
messages.push({ id: msg.id, name: longMessageName(msg), signals })
```

The `idToMessage.set(mask29(msg.id), msg)` and PGN map entries stay keyed by `mask29(msg.id)`, not by name — **no change**.

### [src/main/decode.ts](src/main/decode.ts)

Two places to thread the resolved names through — both in the `meta` build loop around [decode.ts:82](src/main/decode.ts#L82):

```ts
meta.set(key, {
  signalName: sig.name,                 // ← use longSignalName(sig)
  messageName: r.message.name,          // ← use longMessageName(r.message)
  sa: r.sa,
  unit: sig.unit ?? ''
})
```

Import the two helpers from `./dbc` (export them) or duplicate the ~5-line helpers locally. Prefer exporting — single source of truth.

Signal keys stay keyed by the resolved `signalName` (via `seriesKey`), because that's what the renderer displays and what makes the `@SA` disambiguation readable. **However**, this changes the key string for the 11 long-renamed signals: a trace decoded under the old DBC and one decoded under the new DBC will produce different `seriesKey` outputs. That's correct behavior — the payload cache lives in memory per session, and the Phase 5c layout-persistence plan will restore stale keys as empty legends, which is already handled.

No other changes to `decode.ts`. The decoder still reads `sig.startBit`, `sig.length`, etc. directly from candied's `Signal` — which carries the raw DBC numbers regardless of display name.

### [src/main/index.ts](src/main/index.ts)

No changes. `TraceLoadResult`, `trace:getSignal` output, and `dbc:load` output all already plumb through `signalName` / `messageName` from the decoder's `meta` — which now carries the resolved names automatically.

### Renderer

No changes. [src/renderer/src/App.tsx](src/renderer/src/App.tsx) already renders `s.signalName`, `s.messageName`, `p.signalName`, and `msgName` directly.

## Tests

Extend [src/main/decode.test.ts](src/main/decode.test.ts) **only if** convenient with the existing `extractBits`-focused tests — skip otherwise. The long-symbol lookup is a one-line attribute read; the value comes from candied; there's nothing novel to verify in isolation.

Manual verification (the real test):

1. Load `pete_j1939.dbc`, load a trace, confirm the picker sidebar shows `ElectronicTransmissionController1` (long) where it previously showed `ElectronicTransmissionContr_0001` (short).
2. Confirm messages *without* a `SystemMessageLongSymbol` attribute (the other ~258 messages) still show their short names unchanged — `ElectronicEngineController1`, `EngineGasFlowRate`, etc.
3. Spot-check a signal with `SystemSignalLongSymbol` — pick one from `grep "SystemSignalLongSymbol" pete_j1939.dbc` — and confirm it shows the long name in picker + legend + cursor readout + hover tooltip.
4. Confirm decoded values are identical before/after (the display-name swap must not touch decoded numbers). Compare one series' first few samples against a known-good previous run.

## Suggested PR sequencing

One commit. The change is <40 lines plus the two helpers.

## Follow-ups removed from backlog

- **Global `VAL_TABLE_` resolution** (flagged in `plan_phase5b.md` open flags) — not needed for this DBC. Drop from the CLAUDE.md non-goals list too, or leave as a latent note; it's harmless either way. Recommend dropping — fewer stale notes.

## Open flags for the implementer

- If candied exposes `Signal.attributes` as `Map<string, Attribute>` but stores the long-symbol value somewhere else (e.g. in a parallel `signalAttributes` on the parent `Dbc`), adjust `longSignalName` to look it up there. The `pete_j1939.dbc` has only 11 such entries — quick to verify with a one-off `console.log` during implementation.
- The short symbol is typically a truncation ending in `_NNNN` (candied's disambiguation suffix). If two messages share a truncated prefix, candied gives each a unique `_NNNN`. The long symbol may still collide (e.g. two `ElectronicTransmissionController1` entries from different source-address rows). The existing `${signalName}@${sa}` series key disambiguates these naturally — nothing to do.
