import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, shell, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'
import { readFile } from 'node:fs/promises'
import type { DownloadProbe, FolderTarget, InstallRequest, LauncherSettings, LaunchRequest, LaunchStatus, LogLine, TaskInfo } from '../shared/api.ts'
import type { CrashActionRequest, CrashDiagnosis } from '../shared/crash-api.ts'
import type { PreflightRequest } from '../shared/launch-api.ts'
import type { ResourceKind } from '../shared/version-api.ts'

const FOLDER_TARGETS: readonly FolderTarget[] = ['version', 'game', 'mods', 'saves', 'resourcepacks', 'shaderpacks', 'screenshots', 'logs', 'crash-reports']
import { CRAFT_CHANNELS } from '../shared/channels.ts'
import { MANIFEST_URL, MIRROR_ORIGIN, USER_AGENT } from '../core/download/sources.ts'
import { dataDir } from '../core/settings.ts'
import { MicrosoftAccounts } from '../core/microsoft.ts'
import { watchMods } from '../core/mods/watch.ts'
import { CraftService } from '../core/service.ts'
import { checkForUpdate, installUpdate, startUpdater, updateStatus } from './updater.ts'
import type { InstanceOverride, ModrinthSearchQuery, ModUpdateInfo } from '../shared/mods-api.ts'
import type { ContentSearchQuery } from '../shared/download-api.ts'

const service = new CraftService({
  microsoft: new MicrosoftAccounts(join(dataDir(), 'microsoft-credentials.bin'), {
    encrypt: (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存正版登录')
      return safeStorage.encryptString(value)
    },
    decrypt: (value) => safeStorage.decryptString(value)
  }),
  pclLauncherDirs: (process.env.INKSTONE_MC_PCL_DIRS ?? '').split(';').filter(Boolean)
})

let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let closeToTray = true
let trayHinted = false

const TITLE_BAR_HEIGHT = 48

const PROBE_TARGETS: { source: DownloadProbe['source']; label: string; url: string }[] = [
  { source: 'bmclapi', label: 'BMCLAPI', url: `${MIRROR_ORIGIN}/mc/game/version_manifest_v2.json` },
  { source: 'official', label: '官方', url: MANIFEST_URL }
]

async function probeDownloadSources(): Promise<DownloadProbe[]> {
  return Promise.all(
    PROBE_TARGETS.map(async (target) => {
      const startedAt = Date.now()
      try {
        const response = await fetch(target.url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': USER_AGENT } })
        if (!response.ok) return { source: target.source, label: target.label, ms: null, bytes: 0, error: `HTTP ${response.status}` }
        const bytes = (await response.arrayBuffer()).byteLength
        return { source: target.source, label: target.label, ms: Date.now() - startedAt, bytes, error: null }
      } catch (error) {
        return { source: target.source, label: target.label, ms: null, bytes: 0, error: error instanceof Error ? error.message : String(error) }
      }
    })
  )
}

function titleBarColors(): { color: string; symbolColor: string; height: number } {
  const dark = nativeTheme.shouldUseDarkColors
  return { color: '#00000000', symbolColor: dark ? '#EEEEEB' : '#141513', height: TITLE_BAR_HEIGHT }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1024,
    height: 680,
    minWidth: 900,
    minHeight: 600,
    title: 'Inkstone Minecraft',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#131314' : '#ECEDE9',
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarColors(),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  return win
}

function applyTheme(settings: LauncherSettings): LauncherSettings {
  closeToTray = settings.closeToTray
  if (nativeTheme.themeSource !== settings.theme) nativeTheme.themeSource = settings.theme
  return settings
}

/** 16×16 的草方块侧面，按像素坐标哈希出噪点，放大到 32 给高分屏 */
function trayIcon(): Electron.NativeImage {
  const size = 32
  const pixels = Buffer.alloc(size * size * 4)
  const hash = (x: number, y: number) => {
    let h = (x * 374761393 + y * 668265263) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const n = hash(x, y)
      const drip = y < 4 || (y < 6 && hash(x, 99) > 0.55) || (y === 6 && hash(x, 98) > 0.8)
      const [r, g, b] = drip ? [n > 0.6 ? 0x7c : 0x5d, n > 0.6 ? 0xbd : 0x9c, n > 0.6 ? 0x4a : 0x34] : n > 0.75 ? [0x96, 0x6c, 0x4a] : n > 0.3 ? [0x79, 0x55, 0x3a] : [0x59, 0x3d, 0x29]
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const at = ((y * 2 + dy) * size + x * 2 + dx) * 4
          pixels[at] = b
          pixels[at + 1] = g
          pixels[at + 2] = r
          pixels[at + 3] = 255
        }
      }
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 })
}

