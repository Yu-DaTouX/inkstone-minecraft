import { mkdir, writeFile, access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { installVanilla } from '../src/core/install/vanilla.ts'
import { installFabric, installQuilt } from '../src/core/install/loaders.ts'
import { installForge } from '../src/core/install/forge.ts'
import { installNeoForge } from '../src/core/install/neoforge.ts'
import { CraftService } from '../src/core/service.ts'
import { detectJava, pickJava } from '../src/core/java.ts'
import type { LaunchStatus } from '../src/shared/api.ts'

// Only this test's own installations, profiles and processes are used.
const root = resolve('.tmp/optimization-real-game')
const folder = join(root, 'game')
const evidence = resolve('.local-docs/checks/2026-10-25-matrix')
await mkdir(evidence, { recursive: true })
const javas = await detectJava()
const cases = [
  { mc: '1.12.2', loader: 'vanilla', java: 8 },
  { mc: '1.16.5', loader: 'vanilla', java: 8 },
  { mc: '1.21.1', loader: 'vanilla', java: 21 },
  { mc: '26.3', loader: 'vanilla', java: 25 },
  { mc: '1.21.1', loader: 'fabric', java: 21 },
  { mc: '1.21.1', loader: 'quilt', java: 21 },
  { mc: '1.12.2', loader: 'forge', java: 8 },
  { mc: '1.21.1', loader: 'neoforge', java: 21 }
]
const results: unknown[] = []
for (const item of cases.filter((item) => !process.argv[2] || `${item.mc}-${item.loader}`.includes(process.argv[2]))) {
  const name = `${item.mc}-${item.loader}-delivery`
  const java = pickJava(javas, item.java)
  if (!java || java.majorVersion !== item.java) throw new Error(`Missing Java ${item.java}`)
  let lastProgress = 0
  const shared = { folder, name, isolated: true, source: 'official' as const, concurrency: 16,
    onProgress: (_progress: unknown, detail?: string) => { if (Date.now() - lastProgress > 10000) { lastProgress = Date.now(); console.log(JSON.stringify({ name, phase: 'install', detail })) } }
  }
  const lines: string[] = []
  const service = new CraftService({ dataDir: join(root, `data-${name}`) })
  let ready = false
  let pid: number | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let hold: ReturnType<typeof setTimeout> | undefined
  const started = Date.now()
  try {
    let installed = true
    try { await access(join(folder, 'versions', name, `${name}.json`)) } catch { installed = false }
    if (!installed) {
      if (item.loader === 'vanilla') await installVanilla({ ...shared, version: item.mc })
      else if (item.loader === 'fabric') await installFabric({ ...shared, version: item.mc, companions: false })
      else if (item.loader === 'quilt') await installQuilt({ ...shared, version: item.mc, companions: false })
      else if (item.loader === 'forge') await installForge({ ...shared, minecraft: item.mc, installerJavaPaths: javas.map((j) => j.path) })
      else await installNeoForge({ ...shared, minecraft: item.mc, installerJavaPaths: javas.map((j) => j.path) })
    }
    await service.updateSettings({ folders: [{ name: 'Delivery matrix', path: folder }], selectedFolder: folder, selectedVersion: name })
    const cancelledLaunch = service.launch({ folder, versionId: name, username: 'InkstoneTest', javaPath: java.path, maxMemoryMb: 2048 })
    let duplicateBlocked = false
    try { await service.launch({ folder, versionId: name, username: 'InkstoneTest', javaPath: java.path }) } catch { duplicateBlocked = true }
    await service.stop()
    const cancelled = await cancelledLaunch
    if (cancelled.state !== 'exited' || cancelled.pid || !duplicateBlocked) throw new Error('准备阶段取消或重复启动保护失败')
    const done = new Promise<LaunchStatus>((finish) => {
      timer = setTimeout(() => { lines.push('TEST_TIMEOUT'); void service.stop() }, 180000)
      service.on('log', (line) => {
        lines.push(`[${line.stream}] ${line.text}`)
        if (!ready && /Sound engine started|Created: \d+x\d+|OpenAL initialized/.test(line.text)) {
          ready = true
          console.log(JSON.stringify({ name, phase: 'ready', pid, holdMs: 15000 }))
          hold = setTimeout(() => void service.stop(), 15000)
        }
      })
      service.on('status', (status: LaunchStatus) => { if (status.state === 'failed' || status.state === 'exited') finish(status) })
    })
    const launch = await service.launch({ folder, versionId: name, username: 'InkstoneTest', javaPath: java.path, maxMemoryMb: 2048 })
    pid = launch.pid
    const final = await done
    let alive = false
    if (pid) { try { process.kill(pid, 0); alive = true } catch {} }
    const version = JSON.parse(await readFile(join(folder, 'versions', name, `${name}.json`), 'utf8'))
    const result = { name, mc: item.mc, loader: item.loader, java: java.version, ready, pid, aliveAfterStop: alive, duplicateBlocked, cancelBeforeSpawn: cancelled.state, final, durationMs: Date.now() - started, mainClass: version.mainClass }
    results.push(result)
    console.log(JSON.stringify(result))
    if (!ready || alive) process.exitCode = 1
  } catch (error) {
    const result = { name, ready, error: String(error), durationMs: Date.now() - started }
    results.push(result); console.log(JSON.stringify(result)); process.exitCode = 1
  } finally {
    clearTimeout(timer); clearTimeout(hold)
    await service.stop()
    service.dispose()
    await writeFile(join(evidence, `${name}.log`), lines.join('\n'))
    await writeFile(join(evidence, `${name}.json`), JSON.stringify(results.at(-1), null, 2))
  }
}
await writeFile(join(evidence, `summary${process.argv[2] ? `-${process.argv[2]}` : ''}.json`), JSON.stringify(results, null, 2))
