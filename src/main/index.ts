import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { loadDbc, type LoadedDbc } from './dbc'
import type { SignalSeries } from './decode'
import type { ProgressCb } from './frame'
import { readLayout, writeLayout, type Layout } from './store'
import { runDecodeWorker } from './workerHost'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

type DbcLoadResult =
  | {
      ok: true
      summary: LoadedDbc['summary']
      catalog: LoadedDbc['catalog']
      decodable: boolean
    }
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

type TraceLoadResult =
  | {
      ok: true
      frameCount: number
      skipped: number
      signals: TraceSignalSummary[]
      warnings: string[]
    }
  | { ok: false; error: string }

let currentDbc: LoadedDbc | null = null
let currentDbcPath: string | null = null
let currentSeries: Map<string, SignalSeries> | null = null

function summarize(series: Map<string, SignalSeries>): TraceSignalSummary[] {
  return Array.from(series.entries())
    .map(([key, s]) => ({
      key,
      signalName: s.signalName,
      messageName: s.messageName,
      sa: s.sa,
      unit: s.unit,
      enum: s.enum,
      count: s.timestamps.length
    }))
    .filter((s) => s.count > 0)
    .sort(
      (a, b) =>
        a.messageName.localeCompare(b.messageName) ||
        a.signalName.localeCompare(b.signalName) ||
        (a.sa ?? -1) - (b.sa ?? -1)
    )
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  ipcMain.handle('dbc:load', async (_evt, filePath: string): Promise<DbcLoadResult> => {
    try {
      const loaded = await loadDbc(filePath)
      currentDbc = loaded
      currentDbcPath = filePath
      currentSeries = null
      return {
        ok: true,
        summary: loaded.summary,
        catalog: loaded.catalog,
        decodable: loaded.decodable
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('dbc:pick', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const opts = {
      properties: ['openFile' as const],
      filters: [{ name: 'DBC / DBC-JSON', extensions: ['dbc', 'json'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('trace:load', async (evt, filePath: string): Promise<TraceLoadResult> => {
    try {
      if (!currentDbc || !currentDbcPath) return { ok: false, error: 'Load a DBC first.' }
      if (!currentDbc.decodable) {
        return { ok: false, error: 'Drop a .dbc file to enable decoding (JSON cannot decode).' }
      }
      const emit: ProgressCb = (p) => evt.sender.send('trace:progress', p)
      const { series, frameCount, skipped, warnings } = await runDecodeWorker(
        filePath,
        currentDbcPath,
        emit
      )
      currentSeries = series
      return {
        ok: true,
        frameCount,
        skipped,
        signals: summarize(series),
        warnings
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('trace:pick', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const opts = {
      properties: ['openFile' as const],
      filters: [{ name: 'Trace (TRC / MF4)', extensions: ['trc', 'mf4'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('trace:getSignal', async (_evt, key: string) => {
    if (!currentSeries) return null
    const s = currentSeries.get(key)
    if (!s) return null
    return {
      key,
      signalName: s.signalName,
      messageName: s.messageName,
      sa: s.sa,
      unit: s.unit,
      enum: s.enum,
      timestamps: s.timestamps,
      values: s.values
    }
  })

  ipcMain.handle('layout:read', async (): Promise<Layout | null> => readLayout())
  ipcMain.handle('layout:write', async (_e, layout: Layout): Promise<void> => writeLayout(layout))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
