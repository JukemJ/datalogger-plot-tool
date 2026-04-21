import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { writeFile } from 'fs/promises'
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

function labelFor(s: SignalSeries): string {
  if (s.sa === null) return s.signalName
  const hex = `0x${s.sa.toString(16).padStart(2, '0').toUpperCase()}`
  return `${s.signalName}@${hex}`
}

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

  ipcMain.handle(
    'trace:exportCsv',
    async (
      evt,
      args: { keys: string[]; xStart: number | null; xEnd: number | null }
    ): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
      try {
        if (!currentSeries) return { ok: false, error: 'No trace loaded.' }
        const series = args.keys
          .map((k) => [k, currentSeries!.get(k)] as const)
          .filter((e): e is [string, SignalSeries] => e[1] !== undefined)
        if (series.length === 0) return { ok: false, error: 'No signals selected.' }

        const win = BrowserWindow.fromWebContents(evt.sender)
        const save = win
          ? await dialog.showSaveDialog(win, {
              defaultPath: 'trace.csv',
              filters: [{ name: 'CSV', extensions: ['csv'] }]
            })
          : await dialog.showSaveDialog({
              defaultPath: 'trace.csv',
              filters: [{ name: 'CSV', extensions: ['csv'] }]
            })
        if (save.canceled || !save.filePath) return { ok: true, path: '' }

        const xStart = args.xStart ?? -Infinity
        const xEnd = args.xEnd ?? Infinity
        const tsSet = new Set<number>()
        for (const [, s] of series) {
          for (let i = 0; i < s.timestamps.length; i++) {
            const t = s.timestamps[i]
            if (t >= xStart && t <= xEnd) tsSet.add(t)
            if (tsSet.size > 1_000_000) break
          }
          if (tsSet.size > 1_000_000) break
        }
        if (tsSet.size > 1_000_000) {
          return {
            ok: false,
            error: 'Export would exceed 1,000,000 rows. Zoom in and retry.'
          }
        }
        const xs = Array.from(tsSet).sort((a, b) => a - b)

        const cursors = series.map(([, s]) => ({ s, i: 0, last: NaN }))
        const esc = (v: string): string =>
          /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
        const header = ['timestamp', ...series.map(([, s]) => labelFor(s))]
          .map(esc)
          .join(',')
        const lines = [header]
        for (const t of xs) {
          const row: string[] = [t.toFixed(6)]
          for (const c of cursors) {
            while (c.i < c.s.timestamps.length && c.s.timestamps[c.i] <= t) {
              c.last = c.s.values[c.i]
              c.i++
            }
            if (Number.isNaN(c.last)) row.push('')
            else if (c.s.enum) row.push(c.s.enum[Math.round(c.last)] ?? String(c.last))
            else row.push(String(c.last))
          }
          lines.push(row.map(esc).join(','))
        }
        await writeFile(save.filePath, lines.join('\n'), 'utf8')
        return { ok: true, path: save.filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