function showWindow(): void {
  if (!window || window.isDestroyed()) {
    window = createWindow()
    watchWindow(window)
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function quit(): void {
  quitting = true
  app.quit()
}

function createTray(): void {
  tray = new Tray(trayIcon())
  tray.setToolTip('Inkstone Minecraft')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 Inkstone', click: showWindow },
      { type: 'separator' },
      { label: '退出启动器（游戏不受影响）', click: quit }
    ])
  )
  tray.on('click', showWindow)
}

function watchWindow(win: BrowserWindow): void {
  win.on('close', (event) => {
    if (quitting || !closeToTray) return
    event.preventDefault()
    win.hide()
    if (!trayHinted && tray && process.platform === 'win32') {
      trayHinted = true
      tray.displayBalloon({ title: 'Inkstone 还在托盘里', content: '游戏照常运行。右键托盘图标可以退出启动器。', iconType: 'none', noSound: true })
    }
  })
  win.on('closed', () => {
    if (window === win) window = null
  })
}

function broadcast(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
}

function registerIpc(): void {
  ipcMain.handle(CRAFT_CHANNELS.settings, () => service.settings())
  ipcMain.handle(CRAFT_CHANNELS.updateSettings, async (_event, patch: Partial<LauncherSettings>) => applyTheme(await service.updateSettings(patch ?? {})))
  ipcMain.handle(CRAFT_CHANNELS.instances, (_event, folder: string) => service.instances(String(folder ?? '')))
  ipcMain.handle(CRAFT_CHANNELS.installVersions, () => service.minecraftVersions())
  ipcMain.handle(CRAFT_CHANNELS.installLoaders, (_event, kind: unknown, minecraft: unknown) => {
    if (kind !== 'fabric' && kind !== 'quilt' && kind !== 'forge' && kind !== 'neoforge') throw new Error('不支持的加载器')
    return service.loaderVersions(kind, requiredText(minecraft, ' Minecraft 版本'))
  })
  ipcMain.handle(CRAFT_CHANNELS.installStart, (_event, request: unknown) => service.install(installRequestArg(request)))
  ipcMain.handle(CRAFT_CHANNELS.repair, (_event, folder: unknown, versionId: unknown) => service.repair(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名')))
  service.on('instances-changed', (folder: string) => broadcast(CRAFT_CHANNELS.instancesChanged, folder))
  ipcMain.handle(CRAFT_CHANNELS.javas, () => service.javas())
  ipcMain.handle(CRAFT_CHANNELS.pickJava, async () => {
    const options = {
      title: '选择 Java 可执行文件',
      properties: ['openFile' as const],
      filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : undefined
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(CRAFT_CHANNELS.probeDownloadSources, probeDownloadSources)
  ipcMain.handle(CRAFT_CHANNELS.updateStatus, () => updateStatus())
  ipcMain.handle(CRAFT_CHANNELS.updateCheck, () => checkForUpdate())
  ipcMain.handle(CRAFT_CHANNELS.updateInstall, () => {
    quitting = true
    installUpdate()
  })
  ipcMain.handle(CRAFT_CHANNELS.systemMemory, () => ({ totalMb: Math.round(totalmem() / 1048576), freeMb: Math.round(freemem() / 1048576) }))
  ipcMain.handle(CRAFT_CHANNELS.performance, (_event, folder, versionId) => service.performance(folder, versionId))
  ipcMain.handle(CRAFT_CHANNELS.applyPerformance, (_event, folder, versionId) => service.applyPerformance(folder, versionId))
  ipcMain.handle(CRAFT_CHANNELS.restorePerformance, (_event, folder, versionId) => service.restorePerformance(folder, versionId))
  ipcMain.handle(CRAFT_CHANNELS.pclSnapshot, () => service.pclSnapshot())
  ipcMain.handle(CRAFT_CHANNELS.importPcl, () => service.importPcl())
  ipcMain.handle(CRAFT_CHANNELS.microsoftBegin, () => service.microsoftBegin())
  ipcMain.handle(CRAFT_CHANNELS.microsoftFinish, (_event, id: unknown) => service.microsoftFinish(requiredText(id, '登录会话')))
  ipcMain.handle(CRAFT_CHANNELS.microsoftCancel, (_event, id: unknown) => service.microsoftCancel(requiredText(id, '登录会话')))
  ipcMain.handle(CRAFT_CHANNELS.addOfflineAccount, (_event, name: string) => service.addOfflineAccount(String(name ?? '')))
  ipcMain.handle(CRAFT_CHANNELS.removeAccount, (_event, id: string) => service.removeAccount(String(id ?? '')))
  ipcMain.handle(CRAFT_CHANNELS.selectAccount, (_event, id: string) => service.selectAccount(String(id ?? '')))
  ipcMain.handle(CRAFT_CHANNELS.skin, (_event, id: string) => service.skin(String(id ?? '')))
  ipcMain.handle(CRAFT_CHANNELS.instanceIcon, (_event, folder: string, versionId: string) => service.instanceIcon(String(folder ?? ''), String(versionId ?? '')))
  ipcMain.handle(CRAFT_CHANNELS.openFolder, async (_event, folder: string, versionId: string, target: FolderTarget) => {
    if (!FOLDER_TARGETS.includes(target)) throw new Error('不支持的目录')
    const path = await service.folderPath(String(folder ?? ''), String(versionId ?? ''), target)
    if (!existsSync(path)) return null
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
    return path
  })
  ipcMain.handle(CRAFT_CHANNELS.tasks, () => service.tasks.list())
  ipcMain.handle(CRAFT_CHANNELS.cancelTask, (_event, id: string) => service.tasks.cancel(String(id ?? '')))
  ipcMain.handle(CRAFT_CHANNELS.clearFinishedTasks, () => service.tasks.clearFinished())
  service.tasks.on('task', (task: TaskInfo) => broadcast(CRAFT_CHANNELS.taskEvent, task))
  ipcMain.handle(CRAFT_CHANNELS.pickSkin, async (_event, id: unknown) => {
    const accountId = requiredText(id, '账号')
    const options = { title: '选择皮肤图片', properties: ['openFile' as const], filters: [{ name: '皮肤 PNG', extensions: ['png'] }] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    const path = result.canceled ? null : result.filePaths[0]
    if (!path) return null
    return service.setSkin(accountId, await readFile(path))
  })
  ipcMain.handle(CRAFT_CHANNELS.pickFolder, async () => {
    const options = { title: '选择 .minecraft 游戏目录', properties: ['openDirectory' as const] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(CRAFT_CHANNELS.launch, (_event, request: LaunchRequest) => service.launch(request))
  ipcMain.handle(CRAFT_CHANNELS.stop, () => service.stop())
  ipcMain.handle(CRAFT_CHANNELS.status, () => service.status())
  ipcMain.handle(CRAFT_CHANNELS.logs, () => service.logs())
  let logBatch: LogLine[] = []
  let logTimer: ReturnType<typeof setTimeout> | null = null
  const flushLogs = (): void => {
    if (logTimer) clearTimeout(logTimer)
    logTimer = null
    if (logBatch.length) broadcast(CRAFT_CHANNELS.logEvent, logBatch.splice(0))
  }
  service.on('log', (line: LogLine) => {
    logBatch.push(line)
    if (logBatch.length >= 100) flushLogs()
    else logTimer ??= setTimeout(flushLogs, 50)
  })
  service.on('status', (status: LaunchStatus) => broadcast(CRAFT_CHANNELS.statusEvent, status))
  ipcMain.handle(CRAFT_CHANNELS.preflight, (_event, request: unknown) => service.preflight(preflightRequestArg(request)))
  ipcMain.handle(CRAFT_CHANNELS.launchJava, (_event, folder: unknown, versionId: unknown, javaPath: unknown) =>
    service.setLaunchJava(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), typeof javaPath === 'string' && javaPath.trim() ? javaPath.trim() : null)
  )
  ipcMain.handle(CRAFT_CHANNELS.crashLatest, (_event, folder: unknown, versionId: unknown) => service.crashLatest(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名')))
  ipcMain.handle(CRAFT_CHANNELS.crashList, (_event, folder: unknown, versionId: unknown) => service.crashList(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名')))
  ipcMain.handle(CRAFT_CHANNELS.crashExport, (_event, folder: unknown, versionId: unknown, id: unknown) =>
    service.crashExport(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), requiredText(id, '崩溃记录'))
  )
  ipcMain.handle(CRAFT_CHANNELS.crashAction, (_event, request: unknown) => service.crashAction(crashActionRequestArg(request)))
  service.on('crash', (diagnosis: CrashDiagnosis) => broadcast(CRAFT_CHANNELS.crashEvent, diagnosis))
}

function registerVersionIpc(): void {
  ipcMain.handle(CRAFT_CHANNELS.instanceRename, (_event, folder: unknown, versionId: unknown, nextId: unknown) =>
    service.renameInstance(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), requiredText(nextId, '新版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.instanceCopy, (_event, folder: unknown, versionId: unknown, name: unknown) =>
    service.copyInstance(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), typeof name === 'string' && name.trim() ? name.trim() : null)
  )
  ipcMain.handle(CRAFT_CHANNELS.instanceDelete, (_event, folder: unknown, versionId: unknown) =>
    service.deleteInstance(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.instanceTrash, (_event, folder: unknown) => service.trashedInstances(requiredText(folder, '游戏目录')))
  ipcMain.handle(CRAFT_CHANNELS.instanceRestore, (_event, folder: unknown, id: unknown) =>
    service.restoreInstance(requiredText(folder, '游戏目录'), requiredText(id, '回收站记录'))
  )
  ipcMain.handle(CRAFT_CHANNELS.resourcesList, (_event, folder: unknown, versionId: unknown) =>
    service.versionResources(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.resourcesScreenshots, (_event, folder: unknown, versionId: unknown) =>
    service.versionScreenshots(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.resourcesToggle, (_event, folder: unknown, versionId: unknown, file: unknown, enabled: unknown) =>
    service.resourceToggle(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), requiredText(file, '文件名'), enabled === true)
  )
  ipcMain.handle(CRAFT_CHANNELS.resourcesDelete, (_event, folder: unknown, versionId: unknown, kind: unknown, file: unknown) => {
    const value: ResourceKind = kind === 'shaderpacks' ? 'shaderpacks' : kind === 'saves' ? 'saves' : 'resourcepacks'
    return service.resourceDelete(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), value, requiredText(file, '文件名'))
  })
  ipcMain.handle(CRAFT_CHANNELS.instanceIconOptions, (_event, folder: unknown, versionId: unknown) =>
    service.instanceIconOptions(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.instanceIconSet, (_event, folder: unknown, versionId: unknown, kind: unknown, ref: unknown) => {
    const value = kind === 'mod' || kind === 'save' || kind === 'server' || kind === 'file' ? kind : 'file'
    return service.setInstanceIcon(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), value, typeof ref === 'string' && ref.trim() ? ref.trim() : null)
  })
  ipcMain.handle(CRAFT_CHANNELS.instanceIconClear, (_event, folder: unknown, versionId: unknown) =>
    service.clearInstanceIcon(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.pickImage, async () => {
    const options = { title: '选择实例图标', properties: ['openFile' as const], filters: [{ name: 'PNG 图片', extensions: ['png'] }] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(CRAFT_CHANNELS.crashGet, (_event, folder: unknown, versionId: unknown, id: unknown) =>
    service.crashGet(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), requiredText(id, '崩溃记录'))
  )
}

function preflightRequestArg(value: unknown): PreflightRequest {
  const raw = recordArg(value)
  const request: PreflightRequest = { folder: requiredText(raw.folder, '游戏目录'), versionId: requiredText(raw.versionId, '版本名') }
  if (typeof raw.javaPath === 'string' && raw.javaPath.trim()) request.javaPath = raw.javaPath.trim()
  if (typeof raw.maxMemoryMb === 'number' && Number.isFinite(raw.maxMemoryMb) && raw.maxMemoryMb > 0) request.maxMemoryMb = Math.round(raw.maxMemoryMb)
  return request
}

function crashActionRequestArg(value: unknown): CrashActionRequest {
  const raw = recordArg(value)
  const kinds: CrashActionRequest['kind'][] = ['install-deps', 'disable-mod', 'java', 'memory', 'mods', 'repair', 'export']
  const kind = kinds.find((item) => item === raw.kind)
  if (!kind) throw new Error('不支持的处理动作')
  return {
    folder: requiredText(raw.folder, '游戏目录'),
    versionId: requiredText(raw.versionId, '版本名'),
    diagnosisId: requiredText(raw.diagnosisId, '崩溃记录'),
    kind,
    value: typeof raw.value === 'string' && raw.value.trim() ? raw.value.trim() : null
  }
}

function registerModsIpc(): void {
  const subscriptions = new Map<number, Map<string, () => void>>()
  ipcMain.on(CRAFT_CHANNELS.modsWatch, (event, rawId: unknown, folder: unknown, versionId: unknown) => {
    const sender = event.sender
    if (typeof rawId !== 'string' || rawId.length > 80 || typeof folder !== 'string' || typeof versionId !== 'string') return
    let owned = subscriptions.get(sender.id)
    if (!owned) {
      owned = new Map()
      subscriptions.set(sender.id, owned)
      const cleanup = (): void => { for (const stop of owned!.values()) stop(); owned!.clear() }
      sender.on('did-start-loading', cleanup)
      sender.once('destroyed', () => { cleanup(); subscriptions.delete(sender.id); service.microsoftCancel() })
    }
    owned.get(rawId)?.()
    if (owned.size >= 8) return
    let cancelled = false
    let stop: (() => void) | undefined
    owned.set(rawId, () => { cancelled = true; stop?.() })
    void service.folderPath(folder, versionId, 'mods').then((directory) => {
      if (cancelled || sender.isDestroyed()) return
      stop = watchMods(directory, () => { if (!sender.isDestroyed()) sender.send(CRAFT_CHANNELS.modsChanged, rawId) })
      sender.send(CRAFT_CHANNELS.modsChanged, rawId)
    }).catch(() => { owned!.get(rawId)?.(); owned!.delete(rawId) })
  })
  ipcMain.on(CRAFT_CHANNELS.modsUnwatch, (event, id: string) => {
    const owned = subscriptions.get(event.sender.id)
    owned?.get(id)?.()
    owned?.delete(id)
  })
  ipcMain.handle(CRAFT_CHANNELS.instanceOverview, (_event, folder: unknown, versionId: unknown) =>
    service.instanceOverview(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.instanceSettingsUpdate, (_event, folder: unknown, versionId: unknown, patch: unknown) =>
    service.updateInstanceSettings(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), recordArg(patch) as Partial<InstanceOverride>)
  )
  ipcMain.handle(CRAFT_CHANNELS.modsList, (_event, folder: unknown, versionId: unknown) => service.modList(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名')))
  ipcMain.handle(CRAFT_CHANNELS.modsToggle, (_event, folder: unknown, versionId: unknown, file: unknown, enabled: unknown) =>
    service.modToggle(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), requiredText(file, '文件名'), enabled === true)
  )
  ipcMain.handle(CRAFT_CHANNELS.modsRemove, (_event, folder: unknown, versionId: unknown, file: unknown) =>
    service.modRemove(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), requiredText(file, '文件名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.modsToggleMany, (_event, folder: unknown, versionId: unknown, files: unknown, enabled: unknown) =>
    service.modToggleMany(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), textList(files), enabled === true)
  )
  ipcMain.handle(CRAFT_CHANNELS.modsRemoveMany, (_event, folder: unknown, versionId: unknown, files: unknown) =>
    service.modRemoveMany(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), textList(files))
  )
  ipcMain.handle(CRAFT_CHANNELS.modsInstallDeps, (_event, folder: unknown, versionId: unknown, modIds: unknown) =>
    service.modInstallDeps(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), textList(modIds))
  )
  ipcMain.handle(CRAFT_CHANNELS.modsRestore, (_event, folder: unknown, versionId: unknown, id: unknown) =>
    service.modRestore(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), requiredText(id, '回收站记录'))
  )
  ipcMain.handle(CRAFT_CHANNELS.modsCheckUpdates, (_event, folder: unknown, versionId: unknown) =>
    service.modCheckUpdates(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.modsUpdate, (_event, request: unknown) => service.modUpdate(modUpdateRequestArg(request)))
  ipcMain.handle(CRAFT_CHANNELS.modsInstall, (_event, request: unknown) => {
    const raw = recordArg(request)
    return service.modInstall({
      folder: requiredText(raw.folder, '游戏目录'),
      versionId: requiredText(raw.versionId, '版本名'),
      versionFileId: requiredText(raw.versionFileId, 'Modrinth 版本')
    })
  })
  ipcMain.handle(CRAFT_CHANNELS.modsAddFiles, (_event, folder: unknown, versionId: unknown, paths: unknown) =>
    service.modAddFiles(
      requiredText(folder, '游戏目录'),
      requiredText(versionId, '版本名'),
      Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : []
    )
  )
  ipcMain.handle(CRAFT_CHANNELS.modsSearch, (_event, query: unknown) => {
    const raw = recordArg(query)
    const sort = raw.sort === 'downloads' || raw.sort === 'updated' || raw.sort === 'newest' ? raw.sort : 'relevance'
    return service.modSearch({
      query: typeof raw.query === 'string' ? raw.query : '',
      loader: typeof raw.loader === 'string' && raw.loader.trim() ? raw.loader.trim() : null,
      minecraft: typeof raw.minecraft === 'string' && raw.minecraft.trim() ? raw.minecraft.trim() : null,
      sort,
      limit: Number.isFinite(Number(raw.limit)) ? Math.min(Math.max(Math.round(Number(raw.limit)), 1), 50) : 20,
      offset: Number.isFinite(Number(raw.offset)) ? Math.max(Math.round(Number(raw.offset)), 0) : 0
    } satisfies ModrinthSearchQuery)
  })
  ipcMain.handle(CRAFT_CHANNELS.modsVersions, (_event, projectId: unknown, loader: unknown, minecraft: unknown) =>
    service.modVersions(
      requiredText(projectId, 'Modrinth 项目'),
      typeof loader === 'string' && loader.trim() ? loader.trim() : null,
      typeof minecraft === 'string' && minecraft.trim() ? minecraft.trim() : null
    )
  )
  ipcMain.handle(CRAFT_CHANNELS.modsProject, (_event, projectId: unknown) => service.modProject(requiredText(projectId, 'Modrinth 项目')))
  ipcMain.handle(CRAFT_CHANNELS.pickModFiles, async () => {
    const options = {
      title: '选择 Mod 文件',
      properties: ['openFile' as const, 'multiSelections' as const],
      filters: [{ name: 'Mod', extensions: ['jar'] }]
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle(CRAFT_CHANNELS.openUrl, async (_event, url: unknown) => {
    const target = typeof url === 'string' ? url.trim() : ''
    if (!/^https:\/\//.test(target)) throw new Error('只能打开 https 链接')
    await shell.openExternal(target)
  })
}

function registerDownloadIpc(): void {
  ipcMain.handle(CRAFT_CHANNELS.downloadCategories, (_event, projectType: unknown) => service.downloadCategories(typeof projectType === 'string' ? projectType : 'mod'))
  ipcMain.handle(CRAFT_CHANNELS.downloadSearch, (_event, query: unknown) => {
    const raw = recordArg(query)
    const sort = raw.sort === 'downloads' || raw.sort === 'updated' || raw.sort === 'newest' ? raw.sort : 'relevance'
    const projectType = raw.projectType === 'resourcepack' ? 'resourcepack' : raw.projectType === 'shader' ? 'shader' : raw.projectType === 'modpack' ? 'modpack' : 'mod'
    return service.downloadSearch({
      projectType,
      query: typeof raw.query === 'string' ? raw.query : '',
      category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : null,
      loader: typeof raw.loader === 'string' && raw.loader.trim() ? raw.loader.trim() : null,
      minecraft: typeof raw.minecraft === 'string' && raw.minecraft.trim() ? raw.minecraft.trim() : null,
      sort,
      limit: Number.isFinite(Number(raw.limit)) ? Math.min(Math.max(Math.round(Number(raw.limit)), 1), 50) : 20,
      offset: Number.isFinite(Number(raw.offset)) ? Math.max(Math.round(Number(raw.offset)), 0) : 0
    } satisfies ContentSearchQuery)
  })
  ipcMain.handle(CRAFT_CHANNELS.downloadVersions, (_event, projectId: unknown, loader: unknown, minecraft: unknown) =>
    service.downloadVersions(
      requiredText(projectId, 'Modrinth 项目'),
      typeof loader === 'string' && loader.trim() ? loader.trim() : null,
      typeof minecraft === 'string' && minecraft.trim() ? minecraft.trim() : null
    )
  )
  ipcMain.handle(CRAFT_CHANNELS.downloadInstall, (_event, request: unknown) => {
    const raw = recordArg(request)
    return service.downloadInstall({
      folder: requiredText(raw.folder, '游戏目录'),
      versionId: requiredText(raw.versionId, '版本名'),
      projectType: raw.projectType === 'shader' ? 'shader' : 'resourcepack',
      versionFileId: requiredText(raw.versionFileId, 'Modrinth 版本')
    })
  })
  ipcMain.handle(CRAFT_CHANNELS.pickModpack, async () => {
    const options = {
      title: '选择 Modrinth 整合包',
      properties: ['openFile' as const],
      filters: [{ name: 'Modrinth 整合包', extensions: ['mrpack'] }]
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(CRAFT_CHANNELS.inspectModpack, (_event, path: unknown) => service.inspectModpack(requiredText(path, '整合包路径')))
  ipcMain.handle(CRAFT_CHANNELS.importModpack, (_event, request: unknown) => {
    const raw = recordArg(request)
    return service.importModpack({
      folder: requiredText(raw.folder, '游戏目录'),
      path: requiredText(raw.path, '整合包路径'),
      ...(typeof raw.name === 'string' && raw.name.trim() ? { name: raw.name.trim() } : {})
    })
  })
}

function modUpdateRequestArg(value: unknown) {
  const raw = recordArg(value)
  const updates = Array.isArray(raw.updates) ? (raw.updates.filter((item) => !!item && typeof item === 'object') as ModUpdateInfo[]) : []
  return { folder: requiredText(raw.folder, '游戏目录'), versionId: requiredText(raw.versionId, '版本名'), updates }
}

function recordArg(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : []
}

function requiredText(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`缺少${label}`)
  return text
}

function installRequestArg(value: unknown): InstallRequest {
  const raw = recordArg(value)
  const kind = raw.kind === 'vanilla' || raw.kind === 'fabric' || raw.kind === 'quilt' || raw.kind === 'forge' || raw.kind === 'neoforge' ? raw.kind : null
  if (!kind) throw new Error('这个加载器还不支持安装')
  const request: InstallRequest = {
    folder: requiredText(raw.folder, '游戏目录'),
    kind,
    minecraft: requiredText(raw.minecraft, ' Minecraft 版本')
  }
  if (typeof raw.loader === 'string' && raw.loader.trim()) request.loader = raw.loader.trim()
  if (typeof raw.name === 'string' && raw.name.trim()) request.name = raw.name.trim()
  if (raw.companions === false) request.companions = false
  return request
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.yudatoux.inkstone.minecraft')
    registerIpc()
    registerModsIpc()
    registerDownloadIpc()
    registerVersionIpc()
    applyTheme(await service.settings())
    window = createWindow()
    watchWindow(window)
    createTray()
    startUpdater((status) => broadcast(CRAFT_CHANNELS.updateEvent, status))
    nativeTheme.on('updated', () => {
      if (!window || window.isDestroyed()) return
      window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#151515' : '#FCFCFB')
      if (process.platform !== 'darwin') window.setTitleBarOverlay(titleBarColors())
    })
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    quitting = true
    tray?.destroy()
    service.dispose()
  })
}
