import { copyFile, mkdir, rename, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  ModBatchResult,
  ModInstallResult,
  ModListResult,
  ModrinthProject,
  ModrinthSearchQuery,
  ModrinthSearchResult,
  ModrinthVersion,
  ModUpdateCheckResult,
  ModUpdateInfo,
  ModUpdateResult
} from '../../shared/mods-api.ts'
import type { TaskProgress } from '../../shared/api.ts'
import { commitModDownloads, type ModDownload } from './transaction.ts'
import { analyzeMods, countIssues } from './analyze.ts'
import { collectDependencyNeeds, installDependencyNeeds, missingDependencyIds, type DependencyInstallOutcome } from './deps.ts'
import { ModrinthClient } from './modrinth.ts'
import { modsDir, readModEntries, scanModFiles, type HashCache } from './scan.ts'
import { ModStore } from './store.ts'
import { listTrash, moveToTrash, purgeTrash, restoreFromTrash } from './trash.ts'

export interface InstanceContext {
  folder: string
  versionId: string
  gameDir: string
  loader: string
  minecraftVersion: string | null
}

export interface ModsManagerOptions {
  dataDir: string
  fetchImpl?: typeof fetch
  apiBase?: string
  client?: ModrinthClient
}

export interface ModWorkOptions {
  signal?: AbortSignal
  onProgress?(progress: TaskProgress, detail?: string): void
}

function contextKey(ctx: InstanceContext): string {
  return `${ctx.gameDir.toLowerCase()}|${ctx.versionId}`
}

export class ModsManager {
  readonly store: ModStore
  readonly client: ModrinthClient
  private readonly hashCache: HashCache = new Map()
  private readonly updates = new Map<string, ModUpdateInfo>()
  private readonly fetchImpl: typeof fetch | undefined

