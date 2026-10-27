export function errorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').replace(/^Error: /, '')
}

export function describeError(cause: unknown): { title: string; hint: string; details: string | null } {
  const message = errorText(cause)
  const details = message.replace(/((?:access[_-]?token|refresh[_-]?token|authorization|password)[=:]\s*)[^\s&]+/gi, '$1[已隐藏]')
  const matched = (title: string, hint: string) => ({ title, hint, details })
  if (/HTTP\s*429|Too Many Requests/i.test(message)) return matched('下载来源暂时限制了请求', '稍等片刻再重试，或在下载设置中降低并发数。')
  if (/HTTP\s*404/i.test(message)) return matched('下载来源中找不到这个文件', '刷新版本列表后重新选择；文件可能已经被作者移除。')
  if (/HTTP\s*5\d\d/i.test(message)) return matched('下载服务暂时不可用', '稍后重试；下载游戏文件时也可以在设置中切换下载源。')
  if (/ENOSPC|No space left|磁盘空间不足/i.test(message)) return matched('磁盘剩余空间不足', '释放游戏所在磁盘的空间，然后重试。')
  if (/EACCES|EPERM|AccessDenied|拒绝访问/i.test(message)) return matched('文件被占用或没有写入权限', '先关闭正在使用这个文件的游戏或程序，再重试。')
  if (/sha1|hash mismatch|校验.*(?:失败|不符)|摘要不匹配/i.test(message)) return matched('下载的文件未通过校验', '重新下载这个文件，或切换下载源后重试；未通过校验的文件不会用于启动。')
  if (/fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|timeout|timed out|TimeoutError|网络.*超时/i.test(message)) return matched('连接下载来源失败', '检查网络连接后重试；游戏文件可以在设置中切换官方源或镜像。')
  return { title: message, hint: '', details: null }
}
