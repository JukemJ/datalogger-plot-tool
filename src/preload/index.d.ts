import { ElectronAPI } from '@electron-toolkit/preload'

export type DbcSummary = { version: string; messageCount: number; signalCount: number }
export type SignalInfo = { name: string; unit: string }
export type MessageInfo = { id: number; name: string; signals: SignalInfo[] }
export type DbcCatalog = { messages: MessageInfo[] }

export type DbcLoadResult =
  | { ok: true; summary: DbcSummary; catalog: DbcCatalog; decodable: boolean }
  | { ok: false; error: string }

export type TraceSignalSummary = {
  key: string
  signalName: string
  messageName: string
  sa: number | null
  unit: string
  enum: Record<number, string> | null
  count: number
}
export type TraceLoadResult =
  | {
      ok: true
      frameCount: number
      skipped: number
      signals: TraceSignalSummary[]
      warnings: string[]
    }
  | { ok: false; error: string }

export type SignalPayload = {
  key: string
  signalName: string
  messageName: string
  sa: number | null
  unit: string
  enum: Record<number, string> | null
  timestamps: Float64Array
  values: Float64Array
}

export type ProgressStage = 'reading' | 'parsing' | 'decoding' | 'indexing'
export type TraceProgress = { stage: ProgressStage; current: number; total: number }

export type Layout = {
  version: 1
  dbcPath: string | null
  tracePath: string | null
  panes: { id: string; title: string; traces: { key: string; axis: 'left' | 'right' }[] }[]
  activePaneId: string | null
  filter: string
  openGroups: string[]
  cursors: { a: number | null; b: number | null; mode: boolean; snap?: boolean }
}

export interface Api {
  loadDbc: (filePath: string) => Promise<DbcLoadResult>
  pickDbc: () => Promise<string | null>
  loadTrace: (filePath: string) => Promise<TraceLoadResult>
  pickTrace: () => Promise<string | null>
  getSignal: (key: string) => Promise<SignalPayload | null>
  readLayout: () => Promise<Layout | null>
  writeLayout: (layout: Layout) => Promise<void>
  exportCsv: (args: {
    keys: string[]
    xStart: number | null
    xEnd: number | null
  }) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
  exportPng: (args: {
    bytes: Uint8Array
    suggestedName: string
  }) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
  getPathForFile: (file: File) => string
  onTraceProgress: (cb: (p: TraceProgress) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
