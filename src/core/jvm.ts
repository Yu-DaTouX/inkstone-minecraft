export interface JvmIssue { level: 'warn' | 'block'; message: string }
export interface JvmPlan {
  args: string[]
  automatic: string[]
  maxMemoryMb: number
  customMemory: boolean
  issues: JvmIssue[]
}

function heapMb(value: string): number | null {
  const match = /^(\d+)([kmgt]?)$/i.exec(value)
  if (!match) return null
  const exponent = { '': -2, k: -1, m: 0, g: 1, t: 2 }[match[2].toLowerCase()] ?? 0
  const mb = Number(match[1]) * 1024 ** exponent
  return Number.isFinite(mb) && mb > 0 ? mb : null
}

/** Keep user parameters intact. Explicit [] also prevents @xmcl/core's fixed
 * 32M G1 regions and 50ms pause target from being added behind the user's back.
 * Modern HotSpot already defaults to G1. Only Java 8 gets an automatic G1
 * selection, and only when the user hasn't selected a collector. */
export function buildJvmPlan(major: number | null, memoryMb: number, custom: string[]): JvmPlan {
  const issues: JvmIssue[] = []
  const collectors = [...new Set(custom.filter((arg) => /^-XX:\+Use(?:G1|Z|Shenandoah|Serial|Parallel|ConcMarkSweep|Epsilon)GC$/.test(arg)))]
  if (collectors.length > 1) issues.push({ level: 'block', message: `同时启用了多个垃圾回收器：${collectors.join(' ')}。在版本 JVM 参数中只保留一种。` })
  if (major !== null && major >= 14 && collectors.includes('-XX:+UseConcMarkSweepGC')) issues.push({ level: 'block', message: `Java ${major} 已不支持 CMS 回收器。移除 -XX:+UseConcMarkSweepGC，或选择适合这个版本的 Java。` })
  if (major !== null && major < 11 && collectors.includes('-XX:+UseZGC')) issues.push({ level: 'block', message: `Java ${major} 不支持 ZGC，请移除 -XX:+UseZGC 或选择适合游戏的 Java。` })
  const automatic = major === 8 && !custom.some((arg) => /^-XX:[+-]Use\w+GC$/.test(arg)) ? ['-XX:+UseG1GC'] : []
  let maximum = memoryMb
  let minimum: number | null = null
  let customMemory = false
  let maxCount = 0
  for (const arg of custom) {
    const max = /^(?:-Xmx|-XX:MaxHeapSize=)(.*)$/i.exec(arg)
    const min = /^(?:-Xms|-XX:InitialHeapSize=)(.*)$/i.exec(arg)
    if (!max && !min) continue
    const value = heapMb((max ?? min)![1])
    if (value === null) { issues.push({ level: 'block', message: `内存参数 ${arg} 格式不正确，例如 -Xmx4G 或 -Xms512M。` }); continue }
    if (max) { maximum = value; customMemory = true; maxCount++ }
    else minimum = value
  }
  if (minimum !== null && minimum > maximum) issues.push({ level: 'block', message: `初始堆内存 ${Math.round(minimum)} MB 超过最大堆内存 ${Math.round(maximum)} MB，请检查 -Xms 与 -Xmx。` })
  if (maxCount > 1) issues.push({ level: 'warn', message: '自定义参数重复指定了最大内存，将按最后一个参数启动；建议在版本设置中只保留一项。' })
  return { args: [...automatic, ...custom], automatic, maxMemoryMb: maximum, customMemory, issues }
}
