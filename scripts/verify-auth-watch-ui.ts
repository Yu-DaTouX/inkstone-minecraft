import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { offlineAccount } from '../src/core/accounts.ts'
import { DEFAULT_SETTINGS } from '../src/core/settings.ts'
import { storedZip } from './zip-fixture.ts'

const root = await mkdtemp(resolve('.tmp', 'auth-watch-ui-'))
const output = resolve('.local-docs/checks/2026-10-27-auth-watch')
const game = join(root, 'game')
const data = join(root, 'data')
const id = '1.21.1-Fabric-test'
const mods = join(game, 'versions', id, 'mods')
await mkdir(mods, { recursive: true })
await mkdir(data, { recursive: true })
await mkdir(output, { recursive: true })
await writeFile(join(game, 'versions', id, `${id}.json`), JSON.stringify({ id, mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', javaVersion: { majorVersion: 21 }, libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.10' }], arguments: { game: [] }, type: 'release' }))
const account = offlineAccount('InkstoneTest')
await writeFile(join(data, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, folders: [{ name: '隔离测试', path: game }], selectedFolder: game, selectedVersion: id, accounts: [account], selectedAccountId: account.id, importedFromPclAt: 1, theme: 'light', closeToTray: false }))
const env: NodeJS.ProcessEnv = { ...process.env, INKSTONE_MC_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
delete env.INKSTONE_MICROSOFT_CLIENT_ID
const electron = createRequire(import.meta.url)('electron') as unknown as string
const port = 9700 + Math.floor(Math.random() * 150)
const app = spawn(electron, [resolve('.'), `--remote-debugging-port=${port}`, `--user-data-dir=${join(root, 'profile')}`], { env, stdio: 'ignore', windowsHide: true })
let socket: WebSocket | null = null
const pending = new Map<number, { done(value: any): void; fail(error: Error): void }>()
const errors: unknown[] = []
let sequence = 0
async function connect(): Promise<void> {
  for (let i = 0; i < 70; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>
      const page = targets.find((target) => target.type === 'page')
      if (page) { socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise((done, fail) => { socket!.onopen = done; socket!.onerror = fail }); return }
    } catch {}
    await delay(250)
  }
  throw new Error('隔离测试窗口没有启动')
}
function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const key = ++sequence
  return new Promise((done, fail) => { pending.set(key, { done, fail }); socket!.send(JSON.stringify({ id: key, method, params })) })
}
async function evaluate(expression: string): Promise<any> {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result?.value
}
async function waitFor(expression: string): Promise<void> {
  for (let i = 0; i < 80; i++) { if (await evaluate(expression)) return; await delay(100) }
  throw new Error(`UI 未达到预期：${expression}`)
}
async function click(text: string): Promise<void> {
  const expr = `(() => { const node = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)}); node?.click(); return !!node })()`
  await waitFor(expr)
  await delay(250)
}
async function screenshot(name: string): Promise<void> {
  const result = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(output, `${name}.png`), Buffer.from(result.data, 'base64'))
}
const jar = (name: string): Buffer => storedZip({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: name.toLowerCase(), name, version: '1.0.0', depends: { minecraft: '*' } }) })
const checks: string[] = []
try {
  await connect()
  socket!.onmessage = (event) => {
    const value = JSON.parse(String(event.data))
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params)
    const waiting = pending.get(value.id)
    if (waiting) { pending.delete(value.id); value.error ? waiting.fail(new Error(JSON.stringify(value.error))) : waiting.done(value.result) }
  }
  await send('Runtime.enable')
  await waitFor('!!window.craft && !!document.querySelector(".launch")')
  await click('设置')
  await waitFor('!!document.querySelector(".microsoft-login")')
  assert.equal(await evaluate('document.querySelector(".microsoft-login button").disabled'), false)
  await click('微软正版登录')
  await waitFor('!!document.querySelector(".microsoft-login__value")?.textContent')
  await click('取消登录')
  await waitFor('!document.querySelector(".microsoft-login__value")')
  checks.push('内置 AppID 可取得真实设备码，取消后清除等待状态；没有执行账号授权')
  await screenshot('accounts-light')
  await evaluate('window.craft.updateSettings({ theme: "dark" })')
  await send('Page.reload')
  await waitFor('!!document.querySelector(".launch")')
  await click('设置')
  await waitFor('!!document.querySelector(".microsoft-login")')
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false })
  await screenshot('accounts-dark-900')
  assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false)
  checks.push('账号页浅色和深色 900×600 无横向溢出')
  await send('Emulation.clearDeviceMetricsOverride')
  await click('启动')
  await waitFor('!!document.querySelector("[aria-label=版本设置]")')
  await evaluate('document.querySelector("[aria-label=版本设置]").click()')
  await click('Mod')
  await waitFor('document.body.innerText.includes("共 0 个")')
  await writeFile(join(mods, 'alpha.jar'), jar('Alpha'))
  await waitFor('!![...document.querySelectorAll(".mod-row__name")].find(x => x.textContent === "Alpha")')
  checks.push('外部新增 jar 自动出现在 Mod 列表')
  await rename(join(mods, 'alpha.jar'), join(mods, 'alpha.jar.disabled'))
  await waitFor('document.querySelector(".mod-row__meta")?.textContent.includes("已停用")')
  checks.push('外部改名停用自动反映启用状态')
  await screenshot('mods-disabled-dark')
  await rm(mods, { recursive: true })
  await waitFor('document.body.innerText.includes("共 0 个")')
  await mkdir(mods)
  await writeFile(join(mods, 'beta.jar'), jar('Beta'))
  await waitFor('!![...document.querySelectorAll(".mod-row__name")].find(x => x.textContent === "Beta")')
  checks.push('删除整个 mods 后重建仍自动刷新')
  await screenshot('mods-recreated-dark')
  // Test actual renderer cleanup through the preload API.
  await evaluate(`window.__changes = 0; window.__stopMods = window.craft.watchMods(${JSON.stringify(game)}, ${JSON.stringify(id)}, () => window.__changes++)`)
  await delay(600)
  await evaluate('window.__stopMods()')
  await delay(600)
  const before = await evaluate('window.__changes')
  await writeFile(join(mods, 'gamma.jar'), jar('Gamma'))
  await delay(2600)
  assert.equal(await evaluate('window.__changes'), before)
  checks.push('真实 preload / IPC 退订后停止通知')
  assert.equal(errors.length, 0)
  const result = { root, checks, renderExceptions: errors.length, note: '未使用真实 Microsoft 账号；认证协议由模拟响应测试覆盖。' }
  await writeFile(join(output, 'ui.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  ;(socket as WebSocket | null)?.close()
  app.kill()
}
