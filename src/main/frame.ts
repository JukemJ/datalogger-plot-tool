export type Frame = {
  timestamp: number
  id: number
  extended: boolean
  data: Uint8Array
}

export type ProgressStage = 'reading' | 'parsing' | 'decoding' | 'indexing'
export type ProgressCb = (p: { stage: ProgressStage; current: number; total: number }) => void
