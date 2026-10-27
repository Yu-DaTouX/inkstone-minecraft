import { constants, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { copyFile, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ModEntry, ModrinthVersion } from '../../shared/mods-api.ts'
import type { TaskProgress } from '../../shared/api.ts'
import { downloadFiles } from '../download/download.ts'
import { compareVersions, matchesVersionRange } from './mc-range.ts'
import type { ModrinthClient } from './modrinth.ts'
import { readJarMod } from './metadata.ts'
import { sha1Of } from './scan.ts'
import { moveToTrash, restoreFromTrash } from './trash.ts'

const PLATFORM_IDS = new Set([
  'minecraft',
  'java',
  'fabricloader',
  'fabric-loader',
  'fabric_loader',
  'quilt_loader',
  'quilt-loader',
  'forge',
  'neoforge',
  'modloader',
  'javafml',
  'lowcodefml'
])

export interface DependencyNeed {
  modId: string
  ranges: string[]
  requiredBy: string[]
}

export interface DependencyPick {
  need: DependencyNeed
  version: ModrinthVersion | null
  reason: string | null
}

export interface DependencyInstallContext {
  modsDir: string
  loader: string
  minecraftVersion: string | null
}

export interface DependencyInstallOptions {
  client: ModrinthClient
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  onProgress?(progress: TaskProgress, detail?: string): void
}

export interface DependencyInstallOutcome {
  installed: string[]
  skipped: string[]
  failed: Array<{ modId: string; reason: string }>
  picks: DependencyPick[]
}

export function normaliseRange(range: string | null | undefined): string | null {
  const text = String(range ?? '').trim()
  if (!text || text === '*' || text === 'any' || text === 'x') return null
  return text
}

export function collectDependencyNeeds(mods: ModEntry[], modIds: string[]): DependencyNeed[] {
  const wanted = new Set(modIds.map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0 && !PLATFORM_IDS.has(id)))
  const needs = new Map<string, DependencyNeed>()
  const ensure = (modId: string): DependencyNeed => {
    const existing = needs.get(modId)
    if (existing) return existing
    const created: DependencyNeed = { modId, ranges: [], requiredBy: [] }
    needs.set(modId, created)
    return created
  }
  for (const id of wanted) ensure(id)
  for (const mod of mods) {
    if (!mod.enabled) continue
    for (const dep of mod.dependencies) {
      const id = dep.modId.toLowerCase()
      if (!wanted.has(id) || !dep.required || dep.kind === 'breaks') continue
      const need = ensure(id)
      const range = normaliseRange(dep.versionRange)
      if (range && !need.ranges.includes(range)) need.ranges.push(range)
      if (!need.requiredBy.includes(mod.name)) need.requiredBy.push(mod.name)
    }
  }
  return [...needs.values()]
}

