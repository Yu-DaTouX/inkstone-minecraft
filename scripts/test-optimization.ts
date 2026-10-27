import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeMods } from '../src/core/mods/analyze.ts'
import { collectDependencyNeeds, installDependencyNeeds, pickVersionForRanges, resolveDependencyNeeds } from '../src/core/mods/deps.ts'
import { normalizeSettings } from '../src/core/settings.ts'
import { CraftService } from '../src/core/service.ts'
import { PerformanceStore, recommendedMemory } from '../src/core/performance.ts'
import { diagnose } from '../src/core/crash/diagnose.ts'
import { buildCrashActions } from '../src/core/crash/actions.ts'
import { preflightLaunch } from '../src/core/crash/preflight.ts'
import type { ModEntry, ModrinthVersion } from '../src/shared/mods-api.ts'
import type { ModrinthClient } from '../src/core/mods/modrinth.ts'
import { storedZip } from './zip-fixture.ts'
import { buildJvmPlan } from '../src/core/jvm.ts'
import { describeLaunchCommand } from '../src/core/launch.ts'
import { describeError } from '../src/shared/errors.ts'
import { ModsManager } from '../src/core/mods/manager.ts'
import { commitModDownloads } from '../src/core/mods/transaction.ts'

let passed = 0
async function test(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  try { await run(); passed++ } catch (error) { console.error(`✗ ${name}`); throw error }
}
const root = await mkdtemp(join(tmpdir(), 'inkstone-optimization-'))
const mod = (patch: Partial<ModEntry>): ModEntry => ({ file: 'test.jar', enabled: true, size: 1, sha1: '', modifiedAt: 1, kind: 'fabric', modId: 'test', name: 'Test', version: '1.0.0', description: null, icon: null, remoteIconUrl: null, projectId: null, mcRange: null, dependencies: [], provides: [], nestedIds: [], issues: [], ...patch })
const jar = (id: string, version: string): Buffer => storedZip({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id, version }) })
const v = (version: string, bytes = jar('lib', version)): ModrinthVersion => ({ id: version, projectId: 'lib', projectTitle: 'Lib', name: version, versionNumber: version, gameVersions: ['1.21.1'], loaders: ['fabric'], publishedAt: '2026-10-01', downloads: 1, file: { url: 'https://test.invalid/lib.jar', fileName: `lib-${version}.jar`, size: bytes.length, sha1: createHash('sha1').update(bytes).digest('hex') }, dependencies: [], existsLocally: false })
const need = { modId: 'lib', ranges: ['>=2.0.0'], requiredBy: ['Consumer'] }

await test('现代 Java 使用自适应默认值，Java 8 只补保守 G1 选择', () => {
  assert.deepEqual(buildJvmPlan(21, 4096, []).args, [])
  assert.deepEqual(buildJvmPlan(25, 4096, []).args, [])
  assert.deepEqual(buildJvmPlan(8, 4096, []).args, ['-XX:+UseG1GC'])
  const user = ['-XX:+UseSerialGC', '-Dtest=a b']
  assert.deepEqual(buildJvmPlan(8, 4096, user).args, user)
  assert.deepEqual(user, ['-XX:+UseSerialGC', '-Dtest=a b'])
})
await test('自定义 Xmx 优先，堆大小矛盾、GC 冲突与过期 CMS 启动前可识别', () => {
  assert.equal(buildJvmPlan(21, 2048, ['-Xmx4G']).maxMemoryMb, 4096)
  assert.equal(buildJvmPlan(21, 2048, ['-Xmx4G']).customMemory, true)
  assert.equal(buildJvmPlan(21, 2048, ['-Xms4G', '-Xmx2G']).issues[0].level, 'block')
  assert.match(buildJvmPlan(21, 2048, ['-XX:+UseG1GC', '-XX:+UseZGC']).issues[0].message, /多个垃圾回收器/)
  assert.match(buildJvmPlan(21, 2048, ['-XX:+UseConcMarkSweepGC']).issues[0].message, /不支持 CMS/)
  assert.match(buildJvmPlan(8, 2048, ['-XX:+UseZGC']).issues[0].message, /不支持 ZGC/)
  assert.equal(buildJvmPlan(21, 2048, ['-Xmxwat']).issues[0].level, 'block')
})
await test('下载报错优先给出动作，详细信息隐藏口令', () => {
  const error = describeError(new Error("Error invoking remote method 'test': Error: HTTP 429 access_token=secret"))
  assert.match(error.title, /限制/)
  assert.match(error.hint, /并发/)
  assert.ok(!error.details?.includes('secret'))
  assert.match(describeError('ENOSPC').hint, /磁盘/)
})

