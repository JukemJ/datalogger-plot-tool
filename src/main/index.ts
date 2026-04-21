import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, extname } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { loadDbc, type LoadedDbc } from './dbc'
import { parseTrc } from './trc'
import { parseMf4 } from './mf4'
import { decodeFrames, type SignalSeries } from './decode'
import type { Frame, ProgressCb } from './frame'

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
let currentSeries: Map<string, SignalSeries> | null = null

async function ingestFrames(
  frames: Frame[],
  skipped: number,
  warnings: string[],
  emit: ProgressCb
): Promise<TraceLoadResult> {
  if (!currentDbc) return { ok: false, error: 'Load a DBC first.' }
  if (!currentDbc.decodable) {
    return { ok: false, error: 'Drop a .dbc file to enable decoding (JSON cannot decode).' }
  }
  const series = await decodeFrames(frames, currentDbc.idToMessage, currentDbc.pgnToMessage, emit)
  currentSeries = series
  const signals: TraceSignalSummary[] = Array.from(series.entries())
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
  return { ok: true, frameCount: frames.length, skipped, signals, warnings }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  ipcMain.handle('dbc:load', async (_evt, filePath: string): Promise<DbcLoadResult> => {
    try {
      const loaded = await loadDbc(filePath)
      currentDbc = loaded
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
      const emit: ProgressCb = (p) => evt.sender.send('trace:progress', p)
      const ext = extname(filePath).toLowerCase()
      if (ext === '.mf4') {
        const { frames, skipped, warnings } = await parseMf4(filePath, emit)
        return ingestFrames(frames, skipped, warnings, emit)
      }
      if (ext === '.trc') {
        const { frames, skipped } = await parseTrc(filePath, emit)
        return ingestFrames(frames, skipped, [], emit)
      }
      return { ok: false, error: `Unsupported trace extension: ${ext}` }
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

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
