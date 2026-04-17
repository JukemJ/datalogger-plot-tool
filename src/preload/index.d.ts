import { ElectronAPI } from '@electron-toolkit/preload'

export type DbcSummary = { version: string; messageCount: number; signalCount: number }
export type SignalInfo = { name: string; unit: string }
export type MessageInfo = { id: number; name: string; signals: SignalInfo[] }
export type DbcCatalog = { messages: MessageInfo[] }

export type DbcLoadResult =
  | { ok: true; summary: DbcSummary; catalog: DbcCatalog; decodable: boolean }
  | { ok: false; error: string }

export type TrcSignalSummary = {
  key: string
  signalName: string
  messageName: string
  sa: number | null
  unit: string
  count: number
}
export type TrcLoadResult =
  | { ok: true; frameCount: number; skipped: number; signals: TrcSignalSummary[] }
  | { ok: false; error: string }

export type SignalPayload = {
  key: string
  signalName: string
  messageName: string
  sa: number | null
  unit: string
  timestamps: Float64Array
  values: Float64Array
}

export type ProgressStage = 'reading' | 'parsing' | 'decoding' | 'indexing'
export type TrcProgress = { stage: ProgressStage; current: number; total: number }

export interface Api {
  loadDbc: (filePath: string) => Promise<DbcLoadResult>
  pickDbc: () => Promise<string | null>
  loadTrc: (filePath: string) => Promise<TrcLoadResult>
  pickTrc: () => Promise<string | null>
  getSignal: (key: string) => Promise<SignalPayload | null>
  getPathForFile: (file: File) => string
  onTrcProgress: (cb: (p: TrcProgress) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
