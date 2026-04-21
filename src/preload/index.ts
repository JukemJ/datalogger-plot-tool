import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  loadDbc: (filePath: string) => ipcRenderer.invoke('dbc:load', filePath),
  pickDbc: () => ipcRenderer.invoke('dbc:pick'),
  loadTrace: (filePath: string) => ipcRenderer.invoke('trace:load', filePath),
  pickTrace: () => ipcRenderer.invoke('trace:pick'),
  getSignal: (key: string) => ipcRenderer.invoke('trace:getSignal', key),
  readLayout: () => ipcRenderer.invoke('layout:read'),
  writeLayout: (layout: unknown) => ipcRenderer.invoke('layout:write', layout),
  exportCsv: (args: { keys: string[]; xStart: number | null; xEnd: number | null }) =>
    ipcRenderer.invoke('trace:exportCsv', args),
  exportPng: (args: { bytes: Uint8Array; suggestedName: string }) =>
    ipcRenderer.invoke('trace:exportPng', args),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  onTraceProgress: (
    cb: (p: {
      stage: 'reading' | 'parsing' | 'decoding' | 'indexing'
      current: number
      total: number
    }) => void
  ) => {
    const handler = (_e: Electron.IpcRendererEvent, p: Parameters<typeof cb>[0]): void => cb(p)
    ipcRenderer.on('trace:progress', handler)
    return () => ipcRenderer.removeListener('trace:progress', handler)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
