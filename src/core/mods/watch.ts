import { watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isModFileName } from './scan.ts'

/** Active Mod pages only; polling recovers missing/replaced dirs and lost fs events. */
export function watchMods(directory: string, changed: () => void): () => void {
  let closed = false
  let watcher: FSWatcher | null = null
  let identity = ''
  let fingerprint: string | null = null
  let busy = false
  let debounce: ReturnType<typeof setTimeout> | null = null
  const notify = (): void => {
    if (closed) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => { debounce = null; if (!closed) changed() }, 400)
  }
  const scan = async (): Promise<void> => {
    if (closed || busy) return
    busy = true
    try {
      const info = await stat(directory).catch(() => null)
      if (closed) return
      const nextIdentity = info?.isDirectory() ? `${info.dev}:${info.ino}:${info.birthtimeMs}` : ''
      if (nextIdentity !== identity || (!watcher && nextIdentity)) {
        watcher?.close()
        watcher = null
        identity = nextIdentity
        if (identity) {
          try {
            watcher = watch(directory, (_event, file) => { if (!file || isModFileName(String(file))) notify() })
            watcher.on('error', () => { watcher?.close(); watcher = null })
          } catch { /* Polling still detects changes. */ }
        }
      }
      const names = (await readdir(directory).catch(() => [] as string[])).filter(isModFileName).sort()
      const entries = await Promise.all(names.map(async (name) => {
        const file = await stat(join(directory, name)).catch(() => null)
        return `${name}:${file?.size}:${file?.mtimeMs}:${file?.ctimeMs}`
      }))
      const next = `${nextIdentity}|${entries.join('|')}`
      if (fingerprint !== null && fingerprint !== next) notify()
      fingerprint = next
    } finally { busy = false }
  }
  void scan()
  const timer = setInterval(() => { void scan() }, 2000)
  timer.unref()
  return () => { closed = true; clearInterval(timer); if (debounce) clearTimeout(debounce); watcher?.close(); watcher = null }
}
