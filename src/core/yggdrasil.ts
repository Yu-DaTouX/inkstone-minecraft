import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { accountId, normalizeUuid } from './accounts.ts'
import type { SecretCodec } from './microsoft.ts'
import type { Account, YggdrasilProfileOption, YggdrasilSelection } from '../shared/api.ts'

const TIMEOUT_MS = 20_000
const PENDING_MS = 10 * 60_000
const ALI_HEADER = 'x-authlib-injector-api-location'
const UUID = /^[0-9a-f]{32}$/

/** Resolved authlib-injector server: API root plus the raw metadata used for -Dauthlibinjector.yggdrasil.prefetched. */
export interface YggdrasilServer {
  apiRoot: string
  serverName: string
  metadata: string
}

export interface YggdrasilSession {
  account: Account
  accessToken: string
  server: YggdrasilServer
}

export type YggdrasilLoginOutcome = { account: Account } | { selection: YggdrasilSelection }

interface Credential {
  apiRoot: string
  serverName: string
  accessToken: string
  clientToken: string
  profileId: string
  profileName: string
}

interface Pending {
  server: YggdrasilServer
  accessToken: string
  clientToken: string
  profiles: YggdrasilProfileOption[]
  expiresAt: number
}

interface Reply {
  status: number
  body: Record<string, any> | null
}

function trimRoot(url: URL): string {
  const copy = new URL(url.href)
  copy.hash = ''
  copy.search = ''
  return copy.href.replace(/\/+$/, '')
}

function requireHttps(url: URL): void {
  if (url.protocol !== 'https:') throw new Error('外置登录只支持 https 地址，http 会明文传输密码')
  if (url.username || url.password) throw new Error('服务器地址里不能包含用户名或密码')
}

