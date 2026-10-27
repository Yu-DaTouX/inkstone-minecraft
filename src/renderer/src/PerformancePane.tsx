import { useEffect, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Gauge, RefreshCw, RotateCcw } from 'lucide-react'
import type { PerformanceReport } from '../../shared/performance-api.ts'
import { Button } from './ui/Button'
import { Notice } from './ui/Notice'
import { SettingRow, SettingSection } from './ui/SettingRow'
import { PageHead } from './SubNavLayout'
import { cleanError } from './ModList'
import { memoryLabel } from './labels'

export function PerformancePane({ folder, versionId, onChanged, footer }: { folder: string; versionId: string; onChanged(): void; footer: HTMLDivElement | null }): ReactElement {
  const [report, setReport] = useState<PerformanceReport | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let alive = true
    setReport(null); setError('')
    void window.craft.performance(folder, versionId).then((value) => { if (alive) setReport(value) }, (cause) => { if (alive) setError(cleanError(cause)) })
    return () => { alive = false }
  }, [folder, versionId, revision])
  const apply = async (restore = false): Promise<void> => {
    setBusy(true); setNotice(''); setError('')
    try {
      const result = restore ? await window.craft.restorePerformance(folder, versionId) : await window.craft.applyPerformance(folder, versionId)
      setReport(result.report); setNotice(result.message); onChanged()
    } catch (cause) { setError(cleanError(cause)) } finally { setBusy(false) }
  }
  return <>
    <PageHead title="性能" description="查看这个版本的 Java 运行参数与内存。不改变游戏内设置或 Mod。" actions={<Button icon={<RefreshCw size={18} />} isDisabled={busy} onPress={() => setRevision((value) => value + 1)}>刷新</Button>} />
    {error ? <Notice tone="fail" compact>{error}</Notice> : null}
    {notice ? <Notice tone="ok" compact>{notice}</Notice> : null}
    {!report ? <p className="page__muted">正在检查运行配置…</p> : <>
      <SettingSection title="Java 启动参数" description={report.jvmDescription}>
        <SettingRow label="自动参数" description={report.automaticJvmArgs.length ? report.automaticJvmArgs.join(' ') : '使用 JVM 自适应默认值，不固定堆区域大小和 GC 停顿目标。'} />
        <SettingRow label="自定义参数" description={report.customJvmArgs || '没有额外指定；保留版本所需的类路径与原生库参数。'} />
      </SettingSection>
      {report.jvmIssues.map((issue, index) => <Notice key={index} tone={issue.level === 'block' ? 'fail' : 'stall'} compact>{issue.message}</Notice>)}
      <SettingSection title="运行内存" description={report.note}>
        <SettingRow label="当前上限" description={report.memoryControlledByJvm ? '由自定义 JVM 参数指定，请在版本设置中修改。' : '由这个版本的内存设置、PCL 设置或全局默认值决定。'}>{memoryLabel(report.currentMemoryMb)}</SettingRow>
        <SettingRow label="建议起点" description={`本机 ${memoryLabel(report.totalMemoryMb)}，当前可用 ${memoryLabel(report.freeMemoryMb)}。结合 Mod 数量为系统和原生内存预留空间。`}>{memoryLabel(report.recommendedMemoryMb)}</SettingRow>
      </SettingSection>
      {footer ? createPortal(<div className="performance-actions">
        <span className="performance-target" title={versionId}>{versionId}</span>
        <Button className="performance-apply" block icon={<Gauge size={20} />} isDisabled={busy || report.canRestore || report.memoryControlledByJvm} onPress={() => void apply()}>{busy ? '正在保存…' : '应用建议内存'}</Button>
        {report.canRestore ? <Button variant="ghost" icon={<RotateCcw size={18} />} isDisabled={busy} onPress={() => void apply(true)}>恢复原内存设置</Button> : null}
      </div>, footer) : null}
    </>}
  </>
}