export function missingDependencyIds(mods: ModEntry[]): string[] {
  const ids = new Set<string>()
  for (const mod of mods) {
    for (const issue of mod.issues) {
      if (issue.kind !== 'missing-dependency' && issue.kind !== 'dependency-version') continue
      const id = (issue.modId ?? '').trim().toLowerCase()
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

export function dependencyVersionLabel(version: ModrinthVersion): string {
  const raw = version.versionNumber.trim()
  const match = /^(?:mc)?(\d+\.\d+(?:\.\d+)?)-(.+)$/i.exec(raw)
  if (!match) return raw
  const [, prefix, rest] = match
  if (!prefix || !rest) return raw
  if (!version.gameVersions.some((game) => game === prefix || game.startsWith(`${prefix}.`))) return raw
  return rest
}

function numericVersion(label: string): string {
  const match = /^\d+(?:\.\d+)*/.exec(label)
  return match ? match[0] : label
}

function rangeMatches(range: string, label: string): boolean {
  if (matchesVersionRange(range, label)) return true
  const numeric = numericVersion(label)
  return numeric !== label && matchesVersionRange(range, numeric)
}

export function pickVersionForRange(versions: ModrinthVersion[], range: string | null | undefined): { version: ModrinthVersion | null; reason: string | null } {
  return pickVersionForRanges(versions, range ? [range] : [])
}

export function pickVersionForRanges(versions: ModrinthVersion[], ranges: string[]): { version: ModrinthVersion | null; reason: string | null } {
  const sorted = [...versions].sort(
    (a, b) => compareVersions(dependencyVersionLabel(b), dependencyVersionLabel(a)) || (b.publishedAt > a.publishedAt ? 1 : -1)
  )
  if (sorted.length === 0) return { version: null, reason: 'Modrinth 上没有适合本加载器和游戏版本的文件' }
  const wanted = [...new Set(ranges.map(normaliseRange).filter((item): item is string => !!item))]
  if (wanted.length === 0) return { version: sorted[0], reason: null }
  const hit = sorted.find((version) => wanted.every((range) => rangeMatches(range, dependencyVersionLabel(version))))
  if (hit) return { version: hit, reason: null }
  return { version: null, reason: `需要 ${wanted.join(' 且 ')}（须同时满足），Modrinth 上的 ${sorted.length} 个版本都不符合；请调整提出这些要求的 Mod 版本` }
}

const FABRIC_FAMILY_LOADERS = ['quilt', 'fabric']

export function loaderTags(loader: string): string[] {
  return loader === 'quilt' ? [...FABRIC_FAMILY_LOADERS] : [loader]
}

export function spacedQueries(modId: string): string[] {
  const text = modId.trim()
  if (!/^[a-z0-9]+$/.test(text) || text.length < 6) return []
  const out: string[] = []
  for (let index = text.length - 1; index > 1; index -= 1) {
    const variant = `${text.slice(0, index)} ${text.slice(index)}`
    if (!out.includes(variant)) out.push(variant)
  }
  return out.slice(0, 8)
}

async function projectVersions(client: ModrinthClient, project: string, loader: string, minecraft: string | null): Promise<ModrinthVersion[]> {
  const found = new Map<string, ModrinthVersion>()
  for (const tag of loaderTags(loader)) {
    const list = await client.versions(project, { loader: tag, minecraft })
    for (const version of list) found.set(version.id, version)
  }
  return [...found.values()]
}

async function findProject(client: ModrinthClient, modId: string, loader: string, minecraft: string | null): Promise<string[]> {
  const queries = [modId, ...spacedQueries(modId)]
  for (const query of queries) {
    const search = await client.search({ query, loader, minecraft, sort: 'relevance', limit: 5, offset: 0 })
    // A relevance ranking is not evidence that a project provides this modid.
    const normal = (value: string): string => value.toLowerCase().replace(/[-_\s]/g, '')
    const hit = search.hits.find((item) => normal(item.slug) === normal(modId))
    if (hit) return [hit.projectId]
  }
  return []
}

async function versionsOf(client: ModrinthClient, need: DependencyNeed, context: DependencyInstallContext): Promise<ModrinthVersion[]> {
  const direct = await projectVersions(client, need.modId, context.loader, context.minecraftVersion)
  if (direct.length > 0) return direct
  for (const project of await findProject(client, need.modId, context.loader, context.minecraftVersion)) {
    const list = await projectVersions(client, project, context.loader, context.minecraftVersion)
    if (list.length > 0) return list
  }
  return []
}

export async function resolveDependencyNeeds(
  client: ModrinthClient,
  needs: DependencyNeed[],
  context: DependencyInstallContext,
  options: { signal?: AbortSignal; onProgress?(progress: TaskProgress, detail?: string): void } = {}
): Promise<DependencyPick[]> {
  const picks: DependencyPick[] = []
  let done = 0
  for (const need of needs) {
    options.onProgress?.({ done, total: needs.length, unit: 'steps' }, `查找 ${need.modId}`)
    if (options.signal?.aborted) throw new Error('已取消')
    try {
      const versions = await versionsOf(client, need, context)
      const compatible = versions.filter((version) =>
        (!context.minecraftVersion || version.gameVersions.includes(context.minecraftVersion)) &&
        loaderTags(context.loader).some((loader) => version.loaders.includes(loader)))
      const chosen = pickVersionForRanges(compatible, need.ranges)
      picks.push({ need, version: chosen.version, reason: chosen.version ? null : (chosen.reason ?? '没有可用版本') })
    } catch (error) {
      picks.push({ need, version: null, reason: error instanceof Error ? error.message : String(error) })
    }
    done += 1
  }
  options.onProgress?.({ done, total: needs.length, unit: 'steps' }, '查找完成')
  return picks
}

export async function installDependencyNeeds(
  needs: DependencyNeed[],
  context: DependencyInstallContext,
  options: DependencyInstallOptions
): Promise<DependencyInstallOutcome> {
  const outcome: DependencyInstallOutcome = { installed: [], skipped: [], failed: [], picks: [] }
  if (needs.length === 0) return outcome
  const picks = await resolveDependencyNeeds(options.client, needs, context, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {})
  })
  outcome.picks = picks
  const disabled = new Map<string, string>()
  for (const name of (await readdir(context.modsDir).catch(() => [] as string[])).filter((name) => name.endsWith('.jar.disabled'))) {
    const meta = await readJarMod(join(context.modsDir, name))
    for (const id of [meta.modId, ...meta.provides, ...meta.nestedIds]) if (id) disabled.set(id.toLowerCase(), name)
  }
  const downloads: Array<{ url: string; dest: string; target: string; sha1: string; size: number; pick: DependencyPick }> = []
  const targets = new Set<string>()
  for (const pick of picks) {
    if (!pick.version) {
      outcome.failed.push({ modId: pick.need.modId, reason: pick.reason ?? '没有可用版本' })
      continue
    }
    const paused = disabled.get(pick.need.modId.toLowerCase())
    if (paused) { outcome.failed.push({ modId: pick.need.modId, reason: `${paused} 已停用，请先到 Mod 管理中确认是否启用` }); continue }
    const fileName = pick.version.file.fileName
    if (basename(fileName) !== fileName || /[\\/:]/.test(fileName) || !fileName.endsWith('.jar')) {
      outcome.failed.push({ modId: pick.need.modId, reason: '下载来源返回了无效的 Mod 文件名' })
      continue
    }
    const target = join(context.modsDir, fileName)
    if (targets.has(target.toLowerCase())) throw new Error(`前置下载计划有同名文件 ${fileName}，已保留原文件`)
    targets.add(target.toLowerCase())
    if (existsSync(target) && await sha1Of(target) === pick.version.file.sha1) {
      outcome.skipped.push(pick.version.file.fileName)
      continue
    }
    if (existsSync(target)) {
      const meta = await readJarMod(target)
      if (meta.modId?.toLowerCase() !== pick.need.modId.toLowerCase()) throw new Error(`${fileName} 已有同名但属于其他 Mod 的文件，请先在 Mod 管理中确认`)
    }
    downloads.push({
      url: pick.version.file.url,
      dest: join(context.modsDir, `.${randomUUID()}.download`),
      target,
      sha1: pick.version.file.sha1,
      size: pick.version.file.size,
      pick
    })
  }
  if (downloads.length > 0) {
    const committed: string[] = []
    const trashed: string[] = []
    try {
      await downloadFiles(
        downloads.map((item) => ({ url: item.url, dest: item.dest, sha1: item.sha1, size: item.size })),
        {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          onProgress: (progress, detail) => options.onProgress?.(progress, detail ?? '下载依赖')
        }
      )
      // Check the jar's declared identity and version before replacing anything.
      // A project's slug and release title do not prove either of these facts.
      for (const item of downloads) {
        const meta = await readJarMod(item.dest)
        const id = item.pick.need.modId.toLowerCase()
        if (![meta.modId, ...meta.provides, ...meta.nestedIds].some((value) => value?.toLowerCase() === id)) throw new Error(`${item.pick.need.modId}：下载文件没有声明提供这个前置，已保留原文件`)
        if (meta.modId?.toLowerCase() === id && item.pick.need.ranges.some((range) => !meta.version || !rangeMatches(range, meta.version))) throw new Error(`${item.pick.need.modId}：文件内版本 ${meta.version ?? '未知'} 不满足 ${item.pick.need.ranges.join(' 且 ')}`)
        if (meta.mcRange && context.minecraftVersion && !matchesVersionRange(meta.mcRange, context.minecraftVersion)) throw new Error(`${item.pick.need.modId}：下载文件要求 Minecraft ${meta.mcRange}`)
      }
      const existing = await readdir(context.modsDir)
      for (const item of downloads) {
        options.signal?.throwIfAborted()
        for (const name of existing.filter((name) => name.endsWith('.jar'))) {
          const path = join(context.modsDir, name)
          if (!existsSync(path)) continue
          const meta = await readJarMod(path)
          if (path === item.target || meta.modId?.toLowerCase() === item.pick.need.modId.toLowerCase()) {
            const record = await moveToTrash(dirname(context.modsDir), 'dependency-repair', name)
            trashed.push(record.id)
          }
        }
        await copyFile(item.dest, item.target, constants.COPYFILE_EXCL)
        committed.push(item.target)
        outcome.installed.push(basename(item.target))
      }
    } catch (error) {
      const failures: unknown[] = []
      for (const path of committed) await rm(path, { force: true }).catch((e) => failures.push(e))
      for (const id of trashed.reverse()) await restoreFromTrash(dirname(context.modsDir), id).catch((e) => failures.push(e))
      if (failures.length) throw new AggregateError([error, ...failures], '补全失败，部分原文件保留在 Mod 回收站，请先恢复后再重试')
      throw error
    } finally {
      for (const item of downloads) await rm(item.dest, { force: true })
    }
  }
  return outcome
}
