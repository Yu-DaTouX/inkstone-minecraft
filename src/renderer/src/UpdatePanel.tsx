import { useEffect, useState, type ReactElement } from 'react'
import { ArrowUpCircle, RefreshCw } from 'lucide-react'
import type { UpdateStatus } from '../../shared/api.ts'
import { Button } from './ui/Button'
import { ProgressBar } from './ui/Progress'
import { SettingRow, SettingSection } from './ui/SettingRow'

export function useUpdate(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    let alive = true
    void window.craft.updateStatus().then((value) => alive && setStatus(value))
    const off = window.craft.onUpdate(setStatus)
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}

function describe(status: UpdateStatus): string {
  switch (status.state) {
    case 'dev':
      return '开发版不检查更新。'
    case 'checking':
      return '正在检查…'
    case 'latest':
      return '已经是最新版本。'
    case 'downloading':
      return `发现 ${status.version}，正在后台下载${status.progress != null ? `（${status.progress}%）` : ''}。`
    case 'ready':
      return `${status.version} 已下载好。重启启动器就会装上；不重启的话，下次退出时自动安装。`
    case 'error':
      return `检查失败：${status.error ?? '未知错误'}`
    default:
      return '启动后会自动检查，之后每 6 小时检查一次。'
  }
}

/** 设置 → 关于 里的「更新」小节 */
export function UpdateSection(): ReactElement {
  const status = useUpdate()
  const [busy, setBusy] = useState(false)
  if (!status) return <SettingSection title="更新" />
  const check = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.craft.checkUpdate()
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingSection title="更新">
      <SettingRow label={`当前版本 ${status.current}`} description={describe(status)}>
        {status.state === 'ready' ? (
          <Button variant="primary" icon={<ArrowUpCircle size={18} />} onPress={() => void window.craft.installUpdate()}>
            重启并更新
          </Button>
        ) : status.state !== 'dev' ? (
          <Button icon={<RefreshCw size={18} />} isDisabled={busy || status.state === 'checking' || status.state === 'downloading'} onPress={() => void check()}>
            检查更新
          </Button>
        ) : null}
      </SettingRow>
      {status.state === 'downloading' ? (
        <SettingRow label="下载进度" block>
          <ProgressBar aria-label="更新下载进度" value={status.progress ?? 0} showValue tone="run" />
        </SettingRow>
      ) : null}
    </SettingSection>
  )
}

/** 顶栏：新版本下好了才出现 */
export function UpdateBadge(): ReactElement | null {
  const status = useUpdate()
  if (status?.state !== 'ready') return null
  return (
    <Button size="sm" variant="primary" icon={<ArrowUpCircle size={18} />} className="update-badge" onPress={() => void window.craft.installUpdate()}>
      重启更新到 {status.version}
    </Button>
  )
}
