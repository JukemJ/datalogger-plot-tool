import { parentPort, type TransferListItem } from 'worker_threads'
import { extname } from 'path'
import { loadDbc } from './dbc'
import { parseTrc } from './trc'
import { parseMf4 } from './mf4'
import { decodeFrames, type SignalSeries } from './decode'
import type { ProgressCb } from './frame'

type Request = { filePath: string; dbcPath: string }

type DoneEvent = {
  kind: 'done'
  series: Array<[string, SignalSeries]>
  frameCount: number
  skipped: number
  warnings: string[]
}

type ProgressEvent = {
  kind: 'progress'
  stage: 'reading' | 'parsing' | 'decoding' | 'indexing'
  current: number
  total: number
}

type ErrorEvent = { kind: 'error'; message: string }

type Event = DoneEvent | ProgressEvent | ErrorEvent

if (!parentPort) throw new Error('decode.worker must run as a worker_threads worker')

const port = parentPort

const send = (ev: Event, transferList?: TransferListItem[]): void => {
  port.postMessage(ev, transferList)
}

port.on('message', async (req: Request) => {
  try {
    const emit: ProgressCb = (p) => send({ kind: 'progress', ...p })

    const dbc = await loadDbc(req.dbcPath)
    if (!dbc.decodable) {
      send({ kind: 'error', message: 'Drop a .dbc file to enable decoding (JSON cannot decode).' })
      return
    }

    const ext = extname(req.filePath).toLowerCase()
    let frames, skipped: number, warnings: string[]
    if (ext === '.mf4') {
      ;({ frames, skipped, warnings } = await parseMf4(req.filePath, emit))
    } else if (ext === '.trc') {
      ;({ frames, skipped } = await parseTrc(req.filePath, emit))
      warnings = []
    } else {
      send({ kind: 'error', message: `Unsupported trace extension: ${ext}` })
      return
    }

    const series = await decodeFrames(frames, dbc.idToMessage, dbc.pgnToMessage, emit)

    const entries = Array.from(series.entries())
    const transfers: TransferListItem[] = []
    for (const [, s] of entries) {
      transfers.push(s.timestamps.buffer as ArrayBuffer)
      transfers.push(s.values.buffer as ArrayBuffer)
    }
    send(
      { kind: 'done', series: entries, frameCount: frames.length, skipped, warnings },
      transfers
    )
  } catch (err) {
    send({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
  }
})
