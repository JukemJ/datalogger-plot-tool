import { readFile } from 'fs/promises'
import { extname } from 'path'
import { Dbc } from 'candied'
import type { Message, Signal } from 'candied/lib/dbc/Dbc'

export type SignalInfo = { name: string; unit: string }
export type MessageInfo = { id: number; name: string; signals: SignalInfo[] }
export type DbcSummary = { version: string; messageCount: number; signalCount: number }
export type LoadedDbc = {
  summary: DbcSummary
  catalog: { messages: MessageInfo[] }
  idToMessage: Map<number, Message>
  pgnToMessage: Map<number, Message>
  decodable: boolean
}

const EXTENDED_ID_FLAG = 0x80000000

function is29Bit(id: number): boolean {
  return (id & EXTENDED_ID_FLAG) !== 0 || id > 0x7ff
}

function mask29(id: number): number {
  return id & 0x1fffffff
}

export function pgnOf(id29: number): number {
  const pf = (id29 >> 16) & 0xff
  const ps = (id29 >> 8) & 0xff
  const dp = (id29 >> 24) & 0x3
  if (pf < 240) return (dp << 16) | (pf << 8)
  return (dp << 16) | (pf << 8) | ps
}

export function saOf(id29: number): number {
  return id29 & 0xff
}

export function longMessageName(msg: Message): string {
  const v = msg.attributes.get('SystemMessageLongSymbol')?.value
  if (typeof v !== 'string') return msg.name
  const cleaned = v.replace(/"/g, '').trim()
  return cleaned.length > 0 && cleaned !== msg.name ? cleaned : msg.name
}

export function longSignalName(sig: Signal): string {
  const v = sig.attributes.get('SystemSignalLongSymbol')?.value
  if (typeof v !== 'string') return sig.name
  const cleaned = v.replace(/"/g, '').trim()
  return cleaned.length > 0 && cleaned !== sig.name ? cleaned : sig.name
}

function isJ1939Message(msg: Message): boolean {
  const attr = msg.attributes.get('VFrameFormat')
  const val = attr?.value ?? attr?.defaultValue
  if (val) {
    const v = String(val).replace(/"/g, '').trim()
    if (v === 'J1939PG') return true
    if (v === 'StandardCAN' || v === 'ExtendedCAN') return false
  }
  const id = mask29(msg.id)
  return is29Bit(msg.id) && pgnOf(id) !== 0
}

function catalogFromData(data: ReturnType<Dbc['load']>): {
  summary: DbcSummary
  catalog: { messages: MessageInfo[] }
  idToMessage: Map<number, Message>
  pgnToMessage: Map<number, Message>
} {
  const messages: MessageInfo[] = []
  const idToMessage = new Map<number, Message>()
  const pgnToMessage = new Map<number, Message>()
  let signalCount = 0
  for (const [, msg] of data.messages) {
    const signals: SignalInfo[] = []
    for (const [, sig] of msg.signals)
      signals.push({ name: longSignalName(sig), unit: sig.unit ?? '' })
    messages.push({ id: msg.id, name: longMessageName(msg), signals })
    idToMessage.set(mask29(msg.id), msg)
    if (isJ1939Message(msg)) {
      const pgn = pgnOf(mask29(msg.id))
      if (!pgnToMessage.has(pgn)) pgnToMessage.set(pgn, msg)
    }
    signalCount += signals.length
  }
  return {
    summary: { version: data.version ?? '', messageCount: messages.length, signalCount },
    catalog: { messages },
    idToMessage,
    pgnToMessage
  }
}

export async function loadDbc(filePath: string): Promise<LoadedDbc> {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.dbc') {
    const text = await readFile(filePath, 'utf8')
    const dbc = new Dbc()
    const data = dbc.load(text)
    const { summary, catalog, idToMessage, pgnToMessage } = catalogFromData(data)
    return { summary, catalog, idToMessage, pgnToMessage, decodable: true }
  }
  if (ext === '.json') {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.messages)) {
      throw new Error('Not a DBC-JSON file (missing "messages" array)')
    }
    const messages: MessageInfo[] = parsed.messages.map(
      (m: { id: number; name: string; signals?: Array<{ name: string; unit?: string }> }) => ({
        id: m.id,
        name: m.name,
        signals: (m.signals ?? []).map((s) => ({ name: s.name, unit: s.unit ?? '' }))
      })
    )
    const signalCount = messages.reduce((n, m) => n + m.signals.length, 0)
    return {
      summary: {
        version: typeof parsed.version === 'string' ? parsed.version : '',
        messageCount: messages.length,
        signalCount
      },
      catalog: { messages },
      idToMessage: new Map(),
      pgnToMessage: new Map(),
      decodable: false
    }
  }
  throw new Error(`Unsupported DBC extension: ${ext}`)
}
