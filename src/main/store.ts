import { app } from 'electron'
import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import { dirname, join } from 'path'

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

const layoutPath = (): string => join(app.getPath('userData'), 'layout.json')

export async function readLayout(): Promise<Layout | null> {
  try {
    const raw = await readFile(layoutPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== 1) return null
    return parsed as Layout
  } catch {
    return null
  }
}

export async function writeLayout(l: Layout): Promise<void> {
  const target = layoutPath()
  const tmp = target + '.tmp'
  await mkdir(dirname(target), { recursive: true })
  await writeFile(tmp, JSON.stringify(l), 'utf8')
  await rename(tmp, target)
}
