import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SecretCodec } from '../src/core/microsoft.ts'
import { YggdrasilAccounts, normalizeServerInput } from '../src/core/yggdrasil.ts'
import { AuthlibInjectorStore } from '../src/core/authlib-injector.ts'
import { describeLaunchCommand } from '../src/core/launch.ts'
import { maskSecrets } from '../src/core/crash/collect.ts'
import { accountFromPcl } from '../src/core/accounts.ts'
import { CraftService } from '../src/core/service.ts'

const root = await mkdtemp(join(tmpdir(), 'inkstone-yggdrasil-'))
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

// ---------- 模拟 Yggdrasil 服务器、authlib-injector 官方源与 BMCLAPI 镜像 ----------
const PASSWORD = 'private-correct-password'
const P1 = { id: '11111111111111111111111111111111', name: 'InkSingle' }
const P2 = { id: '22222222222222222222222222222222', name: 'InkAlt' }
const P3 = { id: '33333333333333333333333333333333', name: 'InkMain' }
const METADATA = JSON.stringify({ meta: { serverName: 'MockSkin', implementationName: 'mock' }, skinDomains: ['ygg.test'], signaturePublickey: '-----BEGIN PUBLIC KEY-----\nmock\n-----END PUBLIC KEY-----' })
const JAR = Buffer.from('PK\u0003\u0004 mock authlib-injector jar')
const JAR_SHA = createHash('sha256').update(JAR).digest('hex')
const state = { validateFails: false, refreshFails: false, mirrorDown: false, officialJarCorrupt: false, mirrorJarCorrupt: false, artifactSha: JAR_SHA }
const tokens = new Map<string, { clientToken: string; profile: typeof P1 | null; owner: string }>()
const log: Array<{ method: string; path: string; body: string }> = []
let tokenSeq = 0
const newToken = (clientToken: string, profile: typeof P1 | null, owner: string): string => {
  const token = `private-access-${++tokenSeq}`
  tokens.set(token, { clientToken, profile, owner })
  return token
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': Buffer.isBuffer(body) ? 'application/java-archive' : 'application/json', ...headers })
  res.end(text)
}
const forbidden = (res: ServerResponse, message = 'Invalid token.') => send(res, 403, { error: 'ForbiddenOperationException', errorMessage: message })

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    const path = (req.url ?? '/').split('?')[0]
    log.push({ method: req.method ?? '', path, body: raw })
    const body = raw ? JSON.parse(raw) : {}
    // ALI: site root points to the API with a relative header
    if (path === '/ygg.test/' || path === '/ygg.test') return send(res, 200, '<html>skin site</html>', { 'content-type': 'text/html', 'X-Authlib-Injector-API-Location': '/api/yggdrasil/' })
    if (path === '/abs.test/') return send(res, 200, 'x', { 'X-Authlib-Injector-API-Location': 'https://ygg.test/api/yggdrasil' })
    if (path === '/plain.test/') return send(res, 200, '<html>not ygg</html>')
    if (path === '/insecure.test/') return send(res, 200, 'x', { 'X-Authlib-Injector-API-Location': 'http://ygg.test/api/yggdrasil' })
    if (path === '/ygg.test/api/yggdrasil' || path === '/ygg.test/api/yggdrasil/') return send(res, 200, METADATA, { 'X-Authlib-Injector-API-Location': '/api/yggdrasil/' })
    const auth = path.match(/^\/ygg\.test\/api\/yggdrasil\/authserver\/(\w+)$/)
    if (auth && req.method === 'POST') {
      const action = auth[1]
      if (action === 'authenticate') {
        if (body.password !== PASSWORD) return forbidden(res, 'Invalid credentials. Invalid username or password.')
        assert.equal(body.requestUser, true)
        const clientToken = body.clientToken
        if (body.username === 'single@example.com') return send(res, 200, { accessToken: newToken(clientToken, P1, body.username), clientToken, availableProfiles: [P1], selectedProfile: P1, user: { id: 'u1' } })
        if (body.username === 'multi@example.com') return send(res, 200, { accessToken: newToken(clientToken, null, body.username), clientToken, availableProfiles: [P2, P3], user: { id: 'u2' } })
        if (body.username === 'none@example.com') return send(res, 200, { accessToken: newToken(clientToken, null, body.username), clientToken, availableProfiles: [], user: { id: 'u3' } })
        return forbidden(res)
      }
      const known = tokens.get(body.accessToken)
      if (action === 'validate') return known && known.clientToken === body.clientToken && !state.validateFails ? send(res, 204) : forbidden(res)
      if (action === 'invalidate') { tokens.delete(body.accessToken); return send(res, 204) }
      if (action === 'refresh') {
        if (!known || known.clientToken !== body.clientToken || state.refreshFails) return forbidden(res)
        tokens.delete(body.accessToken)
        let profile = known.profile
        if (body.selectedProfile) {
          if (profile) return send(res, 400, { error: 'IllegalArgumentException', errorMessage: 'Access token already has a profile assigned.' })
          profile = [P2, P3].find((item) => item.id === body.selectedProfile.id) ?? null
          if (!profile) return forbidden(res)
        }
        return send(res, 200, { accessToken: newToken(body.clientToken, profile, known.owner), clientToken: body.clientToken, selectedProfile: profile ?? undefined, user: { id: 'u' } })
      }
    }
    const artifact = (url: string) => ({ build_number: 99, version: '9.9.9', release_time: '2026-11-01T00:00:00Z', download_url: url, checksums: { sha256: state.artifactSha } })
    if (path === '/authlib-injector.yushi.moe/artifact/latest.json') return send(res, 200, artifact('https://authlib-injector.yushi.moe/artifact/99/authlib-injector-9.9.9.jar'))
    if (path === '/mirror.test/mirrors/authlib-injector/artifact/latest.json') return state.mirrorDown ? send(res, 502, {}) : send(res, 200, artifact('https://mirror.test/mirrors/authlib-injector/artifact/99/authlib-injector-9.9.9.jar'))
    if (path === '/authlib-injector.yushi.moe/artifact/99/authlib-injector-9.9.9.jar') return send(res, 200, state.officialJarCorrupt ? Buffer.from('tampered official') : JAR)
    if (path === '/mirror.test/mirrors/authlib-injector/artifact/99/authlib-injector-9.9.9.jar') return state.mirrorDown ? send(res, 502, {}) : send(res, 200, state.mirrorJarCorrupt ? Buffer.from('tampered mirror') : JAR)
    send(res, 404, { error: 'NotFound' })
  })
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const port = (server.address() as AddressInfo).port
const outbound: string[] = []
/** Rewrites https://<host>/<path> to the local http mock; the core code still only sees https URLs. */
const request = (async (input, init) => {
  const url = new URL(String(input))
  outbound.push(url.href)
  assert.equal(url.protocol, 'https:', `核心代码发出了非 https 请求：${url.href}`)
  const response = await fetch(`http://127.0.0.1:${port}/${url.host}${url.pathname}${url.search}`, init)
  return new Response(response.body, { status: response.status, headers: response.headers })
}) as typeof fetch

