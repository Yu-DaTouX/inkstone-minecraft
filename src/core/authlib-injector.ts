import { createHash } from 'node:crypto'
import { readFile, mkdir, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { DownloadSource } from '../shared/api.ts'
import { downloadFiles, fetchJson, isAbortError } from './download/download.ts'
import { MIRROR_ORIGIN } from './download/sources.ts'

export const AUTHLIB_INJECTOR_ORIGIN = 'https://authlib-injector.yushi.moe'
export const AUTHLIB_INJECTOR_LATEST = `${AUTHLIB_INJECTOR_ORIGIN}/artifact/latest.json`
const MIRROR_PATH = '/mirrors/authlib-injector'
const FRESH_MS = 6 * 60 * 60 * 1000

export interface AuthlibInjectorJar {
  path: string
  version: string
  sha256: string
}

interface Artifact {
  build_number?: number
  version?: string
  download_url?: string
  checksums?: { sha256?: string }
}

interface CacheRecord {
  version: string
  sha256: string
  file: string
  checkedAt: number
}

export interface AuthlibInjectorOptions {
  fetchImpl?: typeof fetch
  mirrorOrigin?: string
  /** How long a verified cached jar is reused before checking latest.json again. */
  freshMs?: number
}

async function sha256Of(path: string): Promise<string | null> {
  try { return createHash('sha256').update(await readFile(path)).digest('hex') } catch { return null }
}

/** Downloads the latest authlib-injector (BMCLAPI mirror first, official fallback), verifies sha256 and caches it. */
export class AuthlibInjectorStore {
  private readonly dir: string
  private readonly options: AuthlibInjectorOptions
  private running: Promise<AuthlibInjectorJar> | null = null
  constructor(dir: string, options: AuthlibInjectorOptions = {}) {
    this.dir = dir
    this.options = options
  }

  private get recordFile(): string { return join(this.dir, 'latest.json') }

  private async record(): Promise<CacheRecord | null> {
    try {
      const value = JSON.parse(await readFile(this.recordFile, 'utf8')) as CacheRecord
      return typeof value.file === 'string' && /^[0-9a-f]{64}$/.test(value.sha256) && !/[\\/]/.test(value.file) ? value : null
    } catch { return null }
  }

  private async verified(record: CacheRecord | null): Promise<AuthlibInjectorJar | null> {
    if (!record) return null
    const path = join(this.dir, record.file)
    return (await sha256Of(path)) === record.sha256 ? { path, version: record.version, sha256: record.sha256 } : null
  }

  /** Mirror metadata points at the mirror; map back so the downloader can choose mirror or official itself. */
  private officialUrl(url: string): string {
    const mirror = `${this.options.mirrorOrigin ?? MIRROR_ORIGIN}${MIRROR_PATH}/`
    const official = url.startsWith(mirror) ? `${AUTHLIB_INJECTOR_ORIGIN}/${url.slice(mirror.length)}` : url
    if (!official.startsWith(`${AUTHLIB_INJECTOR_ORIGIN}/`)) throw new Error('authlib-injector 下载地址不在官方源或镜像中')
    return official
  }

  ensure(options: { source?: DownloadSource; signal?: AbortSignal } = {}): Promise<AuthlibInjectorJar> {
    this.running ??= this.prepare(options).finally(() => { this.running = null })
    return this.running
  }

  private async prepare({ source = 'auto', signal }: { source?: DownloadSource; signal?: AbortSignal }): Promise<AuthlibInjectorJar> {
    const cached = await this.record()
    const local = await this.verified(cached)
    if (local && cached && Date.now() - cached.checkedAt < (this.options.freshMs ?? FRESH_MS)) return local
    const common = { source, signal, fetchImpl: this.options.fetchImpl, mirrorOrigin: this.options.mirrorOrigin, retries: 1 }
    let artifact: Artifact
    try {
      artifact = await fetchJson<Artifact>(AUTHLIB_INJECTOR_LATEST, { ...common, timeoutMs: 15_000 })
    } catch (error) {
      if (isAbortError(error)) throw error
      if (local) return local
      throw new Error(`无法获取 authlib-injector 版本信息：${error instanceof Error ? error.message : String(error)}`)
    }
    const version = String(artifact.version ?? '')
    const sha256 = String(artifact.checksums?.sha256 ?? '').toLowerCase()
    if (!/^[0-9A-Za-z._-]{1,40}$/.test(version) || !/^[0-9a-f]{64}$/.test(sha256) || typeof artifact.download_url !== 'string') throw new Error('authlib-injector 版本信息不完整')
    const file = `authlib-injector-${version}.jar`
    const dest = join(this.dir, file)
    await mkdir(this.dir, { recursive: true })
    if ((await sha256Of(dest)) !== sha256) {
      try {
        await downloadFiles([{ url: this.officialUrl(artifact.download_url), dest, sha256 }], { ...common, concurrency: 4 })
      } catch (error) {
        await rm(dest, { force: true }).catch(() => {})
        if (isAbortError(error)) throw error
        throw new Error(`authlib-injector 下载或 sha256 校验失败：${error instanceof Error ? error.message : String(error)}`)
      }
      if ((await sha256Of(dest)) !== sha256) {
        await rm(dest, { force: true }).catch(() => {})
        throw new Error('authlib-injector sha256 校验失败，已删除下载的文件')
      }
    }
    const record: CacheRecord = { version, sha256, file, checkedAt: Date.now() }
    const temp = `${this.recordFile}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(record))
    await rename(temp, this.recordFile)
    return { path: dest, version, sha256 }
  }
}
