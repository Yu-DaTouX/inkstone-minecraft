import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MicrosoftAuthenticator, type XboxDeviceTokenState } from '@xmcl/user'
import { accountId, normalizeUuid } from './accounts.ts'
import type { Account, MicrosoftLoginCode } from '../shared/api.ts'

const OAUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
const SCOPE = 'XboxLive.signin offline_access'
export const validClientId = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
export interface SecretCodec { encrypt(value: string): Buffer; decrypt(value: Buffer): string }
interface Credential { clientId: string; refreshToken: string }
export interface MinecraftSession { account: Account; accessToken: string; xuid: string; clientId: string }
interface Pending { id: string; deviceCode: string; clientId: string; expiresAt: number; interval: number; abort: AbortController; finishing: boolean }

/** Credentials stay in the main process and are encrypted with the OS key store. */
export class MicrosoftAccounts {
  private pending: Pending | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly auth: MicrosoftAuthenticator
  private readonly file: string
  private readonly codec: SecretCodec
  private readonly request: typeof fetch
  constructor(file: string, codec: SecretCodec, request: typeof fetch = fetch) {
    this.file = file
    this.codec = codec
    this.request = request
    this.auth = new MicrosoftAuthenticator({ xboxDeviceTokenStorage: {
      get: async () => {
        try { return JSON.parse(codec.decrypt(await readFile(`${file}.device`))) as XboxDeviceTokenState }
        catch { return undefined }
      },
      put: async (state) => {
        await mkdir(dirname(file), { recursive: true })
        const temp = `${file}.device.${randomUUID()}.tmp`
        await writeFile(temp, codec.encrypt(JSON.stringify(state)), { mode: 0o600 })
        await rename(temp, `${file}.device`)
      }
    }, fetch: (input, init) => request(input, {
      ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
    }) })
  }

