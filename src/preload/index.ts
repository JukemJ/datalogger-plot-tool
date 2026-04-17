import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  loadDbc: (filePath: string) => ipcRenderer.invoke('dbc:load', filePath),
  pickDbc: () => ipcRenderer.invoke('dbc:pick'),
  loadTrc: (filePath: string) => ipcRenderer.invoke('trc:load', filePath),
  pickTrc: () => ipcRenderer.invoke('trc:pick'),
  getSignal: (key: string) => ipcRenderer.invoke('trc:getSignal', key),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  onTrcProgress: (
    cb: (p: {
      stage: 'reading' | 'parsing' | 'decoding' | 'indexing'
      current: number
      total: number
    }) => void
  ) => {
    const handler = (_e: Electron.IpcRendererEvent, p: Parameters<typeof cb>[0]): void => cb(p)
    ipcRenderer.on('trc:progress', handler)
    return () => ipcRenderer.removeListener('trc:progress', handler)
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