  constructor(options: ModsManagerOptions) {
    this.store = new ModStore(options.dataDir)
    this.fetchImpl = options.fetchImpl
    this.client =
      options.client ??
      new ModrinthClient({
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.apiBase ? { apiBase: options.apiBase } : {})
      })
  }

  private updateKey(ctx: InstanceContext, sha1: string): string {
    return `${contextKey(ctx)}|${sha1.toLowerCase()}`
  }

  private updatesFor(ctx: InstanceContext): ModUpdateInfo[] {
    return [...this.updates.entries()].filter(([key]) => key.startsWith(`${contextKey(ctx)}|`)).map(([, value]) => value)
  }

  async list(ctx: InstanceContext): Promise<ModListResult> {
    const mods = await readModEntries({ gameDir: ctx.gameDir, store: this.store, hashCache: this.hashCache })
    analyzeMods(mods, { loader: ctx.loader, minecraftVersion: ctx.minecraftVersion })
    const updates = this.updatesFor(ctx)
    return {
      versionId: ctx.versionId,
      gameDir: ctx.gameDir,
      loader: ctx.loader,
      minecraftVersion: ctx.minecraftVersion,
      mods,
      counts: {
        total: mods.length,
        enabled: mods.filter((mod) => mod.enabled).length,
        disabled: mods.filter((mod) => !mod.enabled).length,
        updates: updates.length,
        issues: countIssues(mods)
      },
      trash: await listTrash(ctx.gameDir)
    }
  }

  async toggle(ctx: InstanceContext, file: string, enabled: boolean): Promise<ModListResult> {
    await this.applyToggle(ctx, file, enabled)
    return this.list(ctx)
  }

  private async applyToggle(ctx: InstanceContext, file: string, enabled: boolean): Promise<void> {
    const target = await this.targetPath(ctx, file)
    const info = await stat(target).catch(() => null)
    if (!info?.isFile()) throw new Error('找不到这个 Mod 文件')
    const disabled = file.toLowerCase().endsWith('.disabled')
    if (enabled === !disabled) return
    const nextName = enabled ? file.slice(0, -'.disabled'.length) : `${file}.disabled`
    const next = join(modsDir(ctx.gameDir), nextName)
    const conflict = await stat(next).catch(() => null)
    if (conflict) throw new Error(`已经有 ${nextName}，先处理重复文件`)
    await rename(target, next)
  }

  async toggleMany(ctx: InstanceContext, files: string[], enabled: boolean): Promise<ModBatchResult> {
    const done: string[] = []
    const failed: Array<{ file: string; reason: string }> = []
    for (const file of files) {
      try {
        await this.applyToggle(ctx, file, enabled)
        done.push(file)
      } catch (error) {
        failed.push({ file, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return { list: await this.list(ctx), done, failed }
  }

  private async targetPath(ctx: InstanceContext, file: string): Promise<string> {
    if (!file || basename(file) !== file || /[\\/]/.test(file)) throw new Error('文件名不合法')
    return join(modsDir(ctx.gameDir), file)
  }

  async remove(ctx: InstanceContext, file: string): Promise<ModListResult> {
    await this.applyRemove(ctx, file)
    return this.list(ctx)
  }

  private async applyRemove(ctx: InstanceContext, file: string): Promise<void> {
    const info = await stat(await this.targetPath(ctx, file)).catch(() => null)
    if (!info?.isFile()) throw new Error('找不到这个 Mod 文件')
    await moveToTrash(ctx.gameDir, ctx.versionId, file)
  }

  async removeMany(ctx: InstanceContext, files: string[]): Promise<ModBatchResult> {
    const done: string[] = []
    const failed: Array<{ file: string; reason: string }> = []
    for (const file of files) {
      try {
        await this.applyRemove(ctx, file)
        done.push(file)
      } catch (error) {
        failed.push({ file, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return { list: await this.list(ctx), done, failed }
  }

  async installDependencies(ctx: InstanceContext, modIds: string[], options: ModWorkOptions = {}): Promise<DependencyInstallOutcome> {
    const listed = await this.list(ctx)
    const ids = modIds.length > 0 ? modIds : missingDependencyIds(listed.mods)
    if (ids.length === 0) return { installed: [], skipped: [], failed: [], picks: [] }
    const needs = collectDependencyNeeds(listed.mods, ids)
    return installDependencyNeeds(
      needs,
      { modsDir: modsDir(ctx.gameDir), loader: ctx.loader, minecraftVersion: ctx.minecraftVersion },
      {
        client: this.client,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {})
      }
    )
  }

  async restore(ctx: InstanceContext, id: string): Promise<ModListResult> {
    await restoreFromTrash(ctx.gameDir, id)
    return this.list(ctx)
  }

  async purge(ctx: InstanceContext, id: string): Promise<ModListResult> {
    await purgeTrash(ctx.gameDir, id)
    return this.list(ctx)
  }

  async checkUpdates(ctx: InstanceContext, options: ModWorkOptions = {}): Promise<ModUpdateCheckResult> {
    const files = await scanModFiles(ctx.gameDir, this.hashCache)
    const hashes = [...new Set(files.map((file) => file.sha1))]
    if (hashes.length === 0) return { checkedAt: Date.now(), updates: [], unknown: [], error: null }
    options.onProgress?.({ done: 0, total: 2, unit: 'steps' }, '查询 Modrinth')
    try {
      const known = await this.client.byHashes(hashes)
      for (const [sha1, version] of known) {
        const existing = this.store.modrinthOf(sha1)
        if (existing && existing.projectId === version.projectId && existing.title) continue
        await this.store.rememberModrinth(sha1, { projectId: version.projectId, title: null, iconUrl: existing?.iconUrl ?? null })
      }
      options.onProgress?.({ done: 1, total: 2, unit: 'steps' }, '匹配可更新版本')
      const latest = await this.client.updates(hashes, { loader: ctx.loader, minecraft: ctx.minecraftVersion })
      const updates: ModUpdateInfo[] = []
      for (const [sha1, version] of latest) {
        if (version.file.sha1.toLowerCase() === sha1) continue
        const current = files.find((file) => file.sha1 === sha1)
        if (!current) continue
        const record = this.store.modrinthOf(sha1)
        const info: ModUpdateInfo = {
          sha1,
          file: current.file,
          projectId: version.projectId,
          projectTitle: record?.title ?? null,
          versionId: version.id,
          versionNumber: version.versionNumber,
          fileName: version.file.fileName,
          fileSha1: version.file.sha1,
          fileSize: version.file.size,
          downloadUrl: version.file.url,
          iconUrl: record?.iconUrl ?? null,
          gameVersions: version.gameVersions,
          loaders: version.loaders
        }
        updates.push(info)
        this.updates.set(this.updateKey(ctx, sha1), info)
      }
      const unknown = files.filter((file) => !known.has(file.sha1)).map((file) => file.file)
      options.onProgress?.({ done: 2, total: 2, unit: 'steps' }, '检查完成')
      return { checkedAt: Date.now(), updates, unknown, error: null }
    } catch (error) {
      return { checkedAt: Date.now(), updates: [], unknown: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  async update(ctx: InstanceContext, updates: ModUpdateInfo[], options: ModWorkOptions = {}): Promise<ModUpdateResult> {
    const files = await scanModFiles(ctx.gameDir, this.hashCache)
    const queue = updates.filter((item) => files.some((file) => file.sha1 === item.sha1 && file.enabled))
    const result: ModUpdateResult = { updated: [], skipped: [], trashed: [] }
    if (queue.length === 0) return result
    const dir = modsDir(ctx.gameDir)
    await mkdir(dir, { recursive: true })
    const plan = queue.map((item) => ({ file: item.fileName, url: item.downloadUrl, sha1: item.fileSha1, size: item.fileSize, replaces: [files.find((file) => file.sha1 === item.sha1 && file.enabled)!.file] }))
    await commitModDownloads(ctx.gameDir, ctx.versionId, plan, {
      source: 'official', signal: options.signal, fetchImpl: this.fetchImpl,
      onProgress: (progress) => options.onProgress?.(progress, '下载更新')
    })
    for (const item of queue) {
      result.trashed.push(files.find((file) => file.sha1 === item.sha1 && file.enabled)!.file)
      result.updated.push(item.fileName)
      this.updates.delete(this.updateKey(ctx, item.sha1))
    }
    return result
  }

  search(query: ModrinthSearchQuery): Promise<ModrinthSearchResult> {
    return this.client.search(query)
  }

  versions(projectId: string, filter: { loader?: string | null; minecraft?: string | null } = {}): Promise<ModrinthVersion[]> {
    return this.client.versions(projectId, filter)
  }

  project(projectId: string): Promise<ModrinthProject | null> {
    return this.client.project(projectId)
  }

  private async installedContext(ctx: InstanceContext): Promise<{ files: Awaited<ReturnType<typeof scanModFiles>>; projectIds: Set<string>; versionIds: Set<string>; disabledProjectIds: Set<string>; names: Set<string> }> {
    const files = await scanModFiles(ctx.gameDir, this.hashCache)
    const projectIds = new Set<string>()
    const versionIds = new Set<string>()
    const disabledProjectIds = new Set<string>()
    const known = await this.client.byHashes([...new Set(files.map((file) => file.sha1))]).catch(() => new Map<string, ModrinthVersion>())
    for (const [sha1, version] of known) {
      if (files.some((file) => file.sha1 === sha1 && file.enabled)) { projectIds.add(version.projectId); versionIds.add(version.id) }
      else disabledProjectIds.add(version.projectId)
      const existing = this.store.modrinthOf(sha1)
      if (!existing || existing.projectId !== version.projectId) {
        await this.store.rememberModrinth(sha1, { projectId: version.projectId, title: null, iconUrl: existing?.iconUrl ?? null })
      }
    }
    return { files, projectIds, versionIds, disabledProjectIds, names: new Set(files.map((file) => file.file.toLowerCase())) }
  }

  async install(ctx: InstanceContext, versionFileId: string, options: ModWorkOptions = {}): Promise<ModInstallResult> {
    const version = await this.client.versionById(versionFileId)
    if (!version) throw new Error('Modrinth 上没有这个版本')
    if (!this.usable(version, ctx)) throw new Error('这个文件不适合当前 Minecraft 或加载器版本，请重新选择')
    const project = await this.client.project(version.projectId).catch(() => null)
    const { files, projectIds, versionIds, disabledProjectIds, names } = await this.installedContext(ctx)
    if (disabledProjectIds.has(version.projectId) && !projectIds.has(version.projectId)) throw new Error('这个 Mod 已被停用，请在 Mod 管理中确认是否启用；不会自动重新安装')
    if (projectIds.has(version.projectId) && !versionIds.has(version.id)) throw new Error('已经安装了这个 Mod 的其他版本，请在 Mod 管理中更新或更换，避免重复安装')
    const plan: Array<{ version: ModrinthVersion; kind: 'target' | 'dependency' }> = [{ version, kind: 'target' }]
    const dependencyVersions = await this.resolveDependencies(version, ctx, projectIds, versionIds, disabledProjectIds, options)
    for (const dep of dependencyVersions) plan.push({ version: dep, kind: 'dependency' })
    const dir = modsDir(ctx.gameDir)
    await mkdir(dir, { recursive: true })
    const installed: string[] = []
    const skipped: string[] = []
    const dependencies: string[] = []
    const downloads: ModDownload[] = []
    const staged: Array<{ version: ModrinthVersion; kind: 'target' | 'dependency' }> = []
    for (const item of plan) {
      if (basename(item.version.file.fileName) !== item.version.file.fileName || /[\\/:]/.test(item.version.file.fileName)) throw new Error('下载来源返回了无效的 Mod 文件名')
      if (names.has(item.version.file.fileName.toLowerCase())) {
        if (!files.some((file) => file.file.toLowerCase() === item.version.file.fileName.toLowerCase() && file.sha1 === item.version.file.sha1)) throw new Error(`${item.version.file.fileName} 已有同名但内容不同的文件，请先在 Mod 管理中确认`)
        skipped.push(item.version.file.fileName)
        continue
      }
      downloads.push({ url: item.version.file.url, file: item.version.file.fileName, sha1: item.version.file.sha1, size: item.version.file.size })
      staged.push(item)
    }
    if (downloads.length > 0) {
      await commitModDownloads(ctx.gameDir, ctx.versionId, downloads, {
        source: 'official',
        ...(options.signal ? { signal: options.signal } : {}),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        onProgress: (progress, detail) => options.onProgress?.(progress, detail ?? '下载 Mod')
      })
    }
    for (const item of staged) {
      installed.push(item.version.file.fileName)
      if (item.kind === 'dependency') dependencies.push(item.version.file.fileName)
      await this.store.rememberModrinth(item.version.file.sha1, { projectId: item.version.projectId, title: null, iconUrl: null })
    }
    if (project) {
      for (const sha1 of [version.file.sha1, ...dependencyVersions.map((dep) => dep.file.sha1)]) {
        const record = this.store.modrinthOf(sha1)
        if (record && !record.iconUrl && project.iconUrl) await this.store.rememberModrinth(sha1, { ...record, iconUrl: project.iconUrl })
      }
    }
    return { installed, skipped, dependencies, targetDir: dir }
  }

  private async resolveDependencies(
    version: ModrinthVersion,
    ctx: InstanceContext,
    installedProjectIds: Set<string>,
    installedVersionIds: Set<string>,
    disabledProjectIds: Set<string>,
    options: ModWorkOptions
  ): Promise<ModrinthVersion[]> {
    const chosen: ModrinthVersion[] = []
    const selected = new Map<string, ModrinthVersion>([[version.projectId, version]])
    const visit = async (parent: ModrinthVersion): Promise<void> => {
      options.signal?.throwIfAborted()
      if (selected.size > 100) throw new Error('前置依赖数量异常，已停止安装，请检查整合包说明')
      const required = parent.dependencies.filter((dep) => dep.kind === 'required')
      const ids = required.map((dep) => dep.versionId).filter((id): id is string => !!id)
      const exact = ids.length ? await this.client.versionsByIds(ids) : []
      for (const dep of required) {
        if (dep.projectId && disabledProjectIds.has(dep.projectId) && !installedProjectIds.has(dep.projectId)) throw new Error('必需前置已被停用，请到 Mod 管理中确认是否启用；不会自动重新启用')
        if (dep.versionId && installedVersionIds.has(dep.versionId)) continue
        if (dep.projectId && installedProjectIds.has(dep.projectId)) {
          if (dep.versionId) throw new Error('已安装的前置版本不符合指定要求，请到 Mod 管理中更新；已保留原文件')
          continue
        }
        const existing = dep.projectId ? selected.get(dep.projectId) : undefined
        if (existing) {
          if (dep.versionId && existing.id !== dep.versionId) throw new Error(`不同 Mod 要求 ${existing.name} 的不同版本，请先解决依赖冲突`)
          continue
        }
        let picked = dep.versionId ? exact.find((item) => item.id === dep.versionId) : undefined
        if (dep.versionId && !picked) throw new Error(`找不到指定的前置版本 ${dep.versionId}，已停止安装`)
        if (!picked && dep.projectId) picked = (await this.client.versions(dep.projectId, { loader: ctx.loader, minecraft: ctx.minecraftVersion })).filter((item) => this.usable(item, ctx)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]
        if (!picked || !this.usable(picked, ctx)) throw new Error(`必需前置 ${dep.projectId ?? dep.fileName ?? '未知'} 没有适合当前游戏或加载器的版本，已停止安装`)
        const previous = selected.get(picked.projectId)
        if (previous) {
          if (previous.id !== picked.id) throw new Error(`前置 ${picked.name} 存在版本冲突，已停止安装`)
          continue
        }
        selected.set(picked.projectId, picked)
        chosen.push(picked)
        options.onProgress?.({ done: chosen.length, total: chosen.length + 1, unit: 'steps' }, '检查前置 Mod')
        await visit(picked)
      }
    }
    await visit(version)
    return chosen
  }

  private usable(version: ModrinthVersion, ctx: InstanceContext): boolean {
    if (version.loaders.length > 0 && ctx.loader !== 'vanilla' && !version.loaders.includes(ctx.loader) && !(ctx.loader === 'quilt' && version.loaders.includes('fabric'))) return false
    if (ctx.minecraftVersion && version.gameVersions.length > 0 && !version.gameVersions.includes(ctx.minecraftVersion)) return false
    return true
  }

  async addFiles(ctx: InstanceContext, paths: string[]): Promise<string[]> {
    const dir = modsDir(ctx.gameDir)
    await mkdir(dir, { recursive: true })
    const existing = new Set((await scanModFiles(ctx.gameDir, this.hashCache)).map((file) => file.file.toLowerCase()))
    const copied: string[] = []
    for (const path of paths) {
      const name = basename(path)
      if (!name.toLowerCase().endsWith('.jar')) continue
      if (existing.has(name.toLowerCase())) continue
      await copyFile(path, join(dir, name))
      copied.push(name)
    }
    return copied
  }
}
