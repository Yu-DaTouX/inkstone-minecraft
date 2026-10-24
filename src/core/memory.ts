import { execFile } from 'node:child_process'
import { freemem } from 'node:os'
import { basename } from 'node:path'

export interface TrimResult {
  /** 成功整理的进程数 */
  processes: number
  /** 可用内存变化，MB；可能是 0 */
  freedMb: number
}

// 对当前用户能打开的进程调用 EmptyWorkingSet，把不常用的页挪出物理内存，给游戏腾地方。
// 跳过启动器自己，免得启动动画卡顿。没有管理员权限时系统进程会打不开，直接跳过。
function script(skip: string): string {
  return `$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class InkTrim { [DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr h); }'
$n=0
foreach($p in [System.Diagnostics.Process]::GetProcesses()){
  if($p.Id -le 4 -or $p.ProcessName -eq '${skip.replace(/'/g, "''")}'){ continue }
  try { if([InkTrim]::EmptyWorkingSet($p.Handle)){ $n++ } } catch {}
}
$n`
}

export function trimMemory(timeoutMs = 6000): Promise<TrimResult | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const before = freemem()
  const skip = basename(process.execPath).replace(/\.exe$/i, '')
  const encoded = Buffer.from(script(skip), 'utf16le').toString('base64')
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout: timeoutMs }, (error, stdout) => {
      if (error) return resolve(null)
      const processes = Number.parseInt(String(stdout).trim().split(/\s+/).pop() ?? '', 10)
      resolve({ processes: Number.isFinite(processes) ? processes : 0, freedMb: Math.max(0, Math.round((freemem() - before) / 1024 / 1024)) })
    })
  })
}
