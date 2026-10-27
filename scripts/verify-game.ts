import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { installVanilla } from '../src/core/install/vanilla.ts'
import { quickCheck } from '../src/core/install/repair.ts'
import { CraftService } from '../src/core/service.ts'
import { describeLaunchCommand } from '../src/core/launch.ts'
import type { LaunchStatus } from '../src/shared/api.ts'

// Fresh test installation only. No user game directories or OS settings.
const root = resolve('.tmp', 'optimization-real-game')
const folder = join(root, 'game')
const versionId = '1.21.1'
await mkdir(folder, { recursive: true })
if ((await quickCheck({ folder, name: versionId }).catch(() => ({ missing: -1 }))).missing !== 0) {
  let at = 0
  await installVanilla({ folder, version: versionId, name: versionId, isolated: true, source: 'official', concurrency: 16,
    onProgress: (progress, detail) => { if (Date.now() - at > 5000) { at = Date.now(); console.log(JSON.stringify({ phase: 'install', ...progress, detail })) } }
  })
}
const service = new CraftService({ dataDir: join(root, 'data') })
await service.updateSettings({ folders: [{ name: '隔离游戏验证', path: folder }], selectedFolder: folder, selectedVersion: versionId })
const java = (await service.javas()).find((item) => item.majorVersion === 21)
if (!java) throw new Error('测试需要已安装的 Java 21')
const command = await describeLaunchCommand({ folder, versionId, username: 'InkstoneTest', javaPath: java.path, javaMajor: java.majorVersion, gameDir: join(folder, 'versions', versionId), nativeRoot: join(root, 'natives'), maxMemoryMb: 2048 })
console.log(JSON.stringify({ phase: 'jvm', args: command.filter((arg) => /^-X(?:X|m)/.test(arg)) }))
let ready = false
const done = new Promise<LaunchStatus>((finish) => {
  const timer = setTimeout(() => { console.log('游戏验证超时'); void service.stop() }, 150000)
  service.on('log', (line) => {
    if (line.stream === 'launcher') console.log(line.text)
    if (!ready && /Sound engine started|Created: \d+x\d+/.test(line.text)) {
      ready = true
      console.log('REAL_GAME_READY')
      setTimeout(() => void service.stop(), Number(process.argv[2]) || 45000)
    }
  })
  service.on('status', (status: LaunchStatus) => {
    if (status.state === 'failed' || status.state === 'exited') { clearTimeout(timer); finish(status) }
  })
})
const start = await service.launch({ folder, versionId, username: 'InkstoneTest', javaPath: java.path, maxMemoryMb: 2048 })
if (start.state === 'failed') throw new Error(start.error ?? '启动失败')
const final = await done
const result = { ready, state: final.state, exitCode: final.exitCode, error: final.error, root }
await mkdir(resolve('.local-docs', 'checks'), { recursive: true })
await writeFile(resolve('.local-docs', 'checks', '2026-10-25-real-game.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
process.exitCode = ready ? 0 : 1
