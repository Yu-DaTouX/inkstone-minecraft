import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { offlineAccount } from '../src/core/accounts.ts'
import { DEFAULT_SETTINGS } from '../src/core/settings.ts'
import { storedZip } from './zip-fixture.ts'
import { CrashCenter } from '../src/core/crash/index.ts'

const phase = process.argv[2] ?? 'after'
const root = resolve('.tmp', `runtime-${phase}-${Date.now()}`)
const output = resolve('.local-docs', 'checks', `2026-10-25-${phase}`)
const game = join(root, 'game')
const data = join(root, 'data')
const id = '1.21.1-Fabric-test'
await mkdir(join(game, 'versions', id, 'mods'), { recursive: true })
await mkdir(data, { recursive: true })
await mkdir(output, { recursive: true })
await writeFile(join(game, 'versions', id, `${id}.json`), JSON.stringify({ id, mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', javaVersion: { majorVersion: 21 }, libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.10' }], arguments: { game: [] }, type: 'release' }))
await writeFile(join(game, 'versions', id, 'options.txt'), 'renderDistance:24\nsimulationDistance:16\nentityDistanceScaling:1.5\nparticles:0\nfov:0.25\n')
await writeFile(join(game, 'versions', id, 'mods', 'example.jar'), storedZip({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'example', name: 'Example', version: '1.0.0', depends: { missinglib: '>=2.0.0' } }) }))
const account = offlineAccount('InkstoneTest')
await writeFile(join(data, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, folders: [{ name: '隔离测试', path: game }], selectedFolder: game, selectedVersion: id, accounts: [account], selectedAccountId: account.id, importedFromPclAt: 1, theme: 'light', closeToTray: false }))
const env: NodeJS.ProcessEnv = { ...process.env, INKSTONE_MC_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const electron = createRequire(import.meta.url)('electron') as unknown as string
const port = 9500 + Math.floor(Math.random() * 300)
const app = spawn(electron, [resolve(process.env.INKSTONE_MC_TEST_APP ?? '.'), `--remote-debugging-port=${port}`], { env, stdio: 'ignore', windowsHide: false })
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms))
let socket: WebSocket | null = null
for (let i = 0; i < 60; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>
    const page = targets.find((target) => target.type === 'page')
    if (page) { socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise((done, fail) => { socket!.onopen = done; socket!.onerror = fail }); break }
  } catch {}
  await delay(300)
}
if (!socket) { app.kill(); throw new Error('应用没有启动') }
let sequence = 0
const pending = new Map<number, { done(value: any): void; fail(error: Error): void }>()
const errors: unknown[] = []
socket.onmessage = (event) => {
  const value = JSON.parse(String(event.data))
  if (value.method === 'Runtime.exceptionThrown') errors.push(value.params)
  const wait = pending.get(value.id)
  if (wait) { pending.delete(value.id); value.error ? wait.fail(new Error(JSON.stringify(value.error))) : wait.done(value.result) }
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
async function screenshot(name: string): Promise<void> {
  await delay(350)
  const result = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(output, `${name}.png`), Buffer.from(result.data, 'base64'))
}
async function click(text: string): Promise<void> {
  const hit = await evaluate(`(() => { const node = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)}); node?.click(); return !!node })()`)
  if (!hit) throw new Error(`找不到按钮 ${text}`)
}
try {
  await send('Runtime.enable')
  await send('Performance.enable')
  await send('Page.bringToFront')
  await delay(3200)
  await evaluate(`globalThis.draws = 0; globalThis.clearRectOriginal = CanvasRenderingContext2D.prototype.clearRect; CanvasRenderingContext2D.prototype.clearRect = function(...args) { globalThis.draws++; return globalThis.clearRectOriginal.apply(this,args) }`)
  const samples: Record<string, unknown> = {}
  for (const state of ['idle', 'running']) {
    await evaluate(`document.querySelector('.shell').dataset.run = ${JSON.stringify(state)}; globalThis.draws = 0`)
    await delay(2500)
    await evaluate('globalThis.draws = 0')
    const before = (await send('Performance.getMetrics')).metrics.find((m: any) => m.name === 'TaskDuration').value
    await delay(5000)
    const metrics = (await send('Performance.getMetrics')).metrics
    samples[state] = { taskMs: Math.round((metrics.find((m: any) => m.name === 'TaskDuration').value - before) * 1000), heapMb: Math.round(metrics.find((m: any) => m.name === 'JSHeapUsedSize').value / 1048576), ...(await evaluate('({ drawCalls: globalThis.draws, focused: document.hasFocus(), hidden: document.hidden })')) }
  }
  await evaluate(`document.querySelector('.shell').dataset.run = 'idle'`)
  await screenshot('launch-light')
  if (phase !== 'before') {
    await evaluate(`document.querySelector('[aria-label^="管理版本"]')?.click()`)
    // Current launch page uses an explicit version settings tool.
    if (!await evaluate(`!!document.querySelector('.subnav')`)) await evaluate(`document.querySelector('[aria-label="版本设置"]')?.click()`)
    if (!await evaluate(`!!document.querySelector('.subnav')`)) await evaluate(`document.querySelector('.rail__links button')?.click()`)
    await delay(400)
    await click('性能')
    await delay(700)
    await screenshot('performance-light')
    await click('应用建议内存')
    await delay(600)
    await screenshot('performance-applied')
    await click('恢复原内存设置')
    await delay(600)
    const unchanged = await readFile(join(game, 'versions', id, 'options.txt'), 'utf8')
    if (unchanged !== 'renderDistance:24\nsimulationDistance:16\nentityDistanceScaling:1.5\nparticles:0\nfov:0.25\n') throw new Error('性能流程修改了游戏内设置')
    await evaluate(`window.craft.updateSettings({theme:'dark'})`)
    await send('Page.reload')
    await delay(2000)
    if (await evaluate(`document.documentElement.dataset.theme`) !== 'dark') throw new Error('深色主题未生效')
    await screenshot('launch-dark')
    await evaluate(`document.querySelector('[aria-label="版本设置"]')?.click()`)
    await delay(700)
    await click('性能')
    await delay(600)
    await screenshot('performance-dark')
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false })
    await screenshot('performance-900-dark')
    const layout = await evaluate(`(() => { const r = document.querySelector('.performance-apply')?.getBoundingClientRect(); return { overflow: document.documentElement.scrollWidth > innerWidth, bottom: r?.bottom, height: r?.height, viewport: innerHeight } })()`)
    if (layout.overflow || layout.bottom > layout.viewport || layout.height < 66) throw new Error(`性能操作坞布局异常：${JSON.stringify(layout)}`)
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await screenshot('reduced-motion')
    await send('Emulation.clearDeviceMetricsOverride')
    const center = new CrashCenter(join(data, 'crash'))
    const context = await center.begin({ folder: game, versionId: id, loader: 'fabric', gameDir: join(game, 'versions', id), javaPath: null, maxMemoryMb: 4096 })
    await center.finish(context, { exitCode: 1, windowShown: false, launchArgs: [], stopped: false, processLines: ["Incompatible mod set!", "Mod 'Example' (example) requires any version of missinglib, which is missing!"] })
    await send('Page.reload')
    await delay(1800)
    await click('查看原因与修复')
    await screenshot('crash-dark')
    if (await evaluate(`!!document.querySelector('.crash-evidence')`)) throw new Error('崩溃技术细节应默认折叠')
    await click('查看日志证据和相关 Mod')
    await screenshot('crash-evidence-dark')
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false })
    await screenshot('crash-900-dark')
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await click('设置')
    await delay(700)
    await screenshot('settings-900-dark')
    await click('下载')
    await delay(1800)
    await screenshot('download-900-dark')
  }
  const result = { phase, root, samples, errors, output }
  await writeFile(join(output, 'runtime.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  socket.close()
  app.kill()
}