await test('所有消费者的依赖要求取交集，矛盾要求不选版本', () => {
  assert.equal(pickVersionForRanges([v('3.0.0'), v('2.0.0')], ['>=2.0.0', '<3.0.0']).version?.versionNumber, '2.0.0')
  assert.equal(pickVersionForRanges([v('3.0.0'), v('1.0.0')], ['>=3.0.0', '<2.0.0']).version, null)
})
await test('已装前置太旧会报错；停用消费者不要求安装前置', () => {
  const consumer = mod({ dependencies: [{ modId: 'lib', required: true, versionRange: '>=2.0.0', kind: 'depends' }] })
  const result = analyzeMods([consumer, mod({ modId: 'lib' })], { loader: 'fabric', minecraftVersion: '1.21.1' })
  assert.equal(result[0].issues[0]?.kind, 'dependency-version')
  const disabled = { ...consumer, enabled: false }
  assert.deepEqual(collectDependencyNeeds([disabled], ['lib'])[0]?.ranges, [])
  assert.deepEqual(analyzeMods([disabled], { loader: 'fabric', minecraftVersion: '1.21.1' })[0].issues, [])
})
await test('未知版本的内嵌前置和别名不会被误报版本冲突', () => {
  const consumer = mod({ dependencies: [{ modId: 'lib', required: true, versionRange: '>=2.0.0', kind: 'depends' }] })
  assert.deepEqual(analyzeMods([consumer, mod({ modId: 'bundle', nestedIds: ['lib'] })], { loader: 'fabric', minecraftVersion: '1.21.1' })[0].issues, [])
})
await test('解析依赖时再次检查游戏和加载器，不能依赖远端筛选', async () => {
  const client = { versions: async () => [{ ...v('3.0.0'), loaders: ['forge'] }, { ...v('2.0.0'), gameVersions: ['1.20.1'] }] } as unknown as ModrinthClient
  assert.equal((await resolveDependencyNeeds(client, [need], { modsDir: root, loader: 'fabric', minecraftVersion: '1.21.1' }))[0].version, null)
})
await test('不按搜索相关性第一名猜测前置身份', async () => {
  const client = { versions: async (id: string) => id === 'wrong' ? [v('2.0.0')] : [], search: async () => ({ hits: [{ slug: 'unrelated-project', projectId: 'wrong' }] }) } as unknown as ModrinthClient
  assert.equal((await resolveDependencyNeeds(client, [need], { modsDir: root, loader: 'fabric', minecraftVersion: '1.21.1' }))[0].version, null)
})
await test('补依赖先校验真实 jar，替换旧版本并保留回收站', async () => {
  const modsDir = join(root, 'replace', 'mods')
  await mkdir(modsDir, { recursive: true })
  await writeFile(join(modsDir, 'lib-old.jar'), jar('lib', '1.0.0'))
  const bytes = jar('lib', '2.0.0')
  const client = { versions: async () => [v('2.0.0', bytes)] } as unknown as ModrinthClient
  const result = await installDependencyNeeds([need], { modsDir, loader: 'fabric', minecraftVersion: '1.21.1' }, { client, fetchImpl: async () => new Response(bytes) })
  assert.deepEqual(result.installed, ['lib-2.0.0.jar'])
  await assert.rejects(readFile(join(modsDir, 'lib-old.jar')), /ENOENT/)
  assert.deepEqual(await readFile(join(modsDir, 'lib-2.0.0.jar')), bytes)
})
await test('远端版本标题正确但 jar 身份错误时，不修改原文件', async () => {
  const modsDir = join(root, 'wrong-identity', 'mods')
  await mkdir(modsDir, { recursive: true })
  const original = jar('lib', '1.0.0')
  await writeFile(join(modsDir, 'lib-old.jar'), original)
  const bytes = jar('different-mod', '2.0.0')
  const client = { versions: async () => [v('2.0.0', bytes)] } as unknown as ModrinthClient
  await assert.rejects(installDependencyNeeds([need], { modsDir, loader: 'fabric', minecraftVersion: '1.21.1' }, { client, fetchImpl: async () => new Response(bytes) }), /没有声明提供/)
  assert.deepEqual(await readFile(join(modsDir, 'lib-old.jar')), original)
})
await test('远端标题满足范围但 jar 内版本不满足时拒绝安装', async () => {
  const modsDir = join(root, 'wrong-version', 'mods')
  await mkdir(modsDir, { recursive: true })
  const bytes = jar('lib', '1.0.0')
  const client = { versions: async () => [v('2.0.0', bytes)] } as unknown as ModrinthClient
  await assert.rejects(installDependencyNeeds([need], { modsDir, loader: 'fabric', minecraftVersion: '1.21.1' }, { client, fetchImpl: async () => new Response(bytes) }), /文件内版本/)
})
await test('补依赖不重新安装用户已停用的前置', async () => {
  const modsDir = join(root, 'disabled', 'mods')
  await mkdir(modsDir, { recursive: true })
  const bytes = jar('lib', '2.0.0')
  await writeFile(join(modsDir, 'lib.jar.disabled'), bytes)
  const client = { versions: async () => [v('2.0.0', bytes)] } as unknown as ModrinthClient
  let fetched = false
  const result = await installDependencyNeeds([need], { modsDir, loader: 'fabric', minecraftVersion: '1.21.1' }, { client, fetchImpl: async () => { fetched = true; return new Response(bytes) } })
  assert.match(result.failed[0].reason, /已停用/)
  assert.equal(fetched, false)
  assert.deepEqual(await readFile(join(modsDir, 'lib.jar.disabled')), bytes)
})
await test('必需依赖递归展开，环不会重复安装', async () => {
  const make = (id: string, dependencies: ModrinthVersion['dependencies']): ModrinthVersion => {
    const bytes = jar(id, '1.0.0')
    return { ...v('1.0.0', bytes), id, projectId: id, dependencies, file: { ...v('1.0.0', bytes).file, url: `https://test.invalid/${id}.jar`, fileName: `${id}.jar` } }
  }
  const req = (id: string) => ({ projectId: id, versionId: id, fileName: null, kind: 'required' as const })
  const versions = [make('rootmod', [req('middle')]), make('middle', [req('leaf')]), make('leaf', [req('rootmod')])]
  const client = { versionById: async () => versions[0], project: async () => null, byHashes: async () => new Map(), versionsByIds: async (ids: string[]) => versions.filter((version) => ids.includes(version.id)) } as unknown as ModrinthClient
  const manager = new ModsManager({ dataDir: join(root, 'recursive-data'), client, fetchImpl: async (url) => new Response(jar(String(url).split('/').pop()!.replace('.jar', ''), '1.0.0')) })
  const result = await manager.install({ folder: root, versionId: 'test', gameDir: join(root, 'recursive-game'), loader: 'fabric', minecraftVersion: '1.21.1' }, 'rootmod')
  assert.deepEqual(result.installed.sort(), ['leaf.jar', 'middle.jar', 'rootmod.jar'])
})
await test('同一前置的精确版本互相矛盾时，在写文件前停止', async () => {
  const rootVersion = { ...v('root'), projectId: 'root', dependencies: [{ projectId: 'lib', versionId: '2.0.0', fileName: null, kind: 'required' as const }, { projectId: 'lib', versionId: '3.0.0', fileName: null, kind: 'required' as const }] }
  let fetched = false
  const client = { versionById: async () => rootVersion, project: async () => null, byHashes: async () => new Map(), versionsByIds: async () => [v('2.0.0'), v('3.0.0')] } as unknown as ModrinthClient
  const manager = new ModsManager({ dataDir: join(root, 'exact-conflict-data'), client, fetchImpl: async () => { fetched = true; return new Response('unexpected') } })
  await assert.rejects(manager.install({ folder: root, versionId: 'test', gameDir: join(root, 'exact-conflict-game'), loader: 'fabric', minecraftVersion: '1.21.1' }, 'root'), /不同版本|版本冲突/)
  assert.equal(fetched, false)
})
await test('系统内存不足优先于 heap，修复建议降低而非调高', () => {
  const text = 'java.lang.OutOfMemoryError: unable to create native thread\nNative memory allocation (malloc) failed'
  const result = diagnose({ text, loader: 'fabric', mods: [], sources: [{ source: 'hs_err', text }] })
  assert.equal(result.rule?.id, 'native-memory')
  const actions = buildCrashActions({ rule: result.rule, suspects: [], missing: [], names: new Map(), javas: [], javaPath: null, requiredMajor: 21, maxMemoryMb: 8192, totalMemMb: 16384 })
  assert.ok(Number(actions.find((action) => action.kind === 'memory')?.value) < 8192)
})
await test('依赖错误优先于 Forge 包装异常，已停用 Mod 和 INFO 清单不进嫌疑列表', () => {
  const text = 'net.minecraftforge.fml.loading.EarlyLoadingException: FMLLoadingException\nMissing or unsupported mandatory dependencies\nMod ID: \'lib\', Requested by: \'consumer\'\n[main/INFO]: test loaded successfully'
  const result = diagnose({ text, loader: 'forge', mods: [{ fileName: 'test.jar', path: '', modId: 'test', name: 'Test', version: '1', depends: {}, mixins: [], packages: [], enabled: true }], sources: [{ source: 'process', text }] })
  assert.equal(result.rule?.id, 'missing-dependency')
  assert.deepEqual(result.suspects, [])
})
await test('内存建议考虑可用内存和 Mod 数量', () => {
  assert.equal(recommendedMemory(32768, 18000, 200), 8192)
  assert.equal(recommendedMemory(8192, 3000, 200), 1024)
  assert.equal(recommendedMemory(16384, 10000, 0), 2048)
})
await test('性能内存调整按版本隔离，可以恢复并保留后来的手动修改', async () => {
  const store = new PerformanceStore(join(root, 'performance-backup'))
  let memory: number | null = null
  const save = async (value: number | null): Promise<void> => { memory = value }
  await store.apply('owner-A', 2048, memory, save)
  assert.equal(memory, 2048)
  await assert.rejects(store.restore('owner-B', memory, save), /没有可恢复/)
  assert.equal(await store.restore('owner-A', memory, save), false)
  assert.equal(memory, null)
  assert.equal(await store.backup('owner-A'), null)
  await store.apply('owner-A', 2048, null, save)
  memory = 3072
  assert.equal(await store.restore('owner-A', memory, save), true)
  assert.equal(memory, 3072)
})
await test('性能保存失败时回滚内存，不留下已成功的恢复记录', async () => {
  const store = new PerformanceStore(join(root, 'rollback-backup'))
  await assert.rejects(store.apply('owner', 2048, null, async (value) => { if (value !== null) throw new Error('memory write failed') }), /memory write failed/)
  assert.equal(await store.backup('owner'), null)
})
await test('崩溃内存修复写入单版本覆盖，全局值保留', async () => {
  const game = join(root, 'service-game')
  const id = '1.21.1'
  await mkdir(join(game, 'versions', id), { recursive: true })
  await writeFile(join(game, 'versions', id, `${id}.json`), JSON.stringify({ id, mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: { game: [] } }))
  const args = await describeLaunchCommand({ folder: game, versionId: id, username: 'Test', javaPath: 'java21', javaMajor: 21, gameDir: game, maxMemoryMb: 2048, nativeRoot: root })
  assert.ok(!args.some((arg) => /G1HeapRegionSize|MaxGCPauseMillis|UnlockExperimentalVMOptions/.test(arg)))
  const customArgs = await describeLaunchCommand({ folder: game, versionId: id, username: 'Test', javaPath: 'java21', javaMajor: 21, gameDir: game, maxMemoryMb: 2048, nativeRoot: root, jvmArgs: '-Xmx4G -XX:+UseZGC' })
  assert.deepEqual(customArgs.filter((arg) => arg.startsWith('-Xmx')), ['-Xmx4G'])
  assert.ok(customArgs.includes('-XX:+UseZGC'))
  const service = new CraftService({ dataDir: join(root, 'service-data') })
  await service.updateSettings({ folders: [{ name: 'Test', path: game }], maxMemoryMb: 4096 })
  const result = await service.crashAction({ folder: game, versionId: id, diagnosisId: 'missing', kind: 'memory', value: '2048' })
  assert.equal(result.ok, true)
  assert.equal((await service.settings()).maxMemoryMb, 4096)
  assert.equal((await service.instanceSettings.get(game, id)).maxMemoryMb, 2048)
  const options = 'renderDistance:24\r\nsimulationDistance:16\r\nparticles:0\r\nfov:0.5\r\n'
  await writeFile(join(game, 'options.txt'), options)
  await service.performance(game, id)
  await service.applyPerformance(game, id)
  await service.restorePerformance(game, id)
  assert.equal(await readFile(join(game, 'options.txt'), 'utf8'), options, '性能流程必须保持游戏内设置原样')
  await service.instanceSettings.patch(game, id, { jvmArgs: '-Xmx4G' })
  await assert.rejects(service.applyPerformance(game, id), /自定义 JVM 参数/)
  const protectedMemory = await service.crashAction({ folder: game, versionId: id, diagnosisId: 'missing', kind: 'memory', value: '3072' })
  assert.equal(protectedMemory.ok, false)
  assert.equal((await service.instanceSettings.get(game, id)).jvmArgs, '-Xmx4G')
  const task = service.tasks.start('mod-update', 'Test update', `${game}|${id}`)
  await assert.rejects(service.launch({ folder: game, versionId: id }), /正在安装、更新或修复/)
  await assert.rejects(service.modRemove(game, id, 'missing.jar'), /正在执行其他任务/)
  await assert.rejects(service.renameInstance(game, id, 'should-not-rename'), /正在安装、更新或清理/)
  await assert.rejects(service.copyInstance(game, id, 'should-not-copy'), /正在安装、更新或清理/)
  await assert.rejects(service.deleteInstance(game, id), /正在安装、更新或清理/)
  service.tasks.cancel(task.id)
  await assert.rejects(service.launch({ folder: game, versionId: id }), /正在安装、更新或修复/)
  task.fail(new Error('cancelled'))
  const sharedTask = service.tasks.start('mod-update', 'Shared directory update', `${game}|other`, [game])
  const sharedLaunch = await service.launch({ folder: game, versionId: id })
  assert.equal(sharedLaunch.state, 'failed')
  assert.match(sharedLaunch.error ?? '', /正在修改 Mod/)
  sharedTask.succeed()
  const internal = service as unknown as { current: { state: string }; activeGameDir: string | null }
  const previous = internal.current
  internal.current = { state: 'running' }; internal.activeGameDir = game
  await assert.rejects(service.modRemove(game, id, 'missing.jar'), /游戏正在使用这个 Mod 目录/)
  internal.current = previous; internal.activeGameDir = null
})
await test('预检复用 Mod 分析，已装前置过旧会在启动前提示', async () => {
  const entries = analyzeMods([mod({ dependencies: [{ modId: 'lib', required: true, versionRange: '>=2.0.0', kind: 'depends' }] }), mod({ modId: 'lib' })], { loader: 'fabric', minecraftVersion: '1.21.1' })
  const report = await preflightLaunch({ versionId: 'test', loader: 'fabric', instance: { id: 'test', folder: root, minecraftVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.10', javaMajor: 21, isolated: true, gameDir: root, modCount: 2, preferredJava: null, error: null }, javas: [{ path: 'java21', version: '21', majorVersion: 21 }], javaPath: 'java21', accountName: 'Tester', maxMemoryMb: 2048, totalMemMb: 16384, modsDir: root, missingFiles: 0, modEntries: entries })
  assert.match(report.items.find((item) => item.id === 'compatibility')?.detail ?? '', /已安装 1\.0\.0/)
})
await test('旧配置即使打开内存整理，也不会再操作其他进程', () => assert.equal(normalizeSettings({ cleanMemoryOnLaunch: true }).cleanMemoryOnLaunch, false))
await test('批量 Mod 下载失败保留整套旧文件，并清理暂存', async () => {
  const game = join(root, 'transaction-download')
  await mkdir(join(game, 'mods'), { recursive: true })
  await writeFile(join(game, 'mods', 'old.jar'), 'old')
  const bytes = jar('lib', '2.0.0')
  const file = (name: string) => ({ file: name, url: `https://test.invalid/${name}`, sha1: createHash('sha1').update(bytes).digest('hex'), size: bytes.length })
  await assert.rejects(commitModDownloads(game, 'test', [{ ...file('a.jar'), replaces: ['old.jar'] }, file('b.jar')], { retries: 0, fetchImpl: (async (input) => String(input).endsWith('/b.jar') ? new Response(null, { status: 500 }) : new Response(bytes)) as typeof fetch }))
  assert.deepEqual(await readdir(join(game, 'mods')), ['old.jar'])
  assert.equal(await readFile(join(game, 'mods', 'old.jar'), 'utf8'), 'old')
})
await test('提交中出现同名文件时回滚所有替换，保留用户刚创建的文件', async () => {
  const game = join(root, 'transaction-commit')
  const dir = join(game, 'mods')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'old-a.jar'), 'old-a')
  await writeFile(join(dir, 'old-b.jar'), 'old-b')
  const bytes = jar('lib', '2.0.0')
  const file = (name: string, old: string) => ({ file: name, url: `https://test.invalid/${name}`, sha1: createHash('sha1').update(bytes).digest('hex'), size: bytes.length, replaces: [old] })
  const fetchImpl = (async () => { await writeFile(join(dir, 'new-b.jar'), 'user-file'); return new Response(bytes) }) as typeof fetch
  await assert.rejects(commitModDownloads(game, 'test', [file('new-a.jar', 'old-a.jar'), file('new-b.jar', 'old-b.jar')], { retries: 0, fetchImpl }))
  assert.deepEqual((await readdir(dir)).sort(), ['new-b.jar', 'old-a.jar', 'old-b.jar'])
  assert.equal(await readFile(join(dir, 'new-b.jar'), 'utf8'), 'user-file')
  assert.equal(await readFile(join(dir, 'old-a.jar'), 'utf8'), 'old-a')
  assert.equal(await readFile(join(dir, 'old-b.jar'), 'utf8'), 'old-b')
})
await test('批量更新拒绝路径逃逸与重复目标，取消时不改原文件', async () => {
  const game = join(root, 'transaction-cancel')
  const file = { file: '../outside.jar', url: 'https://test.invalid/a', sha1: '', size: 0 }
  await assert.rejects(commitModDownloads(game, 'test', [file], {}), /无效/)
  await assert.rejects(commitModDownloads(game, 'test', [{ ...file, file: 'a.jar' }, { ...file, file: 'A.jar' }], {}), /重复文件/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(commitModDownloads(game, 'test', [{ ...file, file: 'a.jar' }], { signal: abort.signal }))
  assert.deepEqual(await readdir(join(game, 'mods')), [])
})
await test('启动锁在第一个异步操作前生效，准备期间取消不会启动进程', async () => {
  const game = join(root, 'launch-lock')
  await mkdir(join(game, 'versions', 'test'), { recursive: true })
  await writeFile(join(game, 'versions', 'test', 'test.json'), JSON.stringify({ id: 'test', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: { game: [] } }))
  const service = new CraftService({ dataDir: join(root, 'launch-lock-data') })
  const first = service.launch({ folder: game, versionId: 'test' })
  await assert.rejects(service.launch({ folder: game, versionId: 'test' }), /已有游戏/)
  await service.stop()
  const final = await first
  assert.equal(final.state, 'exited')
  assert.equal(final.pid, null)
  service.dispose()
})
console.log(`optimization: ${passed} 项通过；隔离测试目录 ${root}`)
