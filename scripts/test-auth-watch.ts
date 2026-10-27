import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MicrosoftAccounts, validClientId, type SecretCodec } from '../src/core/microsoft.ts'
import { watchMods } from '../src/core/mods/watch.ts'
import { CraftService } from '../src/core/service.ts'
import { describeLaunchCommand } from '../src/core/launch.ts'

const root = await mkdtemp(join(tmpdir(), 'inkstone-auth-watch-'))
const clientId = '01234567-89ab-cdef-0123-456789abcdef'
const uuid = '0123456789abcdef0123456789abcdef'
const key = randomBytes(32)
const codec: SecretCodec = {
  encrypt(value) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  },
  decrypt(value) {
    const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
    cipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString()
  }
}
let passed = 0
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  try { await run(); passed++; console.log(`✓ ${name}`) }
  catch (error) { console.error(`✗ ${name}`); throw error }
}
let oauthError = ''
let owns = true
let profileStatus = 200
let downstreamStatus = 200
let expiresIn = 60
let pending = false
const calls: Array<{ url: string; body: string }> = []
const request = (async (input, init) => {
  init?.signal?.throwIfAborted()
  const url = String(input)
  const body = String(init?.body ?? '')
  calls.push({ url, body })
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  if (url.endsWith('/devicecode')) return json({ device_code: 'private-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://www.microsoft.com/link', interval: 1, expires_in: expiresIn })
  if (url.endsWith('/token')) {
    if (pending) { pending = false; return json({ error: 'authorization_pending' }, 400) }
    if (oauthError) return json({ error: oauthError, error_description: 'private-provider-data' }, 400)
    return json({ access_token: 'private-ms-access', refresh_token: body.includes('refresh_token=') ? 'private-refresh-rotated' : 'private-refresh', expires_in: 3600 })
  }
  if (url.includes('user.auth.xboxlive.com')) {
    assert.equal(JSON.parse(body).Properties.RpsTicket, 'd=private-ms-access')
    return json({ Token: 'private-xbl', DisplayClaims: { xui: [{ uhs: 'user-hash', xid: '123456789' }] } })
  }
  if (url.includes('device.auth.xboxlive.com')) return json({ Token: 'private-device-token', NotAfter: new Date(Date.now() + 86400_000).toISOString() })
  if (url.includes('xsts.auth.xboxlive.com')) return json({ Token: 'private-xsts', DisplayClaims: { xui: [{ uhs: 'user-hash', xid: '123456789' }] } })
  if (url.endsWith('/authentication/login_with_xbox')) return json({ access_token: 'private-mc-token', expires_in: 3600 }, downstreamStatus)
  if (url.endsWith('/entitlements/mcstore')) return json({ items: owns ? [{ name: 'game_minecraft' }] : [] })
  if (url.endsWith('/minecraft/profile')) return json({ id: uuid, name: 'InkstoneAuth' }, profileStatus)
  throw new Error(`Unexpected request: ${url}`)
}) as typeof fetch
const credentials = join(root, 'credentials.bin')
const auth = new MicrosoftAccounts(credentials, codec, request)
const service = new CraftService({ dataDir: join(root, 'data'), microsoft: auth })
let account: Awaited<ReturnType<MicrosoftAccounts['finish']>>
try {
  await test('AppID 校验，不发送无效请求', async () => {
    assert.ok(validClientId(clientId))
    assert.ok(!validClientId('missing'))
    await assert.rejects(auth.begin(''), /客户端.*ID/)
    assert.equal(calls.length, 0)
  })
  await test('设备码与 Xbox / Minecraft 完整交换，界面不接收令牌', async () => {
    pending = true
    const code = await auth.begin(clientId)
    assert.equal(code.userCode, 'ABCD-EFGH')
    assert.ok(!JSON.stringify(code).includes('private-device-code'))
    account = await auth.finish(code.id)
    assert.equal(account.uuid, uuid)
    assert.equal(account.kind, 'microsoft')
    assert.ok(!JSON.stringify(account).includes('private'))
    assert.ok(await auth.has(account.id))
  })
  await test('磁盘凭据加密，重新实例化后可解密', async () => {
    const raw = await readFile(credentials)
    assert.ok(!raw.includes(Buffer.from('private-refresh')))
    assert.ok(await new MicrosoftAccounts(credentials, codec, request).has(account.id))
  })
  await test('启动前刷新令牌，保留所选正版 UUID', async () => {
    const session = await auth.refresh(account, new AbortController().signal)
    assert.equal(session.account.id, account.id)
    assert.equal(session.accessToken, 'private-mc-token')
    assert.equal(session.xuid, '123456789')
    assert.equal(JSON.parse(codec.decrypt(await readFile(credentials)))[account.id].refreshToken, 'private-refresh-rotated')
  })
  await test('授权失效明确失败，不转离线', async () => {
    oauthError = 'invalid_grant'
    await assert.rejects(auth.refresh(account, new AbortController().signal), /授权已失效/)
    oauthError = ''
  })
  await test('刷新令牌已轮换但 Minecraft 失败时仍保存轮换', async () => {
    downstreamStatus = 403
    await assert.rejects(auth.refresh(account, new AbortController().signal), /AppID/)
    assert.equal(JSON.parse(codec.decrypt(await readFile(credentials)))[account.id].refreshToken, 'private-refresh-rotated')
    downstreamStatus = 200
  })
  await test('未拥有 Java 版拒绝登录，未创建档案给出说明', async () => {
    owns = false
    let code = await auth.begin(clientId)
    await assert.rejects(auth.finish(code.id), /没有有效.*Java/)
    owns = true
    profileStatus = 404
    code = await auth.begin(clientId)
    await assert.rejects(auth.finish(code.id), /档案/)
    profileStatus = 200
  })
  await test('取消中断设备码轮询；旧会话不能取消新会话', async () => {
    const old = await auth.begin(clientId)
    const waiting = auth.finish(old.id)
    auth.cancel(old.id)
    await assert.rejects(waiting, /取消/)
    const next = await auth.begin(clientId)
    auth.cancel(old.id)
    account = await auth.finish(next.id)
  })
  await test('设备码过期与用户拒绝', async () => {
    expiresIn = 0
    let code = await auth.begin(clientId)
    await assert.rejects(auth.finish(code.id), /过期/)
    expiresIn = 60
    oauthError = 'authorization_declined'
    code = await auth.begin(clientId)
    await assert.rejects(auth.finish(code.id), /取消/)
    oauthError = ''
  })
  await test('账号 signedIn 取自凭据，移除时清理；PCL 正版仍需重登', async () => {
    await service.updateSettings({ accounts: [account], selectedAccountId: account.id })
    assert.equal((await service.settings()).accounts[0].signedIn, true)
    await service.removeAccount(account.id)
    assert.equal(await auth.has(account.id), false)
    await service.updateSettings({ accounts: [{ ...account, source: 'pcl', signedIn: true }] })
    assert.equal((await service.settings()).accounts[0].signedIn, false)
  })
  await test('正版启动参数使用真实 UUID、msa、XUID、AppID，诊断隐藏令牌', async () => {
    const game = join(root, 'game')
    const id = 'test'
    await mkdir(join(game, 'versions', id), { recursive: true })
    await writeFile(join(game, 'versions', id, `${id}.json`), JSON.stringify({ id, mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: { game: ['--username', '${auth_player_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', '--userType', '${user_type}', '--xuid', '${auth_xuid}', '--clientId', '${clientid}'] } }))
    const args = await describeLaunchCommand({ folder: game, versionId: id, username: 'UnusedOffline', javaPath: 'java', gameDir: game, maxMemoryMb: 2048, nativeRoot: root, session: { account, accessToken: 'private-mc-token', xuid: '123456789', clientId } })
    assert.equal(args[args.indexOf('--username') + 1], 'InkstoneAuth')
    assert.equal(args[args.indexOf('--uuid') + 1], uuid)
    assert.equal(args[args.indexOf('--userType') + 1], 'msa')
    assert.equal(args[args.indexOf('--xuid') + 1], '123456789')
    assert.equal(args[args.indexOf('--clientId') + 1], clientId)
    assert.ok(!args.join(' ').includes('private-mc-token'))
  })
  await test('真实文件系统：外部新增、改名停用、删除、目录重建均通知，退订停止', async () => {
    const mods = join(root, 'watched-mods')
    let changes = 0
    const stop = watchMods(mods, () => { changes++ })
    const waitChange = async (mutate: () => Promise<unknown>): Promise<void> => {
      await delay(700)
      const before = changes
      await mutate()
      for (let i = 0; i < 45 && changes === before; i++) await delay(100)
      assert.ok(changes > before, '未收到目录变化通知')
    }
    try {
      await delay(100)
      await waitChange(async () => { await mkdir(mods); await writeFile(join(mods, 'a.jar'), 'jar') })
      await waitChange(() => writeFile(join(mods, 'b.jar'), 'jar'))
      await waitChange(() => rename(join(mods, 'b.jar'), join(mods, 'b.jar.disabled')))
      await waitChange(() => rm(join(mods, 'b.jar.disabled')))
      await waitChange(() => rm(mods, { recursive: true }))
      await waitChange(async () => { await mkdir(mods); await writeFile(join(mods, 'c.jar'), 'jar') })
      stop()
      await delay(600)
      const before = changes
      await writeFile(join(mods, 'after-unsubscribe.jar'), 'jar')
      await delay(2300)
      assert.equal(changes, before)
    } finally { stop() }
  })
  console.log(`auth-watch: ${passed} 项通过`)
} finally {
  service.dispose()
  auth.cancel()
  await rm(root, { recursive: true, force: true })
}
