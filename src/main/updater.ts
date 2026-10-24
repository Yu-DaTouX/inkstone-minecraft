// 自动更新：从 GitHub Releases 拉新版本（electron-updater 读 release 里的 latest.yml）。
// 打包版启动 15 秒后检查一次，之后每 6 小时一次；有新版就在后台下载，下好了提示「重启更新」，
// 不点的话下次退出启动器时自动装。开发版不检查。
import { app } from 'electron'
import updaterPkg from 'electron-updater'
import type { UpdateStatus } from '../shared/api.ts'

const { autoUpdater } = updaterPkg

const FIRST_CHECK_MS = 15_000
const EVERY_MS = 6 * 60 * 60 * 1000

let status: UpdateStatus = { state: app.isPackaged ? 'idle' : 'dev', current: app.getVersion(), version: null, progress: null, error: null, checkedAt: null }
let notify: (status: UpdateStatus) => void = () => undefined

function set(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  notify(status)
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::/i.test(text)) return '连不上 GitHub，稍后再试'
  if (/404|latest\.yml/i.test(text)) return '还没有发布过可更新的版本'
  return text.split('\n')[0].slice(0, 160)
}

export function updateStatus(): UpdateStatus {
  return status
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  if (!app.isPackaged) return status
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'ready') return status
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    set({ state: 'error', error: message(error), checkedAt: Date.now() })
  }
  return status
}

export function installUpdate(): void {
  if (status.state !== 'ready') return
  // 游戏是独立进程，重启启动器不影响正在玩的游戏
  autoUpdater.quitAndInstall(true, true)
}

export function startUpdater(onStatus: (status: UpdateStatus) => void): void {
  notify = onStatus
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: null }))
  autoUpdater.on('update-not-available', () => set({ state: 'latest', version: null, checkedAt: Date.now() }))
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version, progress: 0, checkedAt: Date.now() }))
  autoUpdater.on('download-progress', (progress) => set({ state: 'downloading', progress: Math.round(progress.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version, progress: 100 }))
  autoUpdater.on('error', (error) => set({ state: 'error', error: message(error), checkedAt: Date.now() }))
  setTimeout(() => void checkForUpdate(), FIRST_CHECK_MS)
  setInterval(() => void checkForUpdate(), EVERY_MS)
}
