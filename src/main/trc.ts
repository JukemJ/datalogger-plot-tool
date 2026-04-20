// TRC v2.1 parser. Uses $COLUMNS header to locate fields.
import { readFile } from 'fs/promises'
import type { Frame, ProgressCb } from './frame'

export type { Frame, ProgressStage, ProgressCb } from './frame'
export type TrcParseResult = { frames: Frame[]; skipped: number }

type ColumnMap = { time: number; type: number; id: number; length: number; data: number }

const PARSE_CHUNK = 10_000

function parseColumns(spec: string): ColumnMap {
  const cols = spec.split(',').map((c) => c.trim())
  const idx = (ch: string): number => cols.indexOf(ch)
  const time = idx('O')
  const type = idx('T')
  const id = idx('I')
  const length = idx('L')
  const data = idx('D')
  if (time < 0 || type < 0 || id < 0 || length < 0 || data < 0) {
    throw new Error(`TRC $COLUMNS missing required fields: ${spec}`)
  }
  return { time, type, id, length, data }
}

const yieldControl = (): Promise<void> => new Promise((r) => setImmediate(r))

export async function parseTrc(filePath: string, onProgress?: ProgressCb): Promise<TrcParseResult> {
  onProgress?.({ stage: 'reading', current: 0, total: 1 })
  const text = await readFile(filePath, 'utf8')
  onProgress?.({ stage: 'reading', current: 1, total: 1 })
  const lines = text.split(/\r?\n/)

  let version: string | null = null
  let columns: ColumnMap | null = null
  for (const line of lines) {
    if (!line.startsWith(';')) break
    const v = line.match(/\$FILEVERSION\s*=\s*([\d.]+)/)
    if (v) version = v[1]
    const c = line.match(/\$COLUMNS\s*=\s*(.+)$/)
    if (c) columns = parseColumns(c[1].trim())
  }
  if (version === null) throw new Error('TRC file is missing $FILEVERSION header')
  if (version !== '2.1')
    throw new Error(`Unsupported TRC version ${version}. Only 2.1 is supported in this phase.`)
  if (!columns)
    throw new Error('TRC file is missing $COLUMNS header (required for v2.1 parsing).')

  const col = columns
  const minTokens = Math.max(col.time, col.type, col.id, col.length, col.data) + 1

  const frames: Frame[] = []
  let skipped = 0
  const total = lines.length
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw) {
      const line = raw.trim()
      if (line && !line.startsWith(';')) {
        const tokens = line.split(/\s+/)
        if (tokens.length < minTokens) {
          skipped++
        } else if (tokens[col.type] === 'DT') {
          const timestampMs = parseFloat(tokens[col.time])
          const timestamp = timestampMs / 1000
          const id = parseInt(tokens[col.id], 16)
          const dlc = parseInt(tokens[col.length], 10)
          if (!Number.isFinite(timestamp) || !Number.isFinite(id) || !Number.isFinite(dlc)) {
            skipped++
          } else if (tokens.length < col.data + dlc) {
            skipped++
          } else {
            const data = new Uint8Array(dlc)
            for (let b = 0; b < dlc; b++) data[b] = parseInt(tokens[col.data + b], 16)
            frames.push({ timestamp, id, extended: id > 0x7ff, data })
          }
        }
      }
    }
    if ((i & (PARSE_CHUNK - 1)) === PARSE_CHUNK - 1) {
      onProgress?.({ stage: 'parsing', current: i + 1, total })
      await yieldControl()
    }
  }
  onProgress?.({ stage: 'parsing', current: total, total })
  return { frames, skipped }
}
