import { Worker } from 'worker_threads'
import { join } from 'path'
import type { SignalSeries } from './decode'
import type { ProgressCb } from './frame'

export type DecodeResult = {
  series: Map<string, SignalSeries>
  frameCount: number
  skipped: number
  warnings: string[]
}

type WorkerMsg =
  | { kind: 'progress'; stage: 'reading' | 'parsing' | 'decoding' | 'indexing'; current: number; total: number }
  | {
      kind: 'done'
      series: Array<[string, SignalSeries]>
      frameCount: number
      skipped: number
      warnings: string[]
    }
  | { kind: 'error'; message: string }

export function runDecodeWorker(
  filePath: string,
  dbcPath: string,
  onProgress: ProgressCb
): Promise<DecodeResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'decode.worker.js'))
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
      worker.terminate()
    }

    worker.on('message', (msg: WorkerMsg) => {
      if (msg.kind === 'progress') {
        onProgress({ stage: msg.stage, current: msg.current, total: msg.total })
      } else if (msg.kind === 'done') {
        finish(() =>
          resolve({
            series: new Map(msg.series),
            frameCount: msg.frameCount,
            skipped: msg.skipped,
            warnings: msg.warnings
          })
        )
      } else if (msg.kind === 'error') {
        finish(() => reject(new Error(msg.message)))
      }
    })
    worker.on('error', (err) => finish(() => reject(err)))
    worker.on('exit', (code) => {
      if (!settled) {
        settled = true
        reject(new Error(`Worker exited unexpectedly with code ${code}`))
      }
    })

    worker.postMessage({ filePath, dbcPath })
  })
}
