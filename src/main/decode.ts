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

  type Accumulator = {
    signalName: string
    messageName: string
    sa: number | null
    unit: string
    enum: Record<number, string> | null
    timestamps: number[]
    values: number[]
  }
  const accum = new Map<string, Accumulator>()

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    const r = resolveMessage(f, idToMessage, pgnToMessage)
    if (r) {
      for (const [, sig] of r.message.signals) {
        const signalName = resolveSigName(sig)
        const key = seriesKey(signalName, r.sa)
        let a = accum.get(key)
        if (!a) {
          a = {
            signalName,
            messageName: resolveMsgName(r.message),
            sa: r.sa,
            unit: sig.unit ?? '',
            enum:
              sig.valueTable && sig.valueTable.size > 0
                ? Object.fromEntries(sig.valueTable)
                : null,
            timestamps: [],
            values: []
          }
          accum.set(key, a)
        }
        const raw = extractBits(f.data, sig.startBit, sig.length, sig.endian, sig.signed)
        a.timestamps.push(f.timestamp)
        a.values.push(raw * sig.factor + sig.offset)
      }
    }
    if ((i & (DECODE_CHUNK - 1)) === DECODE_CHUNK - 1) {
      onProgress?.({ stage: 'decoding', current: i + 1, total })
      await yieldControl()
    }
  }
  onProgress?.({ stage: 'decoding', current: total, total })

  const store = new Map<string, SignalSeries>()
  for (const [key, a] of accum) {
    store.set(key, {
      signalName: a.signalName,
      messageName: a.messageName,
      sa: a.sa,
      unit: a.unit,
      enum: a.enum,
      timestamps: new Float64Array(a.timestamps),
      values: new Float64Array(a.values)
    })
  }
  return store
}
