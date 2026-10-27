import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { constants } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { downloadFiles, type DownloadOptions } from '../download/download.ts'
import { moveToTrash, restoreFromTrash } from './trash.ts'

export interface ModDownload {
  file: string
  url: string
  sha1: string
  size: number
  replaces?: string[]
}

function checkName(file: string): void {
  if (basename(file) !== file || /[\\/:]/.test(file) || !file.toLowerCase().endsWith('.jar')) throw new Error('下载来源返回了无效的 Mod 文件名')
}

/** Download the whole operation before changing active mods; roll back on failure. */
export async function commitModDownloads(gameDir: string, versionId: string, plan: ModDownload[], options: DownloadOptions): Promise<void> {
  const dir = join(gameDir, 'mods')
  await mkdir(dir, { recursive: true })
  const targets = new Set<string>()
  const oldFiles = new Set<string>()
  for (const item of plan) {
    checkName(item.file)
    if (targets.has(item.file.toLowerCase())) throw new Error(`下载计划有重复文件 ${item.file}，已保留原文件`)
    targets.add(item.file.toLowerCase())
    for (const file of item.replaces ?? []) {
      checkName(file)
      if (oldFiles.has(file.toLowerCase())) throw new Error(`更新计划重复替换 ${file}，已保留原文件`)
      oldFiles.add(file.toLowerCase())
    }
    if (existsSync(join(dir, item.file)) && !(item.replaces ?? []).some((file) => file.toLowerCase() === item.file.toLowerCase())) throw new Error(`${item.file} 已有同名文件，已停止安装并保留原文件`)
  }
  // One update must never silently replace the target of another update.
  for (const item of plan) for (const file of item.replaces ?? []) {
    if (targets.has(file.toLowerCase()) && file.toLowerCase() !== item.file.toLowerCase()) throw new Error(`更新文件名冲突：${file}，已保留原文件`)
  }
  const staged = plan.map((item) => ({ ...item, dest: join(dir, `.${randomUUID()}.download`) }))
  const committed: string[] = []
  const trashed: string[] = []
  try {
    await downloadFiles(staged.map((item) => ({ url: item.url, dest: item.dest, sha1: item.sha1, size: item.size })), options)
    options.signal?.throwIfAborted()
    for (const item of staged) {
      options.signal?.throwIfAborted()
      for (const file of item.replaces ?? []) {
        const record = await moveToTrash(gameDir, versionId, file)
        trashed.push(record.id)
      }
      // Exclusive copy also works on removable filesystems without hard links.
      const target = join(dir, item.file)
      await copyFile(item.dest, target, constants.COPYFILE_EXCL)
      committed.push(target)
    }
    options.signal?.throwIfAborted()
  } catch (error) {
    const failures: unknown[] = []
    for (const file of committed.reverse()) await rm(file, { force: true }).catch((e) => failures.push(e))
    for (const id of trashed.reverse()) await restoreFromTrash(gameDir, id).catch((e) => failures.push(e))
    if (failures.length) throw new AggregateError([error, ...failures], '安装失败，部分原文件保留在 Mod 回收站，请先恢复后再重试')
    throw error
  } finally {
    await Promise.all(staged.map((item) => rm(item.dest, { force: true })))
  }
}
