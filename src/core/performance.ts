import { createHash } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function recommendedMemory(totalMb: number, freeMb: number, modCount: number): number {
  const desired = modCount > 180 ? 8192 : modCount > 80 ? 6144 : modCount > 20 ? 4096 : 2048
  // Reserve OS/native allocations. This is a starting recommendation, not a
  // guarantee that any particular modpack fits in this heap.
  const budget = Math.min(totalMb * 0.5, Math.max(1024, freeMb - 1536), 12288)
  return Math.max(1024, Math.floor(Math.min(desired, budget) / 512) * 512)
}

interface Backup { previousMemoryMb: number | null; appliedMemoryMb: number }

/** Only launcher instance overrides live here. Never read or write options.txt. */
export class PerformanceStore {
  private readonly busy = new Set<string>()
  private readonly root: string
  constructor(root: string) { this.root = root }
  private file(owner: string): string {
    return join(this.root, `${createHash('sha256').update(owner.toLowerCase()).digest('hex')}.json`)
  }
  async backup(owner: string): Promise<Backup | null> {
    try { return JSON.parse(await readFile(this.file(owner), 'utf8')) as Backup } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('性能恢复记录无法读取，请先检查启动器数据目录')
    }
  }
  async apply(owner: string, memory: number, previousMemory: number | null, saveMemory: (value: number | null) => Promise<unknown>): Promise<void> {
    if (this.busy.has(owner)) throw new Error('正在保存这个版本，请稍后重试')
    this.busy.add(owner)
    try {
      if (await this.backup(owner)) throw new Error('已有一次内存调整，请先恢复，再应用建议')
      await mkdir(this.root, { recursive: true })
      await writeFile(this.file(owner), JSON.stringify({ previousMemoryMb: previousMemory, appliedMemoryMb: memory }), { flag: 'wx' })
      try { await saveMemory(memory) } catch (error) {
        await saveMemory(previousMemory)
        await unlink(this.file(owner))
        throw error
      }
    } finally { this.busy.delete(owner) }
  }
  async restore(owner: string, currentMemory: number | null, saveMemory: (value: number | null) => Promise<unknown>): Promise<boolean> {
    if (this.busy.has(owner)) throw new Error('正在保存这个版本，请稍后重试')
    this.busy.add(owner)
    try {
      const backup = await this.backup(owner)
      if (!backup) throw new Error('没有可恢复的内存调整')
      const retained = currentMemory !== backup.appliedMemoryMb
      if (!retained) await saveMemory(backup.previousMemoryMb)
      await unlink(this.file(owner))
      return retained
    } finally { this.busy.delete(owner) }
  }
}
