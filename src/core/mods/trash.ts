import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ModTrashEntry } from '../../shared/mods-api.ts'
import { modsDir } from './scan.ts'

export const TRASH_DIR = '.trash'

interface TrashMeta {
  id: string
  name: string
  file: string
  size: number
  deletedAt: number
  versionId: string
}

export function trashRoot(gameDir: string): string {
  return join(gameDir, TRASH_DIR)
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch {
    await copyFile(from, to)
    await rm(from, { force: true })
  }
}

export async function moveToTrash(gameDir: string, versionId: string, file: string): Promise<ModTrashEntry> {
  if (basename(file) !== file || /[\\/:]/.test(file) || !/\.jar(\.disabled)?$/i.test(file)) throw new Error('Mod 文件名不合法')
  const source = join(modsDir(gameDir), file)
  const info = await stat(source)
  const id = `${Date.now()}-${randomBytes(3).toString('hex')}`
  const targetDir = join(trashRoot(gameDir), id)
  await mkdir(targetDir, { recursive: true })
  const meta: TrashMeta = { id, name: file.replace(/\.jar(\.disabled)?$/i, ''), file, size: info.size, deletedAt: Date.now(), versionId }
  await writeFile(join(targetDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  try {
    await moveFile(source, join(targetDir, file))
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true })
    throw error
  }
  return { id: meta.id, name: meta.name, file: meta.file, size: meta.size, deletedAt: meta.deletedAt, versionId: meta.versionId }
}

export async function listTrash(gameDir: string): Promise<ModTrashEntry[]> {
  let names: string[]
  try {
    names = await readdir(trashRoot(gameDir))
  } catch {
    return []
  }
  const entries: ModTrashEntry[] = []
  for (const name of names) {
    let meta: TrashMeta
    try {
      meta = JSON.parse(await readFile(join(trashRoot(gameDir), name, 'meta.json'), 'utf8')) as TrashMeta
    } catch {
      continue
    }
    if (!meta || typeof meta.file !== 'string') continue
    const size = await stat(join(trashRoot(gameDir), name, meta.file)).then((info) => info.size, () => meta.size ?? 0)
    entries.push({ id: name, name: meta.name ?? meta.file, file: meta.file, size, deletedAt: meta.deletedAt ?? 0, versionId: meta.versionId ?? '' })
  }
  return entries.sort((a, b) => b.deletedAt - a.deletedAt)
}

export async function restoreFromTrash(gameDir: string, id: string): Promise<string> {
  if (!/^[0-9]+-[0-9a-f]{6}$/.test(id)) throw new Error('回收站记录不合法')
  const dir = join(trashRoot(gameDir), id)
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as TrashMeta
  if (!meta?.file) throw new Error('回收站记录缺少文件名')
  if (basename(meta.file) !== meta.file || /[\\/:]/.test(meta.file) || !/\.jar(\.disabled)?$/i.test(meta.file)) throw new Error('回收站文件名不合法')
  const target = join(modsDir(gameDir), meta.file)
  const exists = await stat(target).then(() => true, () => false)
  if (exists) throw new Error(`mods 里已经有同名文件 ${meta.file}`)
  await mkdir(modsDir(gameDir), { recursive: true })
  await moveFile(join(dir, meta.file), target)
  await rm(dir, { recursive: true, force: true })
  return meta.file
}

export async function purgeTrash(gameDir: string, id: string): Promise<void> {
  if (!/^[0-9]+-[0-9a-f]{6}$/.test(id)) throw new Error('回收站记录不合法')
  await rm(join(trashRoot(gameDir), id), { recursive: true, force: true })
}