  private async credentials(): Promise<Record<string, Credential>> {
    try { return JSON.parse(this.codec.decrypt(await readFile(this.file))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error('无法解密正版登录凭据，请在当前 Windows 用户下重新登录')
    }
  }

  private change(update: (items: Record<string, Credential>) => void): Promise<void> {
    const task = this.queue.then(async () => {
      const items = await this.credentials()
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
  async remove(id: string): Promise<void> { await this.change((items) => { delete items[id] }) }

  private async post(path: string, form: Record<string, string>, signal?: AbortSignal): Promise<Record<string, any>> {
    const response = await this.request(`${OAUTH}/${path}`, {
      method: 'POST', body: new URLSearchParams(form),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
    })
    const body = await response.json() as Record<string, any>
    if (!response.ok && !body.error) throw new Error(`微软登录服务暂不可用（HTTP ${response.status}）`)
    return body
  }

  async begin(clientId: string): Promise<MicrosoftLoginCode> {
    if (!validClientId(clientId)) throw new Error('Microsoft 应用程序（客户端）ID 无效，请检查启动器配置')
    this.cancel()
    const pending: Pending = { id: randomUUID(), deviceCode: '', clientId, expiresAt: 0, interval: 5, abort: new AbortController(), finishing: false }
    this.pending = pending
    try {
      const body = await this.post('devicecode', { client_id: clientId, scope: SCOPE }, pending.abort.signal)
      if (body.error) throw new Error(body.error === 'unauthorized_client' ? '该 AppID 未启用公共客户端设备码登录，请检查 Microsoft 应用注册配置' : '无法获取微软设备码，请检查 AppID 与公共客户端配置')
      if (!body.device_code || !body.user_code || !Number.isFinite(body.expires_in)) throw new Error('微软返回的设备码无效')
      pending.deviceCode = body.device_code
      pending.expiresAt = Date.now() + body.expires_in * 1000
      pending.interval = Math.max(1, Number(body.interval) || 5)
      const uri = new URL(String(body.verification_uri))
      if (uri.protocol !== 'https:' || !['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com'].includes(uri.hostname)) throw new Error('微软返回的登录地址无效')
      return { id: pending.id, userCode: body.user_code, verificationUri: uri.href, expiresAt: pending.expiresAt }
    } catch (error) {
      if (this.pending === pending) this.pending = null
      throw error
    }
  }

  cancel(id?: string): void {
    if (this.pending && (!id || this.pending.id === id)) {
      this.pending.abort.abort()
      this.pending = null
    }
  }

  async finish(id: string): Promise<Account> {
    const pending = this.pending
    if (!pending || pending.id !== id || pending.finishing) throw new Error('这次登录已结束，请重新获取设备码')
    pending.finishing = true
    try {
      while (Date.now() < pending.expiresAt) {
        await delay(pending.interval * 1000, undefined, { signal: pending.abort.signal })
        const token = await this.post('token', { client_id: pending.clientId, device_code: pending.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, pending.abort.signal)
        if (token.error === 'authorization_pending') continue
        if (token.error === 'slow_down') { pending.interval += 5; continue }
        if (token.error) throw new Error(token.error === 'authorization_declined' || token.error === 'access_denied' ? '已取消微软授权' : token.error === 'expired_token' ? '设备码已过期，请重新登录' : '微软登录失败，请重新获取设备码')
        if (!token.access_token || !token.refresh_token) throw new Error('微软未返回完整登录凭据，请重新授权')
        const session = await this.exchange(token.access_token, pending.clientId, pending.abort.signal)
        pending.abort.signal.throwIfAborted()
        await this.change((items) => { items[session.account.id] = { clientId: pending.clientId, refreshToken: token.refresh_token } })
        return session.account
      }
      throw new Error('设备码已过期，请重新登录')
    } catch (error) {
      if (pending.abort.signal.aborted) throw new Error('已取消微软登录')
      throw error
    } finally { if (this.pending === pending) this.pending = null }
  }

  async refresh(account: Account, signal: AbortSignal): Promise<MinecraftSession> {
    await this.queue
    const saved = (await this.credentials())[account.id]
    if (!saved) throw new Error(`${account.name} 需要重新登录 Microsoft`)
    const token = await this.post('token', { client_id: saved.clientId, refresh_token: saved.refreshToken, grant_type: 'refresh_token', scope: SCOPE }, signal)
    if (token.error) throw new Error(token.error === 'invalid_grant' ? '微软授权已失效，请重新登录' : '微软令牌刷新失败，请稍后重试')
    if (!token.access_token) throw new Error('微软未返回有效令牌，请重新登录')
    // Persist rotation even if a downstream Xbox/Minecraft request fails.
    if (token.refresh_token) await this.change((items) => { if (items[account.id]) items[account.id] = { ...saved, refreshToken: token.refresh_token } })
    const session = await this.exchange(token.access_token, saved.clientId, signal)
    if (session.account.id !== account.id) throw new Error('登录身份与所选账号不一致，请重新登录')
    return session
  }

  private async exchange(accessToken: string, clientId: string, signal: AbortSignal): Promise<MinecraftSession> {
    // @xmcl/user supplies the Xbox RPS ticket and XSTS protocol.
    let xbox, minecraft
    try {
      xbox = await this.auth.acquireXBoxToken(accessToken, signal)
      const xsts = xbox.minecraftXstsResponse
      minecraft = await this.auth.loginMinecraftWithXBox(xsts.DisplayClaims.xui[0].uhs, xsts.Token, signal)
    } catch (error) {
      signal.throwIfAborted()
      const status = (error as { status?: number }).status
      throw new Error(status === 403 ? 'Minecraft 拒绝此应用登录，请确认当前 AppID 已获准访问 Minecraft API' : 'Xbox / Minecraft 认证失败，请检查 Xbox 账号资料、家庭权限或稍后重试')
    }
    const owned = await this.request('https://api.minecraftservices.com/entitlements/mcstore', {
      headers: { Authorization: `Bearer ${minecraft.access_token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    })
    if (!owned.ok) throw new Error(`检查 Minecraft Java 所有权失败（HTTP ${owned.status}）`)
    const entitlements = await owned.json() as { items?: Array<{ name: string }> }
    if (!entitlements.items?.some((item) => item.name === 'game_minecraft' || item.name === 'product_minecraft')) throw new Error('这个 Microsoft 账号没有有效的 Minecraft Java 版授权，请确认购买或 Game Pass 状态')
    const response = await this.request('https://api.minecraftservices.com/minecraft/profile', {
      headers: { Authorization: `Bearer ${minecraft.access_token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    })
    if (response.status === 404) throw new Error('这个 Microsoft 账号没有可用的 Minecraft Java 档案，请确认已拥有 Java 版并创建玩家名')
    if (!response.ok) throw new Error(`读取 Minecraft 玩家档案失败（HTTP ${response.status}）`)
    const profile = await response.json() as { id: string; name: string }
    const uuid = normalizeUuid(profile.id ?? '')
    if (!/^[0-9a-f]{32}$/.test(uuid) || !profile.name) throw new Error('Minecraft 玩家档案不完整')
    const xuid = xbox.liveXstsResponse?.DisplayClaims.xui[0].xid ?? xbox.minecraftXstsResponse.DisplayClaims.xui[0].xid ?? ''
    return { account: { id: accountId('microsoft', uuid, null), kind: 'microsoft', name: profile.name, uuid, server: null, serverName: null, source: 'local', signedIn: true }, accessToken: minecraft.access_token, xuid, clientId }
  }
}
