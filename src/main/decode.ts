import type { Message, Signal } from 'candied/lib/dbc/Dbc'
import type { Frame, ProgressCb } from './frame'
import { pgnOf, saOf, longMessageName, longSignalName } from './dbc'
import { extractBits } from './bits'

const DECODE_CHUNK = 50_000
const yieldControl = (): Promise<void> => new Promise((r) => setImmediate(r))

export { extractBits }

export type SignalSeries = {
  signalName: string
  messageName: string
  sa: number | null
  unit: string
  enum: Record<number, string> | null
  timestamps: Float64Array
  values: Float64Array
}

export type DecodedSignal = { name: string; rawValue: number; value: number; unit: string }

function mask29(id: number): number {
  return id & 0x1fffffff
}

export function decodeFrame(frame: Frame, message: Message): DecodedSignal[] {
  const out: DecodedSignal[] = []
  for (const [, sig] of message.signals) {
    out.push(decodeSignal(frame.data, sig))
  }
  return out
}

function decodeSignal(data: Uint8Array, sig: Signal): DecodedSignal {
  const raw = extractBits(data, sig.startBit, sig.length, sig.endian, sig.signed)
  const value = raw * sig.factor + sig.offset
  return { name: sig.name, rawValue: raw, value, unit: sig.unit ?? '' }
}

export function seriesKey(signalName: string, sa: number | null): string {
  return `${signalName}@${sa === null ? 'none' : sa}`
}

function resolveMessage(
  frame: Frame,
  idToMessage: Map<number, Message>,
  pgnToMessage: Map<number, Message>
): { message: Message; sa: number | null } | null {
  const id = mask29(frame.id)
  const exact = idToMessage.get(id)
  if (exact) {
    const sa = frame.extended ? saOf(id) : null
    return { message: exact, sa }
  }
  if (frame.extended) {
    const pgn = pgnOf(id)
    const viaPgn = pgnToMessage.get(pgn)
    if (viaPgn) return { message: viaPgn, sa: saOf(id) }
  }
  return null
}

export async function decodeFrames(
  frames: Frame[],
  idToMessage: Map<number, Message>,
  pgnToMessage: Map<number, Message>,
  onProgress?: ProgressCb
): Promise<Map<string, SignalSeries>> {
  const total = frames.length
  const counts = new Map<string, number>()
  const sigNameCache = new WeakMap<Signal, string>()
  const msgNameCache = new WeakMap<Message, string>()
  const resolveSigName = (sig: Signal): string => {
    const hit = sigNameCache.get(sig)
    if (hit !== undefined) return hit
    const n = longSignalName(sig)
    sigNameCache.set(sig, n)
    return n
  }
  const resolveMsgName = (msg: Message): string => {
    const hit = msgNameCache.get(msg)
    if (hit !== undefined) return hit
    const n = longMessageName(msg)
    msgNameCache.set(msg, n)
    return n
  }
  const meta = new Map<
    string,
    {
      signalName: string
      messageName: string
      sa: number | null
      unit: string
      enum: Record<number, string> | null
    }
  >()
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    const r = resolveMessage(f, idToMessage, pgnToMessage)
    if (r) {
      for (const [, sig] of r.message.signals) {
        const signalName = resolveSigName(sig)
        const key = seriesKey(signalName, r.sa)
        counts.set(key, (counts.get(key) ?? 0) + 1)
        if (!meta.has(key))
          meta.set(key, {
            signalName,
            messageName: resolveMsgName(r.message),
            sa: r.sa,
            unit: sig.unit ?? '',
            enum:
              sig.valueTable && sig.valueTable.size > 0
                ? Object.fromEntries(sig.valueTable)
                : null
          })
      }
    }
    if ((i & (DECODE_CHUNK - 1)) === DECODE_CHUNK - 1) {
      onProgress?.({ stage: 'indexing', current: i + 1, total })
      await yieldControl()
    }
  }
  onProgress?.({ stage: 'indexing', current: total, total })

  const store = new Map<string, SignalSeries>()
  const writeIdx = new Map<string, number>()
  for (const [key, n] of counts) {
    const m = meta.get(key)!
    store.set(key, {
      signalName: m.signalName,
      messageName: m.messageName,
      sa: m.sa,
      unit: m.unit,
      enum: m.enum,
      timestamps: new Float64Array(n),
      values: new Float64Array(n)
    })
    writeIdx.set(key, 0)
  }

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    const r = resolveMessage(f, idToMessage, pgnToMessage)
    if (r) {
      for (const [, sig] of r.message.signals) {
        const key = seriesKey(resolveSigName(sig), r.sa)
        const series = store.get(key)!
        const idx = writeIdx.get(key)!
        const raw = extractBits(f.data, sig.startBit, sig.length, sig.endian, sig.signed)
        series.timestamps[idx] = f.timestamp
        series.values[idx] = raw * sig.factor + sig.offset
        writeIdx.set(key, idx + 1)
      }
    }
    if ((i & (DECODE_CHUNK - 1)) === DECODE_CHUNK - 1) {
      onProgress?.({ stage: 'decoding', current: i + 1, total })
      await yieldControl()
    }
  }
  onProgress?.({ stage: 'decoding', current: total, total })
  return store
}
