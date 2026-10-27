import type { ModEntry, ModIssue } from '../../shared/mods-api.ts'
import { matchesVersionRange } from './mc-range.ts'

const ANY_RANGE = /^\s*(\*|any)?\s*$/i

/**
 * 声明的「不兼容」只在对方版本落在范围里时才算。
 * 只是通过 provides / 内嵌提供这个 id 的 Mod 版本未知，只有范围是「任意版本」时才算，免得误报。
 */
function breaksWith(range: string | null, provider: ModEntry, depId: string): boolean {
  const any = !range || ANY_RANGE.test(range)
  if (provider.modId?.toLowerCase() !== depId) return any
  if (any) return true
  if (!provider.version) return false
  return matchesVersionRange(range, provider.version)
}

export interface AnalyzeContext {
  loader: string
  minecraftVersion: string | null
}

const CONNECTOR_IDS = new Set(['connector', 'sinytraconnector', 'connectormod', 'connectivity', 'forgedfabric'])
// 加载器自带、不需要单独装的：Fabric Loader 0.15+ 和 NeoForge 都内置了 MixinExtras
const PLATFORM_IDS = new Set(['minecraft', 'java', 'mixinextras', 'fabricloader', 'fabric-loader', 'fabric_loader', 'quilt_loader', 'quilt-loader', 'forge', 'neoforge', 'modloader', 'javafml', 'lowcodefml'])
const FABRIC_FAMILY = new Set(['fabric', 'quilt'])
const FORGE_FAMILY = new Set(['forge', 'neoforge', 'legacy'])

export function identifiersOf(mod: ModEntry): string[] {
  const ids = [mod.modId, ...mod.provides, ...mod.nestedIds].filter((id): id is string => !!id)
  return [...new Set(ids.map((id) => id.toLowerCase()))]
}

export function loaderMismatch(kind: string | null, loader: string, connector: boolean): boolean {
  if (!kind || connector) return false
  if (loader === 'forge' || loader === 'neoforge') return FABRIC_FAMILY.has(kind)
  if (loader === 'quilt') return FORGE_FAMILY.has(kind)
  if (loader === 'fabric') return FORGE_FAMILY.has(kind)
  return false
}

export function analyzeMods(mods: ModEntry[], context: AnalyzeContext): ModEntry[] {
  const active = new Map<string, ModEntry[]>()
  const disabledProvides = new Set<string>()
  const allProvides = new Set<string>()
  for (const mod of mods) {
    const ids = identifiersOf(mod)
    for (const id of ids) {
      allProvides.add(id)
      if (!mod.enabled) disabledProvides.add(id)
      const list = active.get(id) ?? []
      list.push(mod)
      active.set(id, list)
    }
  }
  const connector = [...active.entries()].some(([id, providers]) => CONNECTOR_IDS.has(id) && providers.some((item) => item.enabled))
  const modIdCounts = new Map<string, number>()
  for (const mod of mods) {
    const id = mod.modId?.toLowerCase()
    // 停用的副本不算重复
    if (!id || !mod.enabled) continue
    modIdCounts.set(id, (modIdCounts.get(id) ?? 0) + 1)
  }

  for (const mod of mods) {
    const issues: ModIssue[] = []
    if (!mod.kind) {
      issues.push({ kind: 'no-metadata', text: '读不到 Mod 元数据，可能不是 Mod 文件', modId: null })
    }
    for (const dep of mod.dependencies) {
      const depId = dep.modId.toLowerCase()
      if (PLATFORM_IDS.has(depId)) continue
      const providers = active.get(depId) ?? []
      const usable = providers.filter((item) => item.enabled)
      if (dep.kind === 'breaks') {
        // 只看启用中的、不是自己的 Mod；自己停用了也不报
        const clash = usable.find((item) => item !== mod && breaksWith(dep.versionRange, item, depId))
        if (mod.enabled && clash) {
          const range = dep.versionRange && !ANY_RANGE.test(dep.versionRange) ? `（对方 ${dep.versionRange} 的版本）` : ''
          issues.push({ kind: 'incompatible', text: `与 ${clash.name ?? dep.modId}${clash.version ? ` ${clash.version}` : ''} 不兼容${range}`, modId: dep.modId })
        }
        continue
      }
      if (!dep.required || !mod.enabled) continue
      if (usable.length > 0) {
        // An alias or nested jar has no independently known version. Only reject
        // versions that can actually be checked against this dependency's id.
        const unknown = usable.some((item) => item.modId?.toLowerCase() !== depId || !item.version)
        if (!unknown && !usable.some((item) => matchesVersionRange(dep.versionRange, item.version))) {
          issues.push({ kind: 'dependency-version', text: `前置 ${dep.modId} 需要 ${dep.versionRange}，已安装 ${usable.map((item) => item.version).join('、')}`, modId: dep.modId })
        }
        continue
      }
      const text = disabledProvides.has(depId) ? `缺少前置 ${dep.modId}（已停用）` : `缺少前置 ${dep.modId}`
      issues.push({ kind: 'missing-dependency', text, modId: dep.modId })
    }
    if (mod.mcRange && context.minecraftVersion && !matchesVersionRange(mod.mcRange, context.minecraftVersion)) {
      issues.push({ kind: 'mc-mismatch', text: `要求 Minecraft ${mod.mcRange}，本版本是 ${context.minecraftVersion}`, modId: mod.modId })
    }
    if (context.loader === 'vanilla' && mod.kind) {
      issues.push({ kind: 'loader-mismatch', text: '原版不能加载 Mod', modId: mod.modId })
    } else if (loaderMismatch(mod.kind, context.loader, connector)) {
      issues.push({ kind: 'loader-mismatch', text: '加载器不匹配', modId: mod.modId })
    }
    if (mod.enabled && mod.modId && (modIdCounts.get(mod.modId.toLowerCase()) ?? 0) > 1) {
      issues.push({ kind: 'duplicate', text: '重复安装', modId: mod.modId })
    }
    mod.issues = issues
  }
  return mods
}

export function countIssues(mods: ModEntry[]): number {
  return mods.filter((mod) => mod.issues.length > 0).length
}