/** ALI step 1: complete a missing scheme with https and reject anything else. */
export function normalizeServerInput(input: string): URL {
  let text = String(input ?? '').trim()
  if (!text) throw new Error('请填写外置登录服务器地址')
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`
  let url: URL
  try { url = new URL(text) } catch { throw new Error('服务器地址格式不正确') }
  requireHttps(url)
  return url
}

function profileOf(value: unknown): YggdrasilProfileOption | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { id?: unknown; name?: unknown }
  const id = typeof raw.id === 'string' ? normalizeUuid(raw.id) : ''
  return UUID.test(id) && typeof raw.name === 'string' && raw.name ? { id, name: raw.name } : null
}

function serverMessage(body: Record<string, any> | null): string {
  const text = typeof body?.errorMessage === 'string' ? body.errorMessage.trim() : ''
  return text ? `（${text.slice(0, 120)}）` : ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * authlib-injector / Yggdrasil accounts. Tokens stay in the main process and are
 * encrypted with the injected codec; passwords are only used for one request.
 */
export class YggdrasilAccounts {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly pending = new Map<string, Pending>()
  private readonly file: string
  private readonly codec: SecretCodec
  private readonly request: typeof fetch
  constructor(file: string, codec: SecretCodec, request: typeof fetch = fetch) {
    this.file = file
    this.codec = codec
    this.request = request
  }

  private async credentials(): Promise<Record<string, Credential>> {
    try { return JSON.parse(this.codec.decrypt(await readFile(this.file))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error('无法解密外置登录凭据，请在当前 Windows 用户下重新登录')
    }
  }

  private change(update: (items: Record<string, Credential>) => void): Promise<void> {
    const task = this.queue.then(async () => {
      const items = await this.credentials().catch(() => ({} as Record<string, Credential>))
      update(items)
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${randomUUID()}.tmp`
      await writeFile(temp, this.codec.encrypt(JSON.stringify(items)), { mode: 0o600 })
      await rename(temp, this.file)
    })
    this.queue = task.catch(() => {})
    return task
  }

  async has(id: string): Promise<boolean> {
    await this.queue
    try { return !!(await this.credentials())[id] } catch { return false }
  }

  /** Forget the tokens; also ask the server to revoke them, without waiting long. */
  async remove(id: string): Promise<void> {
    await this.queue
    const saved = await this.credentials().then((items) => items[id]).catch(() => undefined)
    await this.change((items) => { delete items[id] })
    if (saved) await this.post(saved.apiRoot, 'invalidate', { accessToken: saved.accessToken, clientToken: saved.clientToken }, AbortSignal.timeout(5000)).catch(() => {})
  }

  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
  }

  private async get(url: string, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      response = await this.request(url, { redirect: 'follow', headers: { accept: 'application/json' }, signal: this.signal(signal) })
    } catch (error) {
      signal?.throwIfAborted()
      throw new Error(`无法连接外置登录服务器 ${new URL(url).host}：${messageOf(error)}`)
    }
    if (response.redirected && response.url && !response.url.startsWith('https:')) throw new Error('服务器把请求重定向到了非 https 地址，已停止')
    return response
  }

  private async metadataFrom(response: Response, apiRoot: string): Promise<YggdrasilServer> {
    if (!response.ok) throw new Error(`外置登录服务器返回 HTTP ${response.status}，请检查地址`)
    const text = await response.text()
    let meta: Record<string, any>
    try { meta = JSON.parse(text) } catch { throw new Error('这个地址不是 authlib-injector 外置登录服务器') }
    if (!meta || typeof meta !== 'object' || (typeof meta.meta !== 'object' && !Array.isArray(meta.skinDomains))) throw new Error('这个地址不是 authlib-injector 外置登录服务器')
    const name = typeof meta.meta?.serverName === 'string' && meta.meta.serverName.trim() ? meta.meta.serverName.trim().slice(0, 60) : new URL(apiRoot).host
    return { apiRoot, serverName: name, metadata: text }
  }

  /** API location indication (ALI): GET the input, follow X-Authlib-Injector-API-Location, return the API root and metadata. */
  async resolveServer(input: string, signal?: AbortSignal): Promise<YggdrasilServer> {
    const url = normalizeServerInput(input)
    const response = await this.get(url.href, signal)
    const base = new URL(response.redirected && response.url ? response.url : url.href)
    requireHttps(base)
    const ali = response.headers.get(ALI_HEADER)
    if (ali) {
      let target: URL
      try { target = new URL(ali, base) } catch { throw new Error('服务器返回的 API 地址指示无效') }
      requireHttps(target)
      if (trimRoot(target) !== trimRoot(base)) {
        await response.body?.cancel().catch(() => {})
        const root = trimRoot(target)
        return this.metadataFrom(await this.get(root, signal), root)
      }
    }
    return this.metadataFrom(response, trimRoot(base))
  }

  private async post(apiRoot: string, action: 'authenticate' | 'refresh' | 'validate' | 'invalidate', body: Record<string, unknown>, signal?: AbortSignal): Promise<Reply> {
    const url = new URL(`${apiRoot}/authserver/${action}`)
    requireHttps(url)
    let response: Response
    try {
      response = await this.request(url.href, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body), signal: this.signal(signal)
      })
    } catch (error) {
      signal?.throwIfAborted()
      throw new Error(`无法连接外置登录服务器 ${url.host}：${messageOf(error)}`)
    }
    const text = await response.text().catch(() => '')
    let parsed: Record<string, any> | null = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
    return { status: response.status, body: parsed && typeof parsed === 'object' ? parsed : null }
  }

  private failure(reply: Reply, action: string): Error {
    if (reply.status === 429) return new Error('请求太频繁，被外置登录服务器限制，请稍后再试')
    if (reply.status >= 500) return new Error(`外置登录服务器暂时不可用（HTTP ${reply.status}），请稍后再试`)
    if (reply.body?.error === 'ForbiddenOperationException' || reply.status === 401 || reply.status === 403) {
      return new Error(action === 'authenticate' ? `邮箱、用户名或密码错误${serverMessage(reply.body)}` : `外置登录已失效，请重新登录${serverMessage(reply.body)}`)
    }
    return new Error(`外置登录失败（HTTP ${reply.status}）${serverMessage(reply.body)}`)
  }

  private accountFor(server: YggdrasilServer, profile: YggdrasilProfileOption): Account {
    return { id: accountId('yggdrasil', profile.id, server.apiRoot), kind: 'yggdrasil', name: profile.name, uuid: profile.id, server: server.apiRoot, serverName: server.serverName, source: 'local', signedIn: true }
  }

  private async save(server: YggdrasilServer, accessToken: string, clientToken: string, profile: YggdrasilProfileOption): Promise<Account> {
    const account = this.accountFor(server, profile)
    await this.change((items) => {
      items[account.id] = { apiRoot: server.apiRoot, serverName: server.serverName, accessToken, clientToken, profileId: profile.id, profileName: profile.name }
    })
    return account
  }

  private tokens(body: Record<string, any> | null, clientToken: string): { accessToken: string; clientToken: string } {
    const accessToken = typeof body?.accessToken === 'string' ? body.accessToken : ''
    if (!accessToken) throw new Error('外置登录服务器没有返回令牌')
    return { accessToken, clientToken: typeof body?.clientToken === 'string' && body.clientToken ? body.clientToken : clientToken }
  }

  /** authserver/authenticate. One profile → done; several → the caller picks one via select(). */
  async login(input: string, username: string, password: string, signal?: AbortSignal): Promise<YggdrasilLoginOutcome> {
    const user = String(username ?? '').trim()
    if (!user) throw new Error('请填写邮箱或用户名')
    if (!password) throw new Error('请填写密码')
    const server = await this.resolveServer(input, signal)
    const reply = await this.post(server.apiRoot, 'authenticate', {
      agent: { name: 'Minecraft', version: 1 }, username: user, password, clientToken: randomUUID().replace(/-/g, ''), requestUser: true
    }, signal)
    if (reply.status < 200 || reply.status >= 300) throw this.failure(reply, 'authenticate')
    const requested = typeof reply.body?.clientToken === 'string' ? reply.body.clientToken : ''
    const tokens = this.tokens(reply.body, requested)
    if (!tokens.clientToken) throw new Error('外置登录服务器没有返回客户端令牌')
    const selected = profileOf(reply.body?.selectedProfile)
    if (selected) return { account: await this.save(server, tokens.accessToken, tokens.clientToken, selected) }
    const profiles = (Array.isArray(reply.body?.availableProfiles) ? reply.body.availableProfiles : []).map(profileOf).filter((item: YggdrasilProfileOption | null): item is YggdrasilProfileOption => !!item)
    if (profiles.length === 0) throw new Error(`这个账号在 ${server.serverName} 还没有角色，请先到皮肤站创建角色后再登录`)
    const pending: Pending = { server, ...tokens, profiles, expiresAt: Date.now() + PENDING_MS }
    if (profiles.length === 1) return { account: await this.bind(pending, profiles[0], signal) }
    for (const [key, item] of this.pending) if (item.expiresAt < Date.now()) this.pending.delete(key)
    const pendingId = randomUUID()
    this.pending.set(pendingId, pending)
    return { selection: { pendingId, serverName: server.serverName, profiles } }
  }

  private async bind(pending: Pending, profile: YggdrasilProfileOption, signal?: AbortSignal): Promise<Account> {
    const reply = await this.post(pending.server.apiRoot, 'refresh', {
      accessToken: pending.accessToken, clientToken: pending.clientToken, requestUser: true, selectedProfile: { id: profile.id, name: profile.name }
    }, signal)
    if (reply.status < 200 || reply.status >= 300) throw this.failure(reply, 'refresh')
    const tokens = this.tokens(reply.body, pending.clientToken)
    const bound = profileOf(reply.body?.selectedProfile) ?? profile
    if (bound.id !== profile.id) throw new Error('外置登录服务器绑定了其他角色，请重新登录')
    return this.save(pending.server, tokens.accessToken, tokens.clientToken, bound)
  }

  /** Bind the token from a multi-profile login to the chosen profile (refresh with selectedProfile). */
  async select(pendingId: string, profileId: string, signal?: AbortSignal): Promise<Account> {
    const pending = this.pending.get(pendingId)
    if (!pending || pending.expiresAt < Date.now()) {
      this.pending.delete(pendingId)
      throw new Error('这次外置登录已过期，请重新登录')
    }
    const profile = pending.profiles.find((item) => item.id === normalizeUuid(String(profileId ?? '')))
    if (!profile) throw new Error('请选择一个角色')
    this.pending.delete(pendingId)
    return this.bind(pending, profile, signal)
  }

  cancel(pendingId?: string): void {
    const ids = pendingId ? [pendingId] : [...this.pending.keys()]
    for (const id of ids) {
      const item = this.pending.get(id)
      if (!item) continue
      this.pending.delete(id)
      void this.post(item.server.apiRoot, 'invalidate', { accessToken: item.accessToken, clientToken: item.clientToken }, AbortSignal.timeout(5000)).catch(() => {})
    }
  }

  /**
   * Before launch: validate, else refresh. If both fail the user must sign in again;
   * there is no fallback to an offline identity.
   */
  async session(account: Account, signal: AbortSignal): Promise<YggdrasilSession> {
    await this.queue
    const saved = (await this.credentials())[account.id]
    if (!saved) throw new Error(`${account.name} 需要重新登录外置账号`)
    const server = await this.metadataFrom(await this.get(saved.apiRoot, signal), saved.apiRoot)
    let current = saved
    const valid = await this.post(saved.apiRoot, 'validate', { accessToken: saved.accessToken, clientToken: saved.clientToken }, signal)
    if (valid.status < 200 || valid.status >= 300) {
      const reply = await this.post(saved.apiRoot, 'refresh', { accessToken: saved.accessToken, clientToken: saved.clientToken, requestUser: true }, signal)
      if (reply.status < 200 || reply.status >= 300) {
        const error = this.failure(reply, 'refresh')
        // Revoked tokens cannot come back; drop them so the account shows "需要重新登录".
        if (reply.status === 401 || reply.status === 403 || reply.body?.error === 'ForbiddenOperationException') await this.change((items) => { delete items[account.id] })
        throw new Error(`${account.name}：${error.message}`)
      }
      const tokens = this.tokens(reply.body, saved.clientToken)
      const profile = profileOf(reply.body?.selectedProfile) ?? { id: saved.profileId, name: saved.profileName }
      if (profile.id !== account.uuid) throw new Error('外置登录返回的角色与所选账号不一致，请重新登录')
      current = { ...saved, ...tokens, profileName: profile.name, serverName: server.serverName }
      const next = current
      await this.change((items) => { items[account.id] = next })
    }
    return {
      account: { ...account, name: current.profileName, server: saved.apiRoot, serverName: server.serverName, signedIn: true },
      accessToken: current.accessToken,
      server
    }
  }
}