const credentialsFile = join(root, 'data', 'yggdrasil-credentials.bin')
const ygg = new YggdrasilAccounts(credentialsFile, codec, request)
const authlib = new AuthlibInjectorStore(join(root, 'data', 'authlib-injector'), { fetchImpl: request, mirrorOrigin: 'https://mirror.test' })
const service = new CraftService({ dataDir: join(root, 'data'), yggdrasil: ygg, authlibInjector: authlib })
const API = 'https://ygg.test/api/yggdrasil'
const decrypted = async () => JSON.parse(codec.decrypt(await readFile(credentialsFile))) as Record<string, { accessToken: string; clientToken: string; profileId: string }>

try {
  await test('ALI：补全 https、相对 / 绝对 API 地址指示、指向自身、非外置服务器与 http 拒绝', async () => {
    assert.equal(normalizeServerInput('littleskin.cn').href, 'https://littleskin.cn/')
    assert.throws(() => normalizeServerInput('http://ygg.test/api/yggdrasil'), /https/)
    assert.throws(() => normalizeServerInput(''), /服务器地址/)
    const before = outbound.length
    await assert.rejects(ygg.login('http://ygg.test', 'single@example.com', PASSWORD), /https/)
    assert.equal(outbound.length, before, 'http 地址不应发出请求')
    const relative = await ygg.resolveServer('ygg.test')
    assert.equal(relative.apiRoot, API)
    assert.equal(relative.serverName, 'MockSkin')
    assert.equal(relative.metadata, METADATA)
    assert.equal((await ygg.resolveServer('https://abs.test/')).apiRoot, API)
    assert.equal((await ygg.resolveServer(`${API}/`)).apiRoot, API)
    await assert.rejects(ygg.resolveServer('plain.test'), /不是 authlib-injector/)
    await assert.rejects(ygg.resolveServer('insecure.test'), /https/)
  })

  let single: Awaited<ReturnType<CraftService['yggdrasilLogin']>>
  await test('认证成功：authenticate 带 requestUser，账号 id 按服务器与角色，令牌加密单独保存', async () => {
    single = await service.yggdrasilLogin('ygg.test', 'single@example.com', PASSWORD)
    assert.equal(single.state, 'done')
    const settings = single.state === 'done' ? single.settings : null
    const account = settings!.accounts.find((item) => item.uuid === P1.id)!
    assert.equal(account.id, `yggdrasil:ygg.test:${P1.id}`)
    assert.equal(account.server, API)
    assert.equal(account.serverName, 'MockSkin')
    assert.equal(account.signedIn, true)
    assert.equal(settings!.selectedAccountId, account.id)
    const auth = log.find((item) => item.path.endsWith('/authenticate'))!
    assert.equal(JSON.parse(auth.body).agent.name, 'Minecraft')
    const saved = (await decrypted())[account.id]
    assert.match(saved.accessToken, /^private-access-/)
    assert.ok(saved.clientToken)
  })

  await test('密码错误：给出中文原因，不保存任何凭据', async () => {
    const before = await readFile(credentialsFile)
    await assert.rejects(ygg.login('ygg.test', 'single@example.com', 'wrong-password'), /邮箱、用户名或密码错误/)
    await assert.rejects(ygg.login('ygg.test', 'single@example.com', ''), /请填写密码/)
    assert.deepEqual(await readFile(credentialsFile), before)
  })

  await test('多角色：返回角色列表让用户选，refresh 带 selectedProfile 绑定；没有角色时报中文错误', async () => {
    const result = await service.yggdrasilLogin(API, 'multi@example.com', PASSWORD)
    assert.equal(result.state, 'select')
    if (result.state !== 'select') return
    assert.deepEqual(result.selection.profiles.map((item) => item.name), ['InkAlt', 'InkMain'])
    assert.ok(!JSON.stringify(result).includes('private-access'), '选择角色的数据不能带令牌')
    const settings = await service.yggdrasilSelect(result.selection.pendingId, P3.id)
    const refresh = log.filter((item) => item.path.endsWith('/refresh')).at(-1)!
    assert.deepEqual(JSON.parse(refresh.body).selectedProfile, { id: P3.id, name: P3.name })
    assert.equal(settings.selectedAccountId, `yggdrasil:ygg.test:${P3.id}`)
    await assert.rejects(service.yggdrasilSelect(result.selection.pendingId, P2.id), /过期/)
    await assert.rejects(ygg.login(API, 'none@example.com', PASSWORD), /还没有角色/)
  })

  await test('凭据隔离：settings.json 与返回界面的数据里没有令牌和密码', async () => {
    const text = await readFile(join(root, 'data', 'settings.json'), 'utf8')
    const raw = await readFile(credentialsFile)
    const tokensSaved = Object.values(await decrypted()).flatMap((item) => [item.accessToken, item.clientToken])
    for (const secret of [PASSWORD, ...tokensSaved]) {
      assert.ok(!text.includes(secret), 'settings.json 含有凭据')
      assert.ok(!raw.includes(Buffer.from(secret)), '凭据文件未加密')
      assert.ok(!JSON.stringify(await service.settings()).includes(secret), '界面数据含有凭据')
    }
    for (const file of await readdir(join(root, 'data'))) {
      if (file === 'yggdrasil-credentials.bin' || file === 'authlib-injector') continue
      const content = await readFile(join(root, 'data', file)).catch(() => Buffer.alloc(0))
      assert.ok(!content.includes(Buffer.from(PASSWORD)), `${file} 含有密码`)
    }
  })

  await test('启动前 validate 失败则 refresh，保存新令牌', async () => {
    const account = (await service.settings()).accounts.find((item) => item.uuid === P1.id)!
    const old = (await decrypted())[account.id].accessToken
    let session = await ygg.session(account, new AbortController().signal)
    assert.equal(session.accessToken, old, '令牌有效时不刷新')
    state.validateFails = true
    session = await ygg.session(account, new AbortController().signal)
    state.validateFails = false
    assert.notEqual(session.accessToken, old)
    assert.equal((await decrypted())[account.id].accessToken, session.accessToken)
    assert.equal(session.server.apiRoot, API)
    assert.equal(session.server.metadata, METADATA)
  })

  await test('refresh 也失败：报错要求重新登录，账号变为未登录，启动不降级为离线', async () => {
    const account = (await service.settings()).accounts.find((item) => item.uuid === P3.id)!
    const game = join(root, 'game')
    await mkdir(join(game, 'versions', 'fake'), { recursive: true })
    await writeFile(join(game, 'versions', 'fake', 'fake.json'), JSON.stringify({ id: 'fake', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: { game: [] } }))
    await service.updateSettings({ folders: [{ name: 'game', path: game }], selectedAccountId: account.id })
    state.validateFails = true
    state.refreshFails = true
    const status = await service.launch({ folder: game, versionId: 'fake', javaPath: join(root, 'no-java.exe') })
    state.validateFails = false
    state.refreshFails = false
    assert.equal(status.state, 'failed')
    assert.match(status.error ?? '', /重新登录/)
    assert.equal(status.steps?.find((step) => step.id === 'account')?.state, 'failed')
    assert.ok(!service.logs().some((line) => /离线账号/.test(line.text)))
    assert.equal(await ygg.has(account.id), false)
    assert.equal((await service.settings()).accounts.find((item) => item.id === account.id)?.signedIn, false)
  })

  await test('PCL 迁移的外置账号重新登录后合并为同一个账号 id', async () => {
    const pcl = accountFromPcl({ type: 'authlib', username: 'InkMain', uuid: P3.id, server: 'https://ygg.test/api/yggdrasil/', serverName: 'MockSkin (PCL)' })!
    const settings = await service.settings()
    await service.updateSettings({ accounts: [...settings.accounts.filter((item) => item.id !== pcl.id), pcl] })
    assert.equal(pcl.id, `yggdrasil:ygg.test:${P3.id}`)
    const result = await service.yggdrasilLogin('ygg.test', 'multi@example.com', PASSWORD)
    assert.equal(result.state, 'select')
    if (result.state !== 'select') return
    const next = await service.yggdrasilSelect(result.selection.pendingId, P3.id)
    const matches = next.accounts.filter((item) => item.uuid === P3.id)
    assert.equal(matches.length, 1)
    assert.equal(matches[0].source, 'local')
    assert.equal(matches[0].signedIn, true)
  })

  await test('删除账号：清除对应凭据并请求 invalidate，其他账号不受影响', async () => {
    const id = `yggdrasil:ygg.test:${P3.id}`
    const token = (await decrypted())[id].accessToken
    await service.removeAccount(id)
    assert.equal(await ygg.has(id), false)
    assert.ok(!(id in await decrypted()))
    assert.ok(await ygg.has(`yggdrasil:ygg.test:${P1.id}`))
    assert.ok(log.some((item) => item.path.endsWith('/invalidate') && JSON.parse(item.body).accessToken === token))
  })

  let jarPath = ''
  await test('authlib-injector：镜像失败回落官方源，sha256 校验通过后缓存', async () => {
    state.mirrorDown = true
    const jar = await authlib.ensure({ source: 'auto' })
    state.mirrorDown = false
    assert.equal(jar.version, '9.9.9')
    assert.equal(createHash('sha256').update(await readFile(jar.path)).digest('hex'), JAR_SHA)
    assert.ok(outbound.some((url) => url.startsWith('https://mirror.test/mirrors/authlib-injector/artifact/latest.json')))
    assert.ok(outbound.some((url) => url === 'https://authlib-injector.yushi.moe/artifact/99/authlib-injector-9.9.9.jar'))
    const before = outbound.length
    assert.equal((await authlib.ensure({ source: 'auto' })).path, jar.path)
    assert.equal(outbound.length, before, '新鲜缓存不应再联网')
    jarPath = jar.path
  })

  await test('authlib-injector：jar sha256 不符时拒绝并删除，镜像被篡改时改用官方源', async () => {
    const dir = join(root, 'jar-check')
    state.mirrorJarCorrupt = true
    const fallback = await new AuthlibInjectorStore(join(dir, 'a'), { fetchImpl: request, mirrorOrigin: 'https://mirror.test' }).ensure({ source: 'auto' })
    assert.equal(createHash('sha256').update(await readFile(fallback.path)).digest('hex'), JAR_SHA)
    state.officialJarCorrupt = true
    const store = new AuthlibInjectorStore(join(dir, 'b'), { fetchImpl: request, mirrorOrigin: 'https://mirror.test' })
    await assert.rejects(store.ensure({ source: 'auto' }), /sha256/)
    assert.equal(existsSync(join(dir, 'b', 'authlib-injector-9.9.9.jar')), false)
    assert.equal(existsSync(join(dir, 'b', 'latest.json')), false)
    state.mirrorJarCorrupt = false
    state.officialJarCorrupt = false
    state.artifactSha = 'f'.repeat(64)
    await assert.rejects(new AuthlibInjectorStore(join(dir, 'c'), { fetchImpl: request, mirrorOrigin: 'https://mirror.test', freshMs: 0 }).ensure({ source: 'official' }), /sha256/)
    state.artifactSha = JAR_SHA
  })

  await test('启动参数：-javaagent 与 prefetched 元数据、Yggdrasil 角色和令牌、mojang 用户类型；诊断隐藏令牌', async () => {
    const account = (await service.settings()).accounts.find((item) => item.uuid === P1.id)!
    const session = await ygg.session(account, new AbortController().signal)
    const game = join(root, 'game')
    for (const [id, json] of [
      ['modern', { arguments: { game: ['--username', '${auth_player_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', '--userType', '${user_type}'], jvm: [] } }],
      ['legacy', { minecraftArguments: '--username ${auth_player_name} --session ${auth_session} --uuid ${auth_uuid}' }]
    ] as const) {
      await mkdir(join(game, 'versions', id), { recursive: true })
      await writeFile(join(game, 'versions', id, `${id}.json`), JSON.stringify({ id, mainClass: 'net.minecraft.client.main.Main', libraries: [], ...json }))
    }
    const options = { folder: game, gameDir: game, username: 'UnusedOffline', javaPath: 'java', maxMemoryMb: 2048, nativeRoot: join(root, 'natives'), yggdrasil: { account: session.account, accessToken: session.accessToken, apiRoot: session.server.apiRoot, metadata: session.server.metadata, agentJar: jarPath } }
    const args = await describeLaunchCommand({ ...options, versionId: 'modern' })
    const agent = args.find((arg) => arg.startsWith('-javaagent:'))
    assert.equal(agent, `-javaagent:${jarPath}=${API}`)
    const prefetched = args.find((arg) => arg.startsWith('-Dauthlibinjector.yggdrasil.prefetched='))!
    assert.equal(Buffer.from(prefetched.split('=')[1], 'base64').toString(), METADATA)
    assert.ok(args.indexOf(agent!) < args.indexOf('net.minecraft.client.main.Main'), 'javaagent 必须在主类之前')
    assert.equal(args[args.indexOf('--username') + 1], 'InkSingle')
    assert.equal(args[args.indexOf('--uuid') + 1], P1.id)
    assert.equal(args[args.indexOf('--userType') + 1], 'mojang')
    assert.equal(args[args.indexOf('--accessToken') + 1], '***')
    assert.ok(!args.join(' ').includes(session.accessToken))
    const legacy = await describeLaunchCommand({ ...options, versionId: 'legacy' })
    assert.ok(!legacy.join(' ').includes(session.accessToken), '旧版 --session 参数也要隐藏令牌')
    const exported = maskSecrets(`java -javaagent:x=${API} --accessToken ${session.accessToken} clientToken=${'abc123'}`)
    assert.ok(!exported.includes(session.accessToken) && !exported.includes('abc123'))
  })

  console.log(`yggdrasil: ${passed} 项通过`)
} finally {
  service.dispose()
  server.close()
  await rm(root, { recursive: true, force: true })
}
