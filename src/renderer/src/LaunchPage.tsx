import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { FileText, Layers, Settings2, Wrench } from 'lucide-react'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Notice } from './ui/Notice'
import type { InstanceInfo, LauncherSettings, LaunchStatus } from '../../shared/api.ts'
import type { CrashAction, CrashDiagnosis } from '../../shared/crash-api.ts'
import type { PreflightReport } from '../../shared/launch-api.ts'
import { AccountRing } from './AccountRing.tsx'
import { AddAccount } from './AddAccount.tsx'
import { CrashDialog } from './CrashDialog.tsx'
import { LaunchCard } from './LaunchCard.tsx'
import { canLaunchWith, LOADER_BIOME, loaderLabel } from './labels.ts'
import { seedOf } from './terrain.ts'
import { VersionList } from './VersionList.tsx'

type PickerState = 'closed' | 'open' | 'closing'

function crashTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

interface Props {
  settings: LauncherSettings
  status: LaunchStatus | null
  apply(next: Promise<LauncherSettings>): Promise<void>
  onImport(): void
  onManage(folder: string, versionId: string): void
  onOpenLogs(): void
  onOpenSettings(section: 'accounts' | 'java' | 'game'): void
  /** 背景地图跟着当前（或正在预览的）版本换种子 */
  onWorld(seed: string): void
}

function cleanError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function LaunchPage({ settings, status, apply, onImport, onManage, onOpenLogs, onOpenSettings, onWorld }: Props): ReactElement {
  const [fresh, setFresh] = useState<LauncherSettings | null>(null)
  const current = fresh ?? settings
  const folder = current.selectedFolder ?? current.folders[0]?.path ?? null
  const [instances, setInstances] = useState<InstanceInfo[] | null>(null)
  const [instancesError, setInstancesError] = useState('')
  const [scan, setScan] = useState(0)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [report, setReport] = useState<PreflightReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [crash, setCrash] = useState<CrashDiagnosis | null>(null)
  const [crashBusy, setCrashBusy] = useState<string | null>(null)
  const [crashResult, setCrashResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [lastCrash, setLastCrash] = useState<CrashDiagnosis | null>(null)
  const [dismissedCrash, setDismissedCrash] = useState<string | null>(null)
  const [picker, setPicker] = useState<PickerState>('closed')
  const [hovered, setHovered] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    setFresh(null)
  }, [settings])

  useEffect(() => {
    void window.craft.settings().then(setFresh, () => undefined)
  }, [])

  useEffect(() => {
    setInstances(null)
    setInstancesError('')
    if (!folder) return
    let alive = true
    void window.craft.instances(folder).then(
      (list) => alive && setInstances(list),
      (cause: unknown) => {
        if (!alive) return
        setInstances([])
        setInstancesError(cleanError(cause))
      }
    )
    return () => {
      alive = false
    }
  }, [folder, scan])

  useEffect(
    () =>
      window.craft.onInstancesChanged((changed) => {
        if (!folder || changed.toLowerCase() === folder.toLowerCase()) setScan((value) => value + 1)
        void window.craft.settings().then(setFresh)
      }),
    [folder]
  )

  useEffect(
    () =>
      window.craft.onCrash((diagnosis) => {
        setReport(null)
        setCrashResult(null)
        setCrash(diagnosis)
      }),
    []
  )

  const selected = useMemo(() => instances?.find((item) => item.id === current.selectedVersion) ?? instances?.find((item) => !item.error) ?? null, [instances, current.selectedVersion])
  const account = current.accounts.find((item) => item.id === current.selectedAccountId) ?? null
  const busy = status?.state === 'starting' || status?.state === 'running'
  const showAdd = adding || current.accounts.length === 0
  const blocker = !account ? '先添加一个账号' : !canLaunchWith(account) ? '正版与外置登录还在接入，先切到离线账号启动' : !selected ? '先在版本选择里挑一个版本' : ''
  const steps = status?.steps ?? []

  // 悬停预览稍等一下再换地图，扫过列表时不至于每行都溶解一次
  useEffect(() => {
    const timer = setTimeout(() => setHovered(preview), preview ? 110 : 260)
    return () => clearTimeout(timer)
  }, [preview])

  const worldSeed = (picker === 'open' ? hovered : null) ?? selected?.id ?? folder ?? 'Inkstone Minecraft'
  useEffect(() => onWorld(worldSeed), [onWorld, worldSeed])

  // 还没有可用版本时直接摊开版本列表
  const needsPick = current.folders.length === 0 || (instances !== null && !selected)
  useEffect(() => {
    if (needsPick) setPicker('open')
  }, [needsPick])

  useEffect(() => {
    if (picker !== 'open' || needsPick) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setPicker('closing')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picker, needsPick])
  const warnings = report?.items.filter((item) => item.level === 'warn') ?? []

  useEffect(() => {
    const versionId = selected?.id
    if (!folder || !versionId) {
      setLastCrash(null)
      return
    }
    let alive = true
    void window.craft.crashLatest(folder, versionId).then(
      (value) => alive && setLastCrash(value),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [folder, selected?.id, crash, status?.state])

  const launch = async (versionId: string, ignoreWarnings = false): Promise<void> => {
    if (!folder || !account || !canLaunchWith(account) || busy || checking) return
    setError('')
    if (!ignoreWarnings) {
      setChecking(true)
      setReport(null)
      try {
        const next = await window.craft.preflight({ folder, versionId })
        if (next.blocked || next.items.some((item) => item.level === 'warn')) {
          setReport(next)
          return
        }
      } catch (cause) {
        setError(cleanError(cause))
        return
      } finally {
        setChecking(false)
      }
    }
    setReport(null)
    try {
      if (versionId !== current.selectedVersion) await apply(window.craft.updateSettings({ selectedVersion: versionId, selectedFolder: folder }))
      const result = await window.craft.launch({ folder, versionId, accountId: account.id, ignoreWarnings })
      if (result.state === 'failed' && result.error) setError(result.error)
    } catch (cause) {
      setError(cleanError(cause))
    }
  }

  const runCrashAction = async (action: CrashAction): Promise<void> => {
    if (!crash || !folder) return
    setCrashResult(null)
    if (action.kind === 'mods' || action.kind === 'repair') {
      onManage(folder, crash.versionId)
      setCrash(null)
      return
    }
    setCrashBusy(action.kind)
    try {
      if (action.kind === 'export') {
        const exported = await window.craft.crashExport(folder, crash.versionId, crash.id)
        setCrashResult(exported ? { ok: true, message: `诊断包已导出：${exported.path}` } : { ok: false, message: '找不到这份崩溃记录' })
      } else {
        const result = await window.craft.crashAction({ folder, versionId: crash.versionId, diagnosisId: crash.id, kind: action.kind, value: action.value })
        setCrashResult(result)
        if (result.ok) setDismissedCrash(crash.id)
      }
    } catch (cause) {
      setCrashResult({ ok: false, message: cleanError(cause) })
    } finally {
      setCrashBusy(null)
    }
  }

  const blocked = report?.blocked ? report.items.filter((item) => item.level === 'block') : []
  const showCrash = !!lastCrash && lastCrash.id !== dismissedCrash && !crash && !busy

  return (
    <div className="launch" data-picker={picker}>
      <aside className="rail" aria-label="账号与启动">
        <div className="rail__account">
          {showAdd ? (
            <AddAccount
              canGoBack={current.accounts.length > 0}
              onBack={() => setAdding(false)}
              onAddOffline={async (name) => {
                await apply(window.craft.addOfflineAccount(name))
                setAdding(false)
              }}
            />
          ) : (
            <AccountRing
              accounts={current.accounts}
              selectedId={current.selectedAccountId}
              onSelect={(id) => void apply(window.craft.selectAccount(id))}
              onAdd={() => setAdding(true)}
            />
          )}
        </div>
        <div className="rail__go">
          {busy && status ? (
            <LaunchCard
              status={status}
              steps={steps}
              effective={status.effective ?? null}
              runningSince={status.runningSince ?? null}
              onCancel={() => void window.craft.stop()}
              onStop={() => void window.craft.stop()}
              onLogs={onOpenLogs}
            />
          ) : (
            <>
              <Button
                variant="primary"
                block
                className={checking ? 'go go--checking' : 'go'}
                isDisabled={!!blocker || checking}
                onPress={() => selected && void launch(selected.id)}
              >
                <span className="go__label">{checking ? '正在检查…' : '启动游戏'}</span>
                <span className="go__version">{selected?.id ?? '没有可启动的版本'}</span>
              </Button>
              {blocker ? <p className="rail__hint">{blocker}</p> : null}
            </>
          )}
          <div className="rail__row">
            <Button className="rail__pick" icon={<Layers size={17} />} onPress={() => setPicker(picker === 'open' ? 'closing' : 'open')} aria-expanded={picker === 'open'}>
              版本选择
            </Button>
            <IconButton aria-label="版本设置" className="rail__icon" isDisabled={!selected || !folder} onPress={() => selected && folder && onManage(folder, selected.id)}>
              <Settings2 size={18} />
            </IconButton>
            <IconButton aria-label="游戏日志" className="rail__icon" onPress={onOpenLogs}>
              <FileText size={18} />
            </IconButton>
          </div>
        </div>
      </aside>
      <section className="view" aria-label="当前版本">
        {selected ? (
          <div className="view__title" key={selected.id}>
            <h1 className="view__name">{selected.id}</h1>
            <p className="view__sub">
              <i className="swatch" style={{ background: LOADER_BIOME[selected.loader] }} aria-hidden="true" />
              {loaderLabel(selected)}
              <span className="view__dot" aria-hidden="true" />
              Minecraft {selected.minecraftVersion ?? '?'}
              <span className="view__dot" aria-hidden="true" />
              {selected.modCount ? `${selected.modCount} 个 Mod` : '没有 Mod'}
            </p>
          </div>
        ) : null}
        {selected ? (
          <span className="view__seed" title="背景地图由版本名生成">
            种子 {seedOf(selected.id)}
          </span>
        ) : null}
        <div className="view__notes" aria-live="polite">
          {report?.blocked ? (
            <FixCard
              title="启动前检查没通过"
              items={blocked.map((item) => `${item.title}${item.detail ? `：${item.detail}` : ''}`)}
              actions={
                <>
                  {blocked.some((item) => item.id === 'java') ? (
                    <Button className="fix-button" onPress={() => onOpenSettings('java')}>
                      去设置 Java
                    </Button>
                  ) : null}
                  <Button className={blocked.some((item) => item.id === 'java') ? undefined : 'fix-button'} onPress={() => folder && onManage(folder, report.versionId)}>
                    去修复版本
                  </Button>
                  <Button variant="ghost" onPress={() => setReport(null)}>
                    先不启动
                  </Button>
                </>
              }
            />
          ) : null}
          {report && !report.blocked && warnings.length > 0 ? (
            <FixCard
              title="启动前检查有提醒"
              items={warnings.map((item) => `${item.title}${item.detail ? `：${item.detail}` : ''}`)}
              actions={
                <>
                  {warnings.some((item) => item.id === 'deps' || item.id === 'duplicates') ? (
                    <Button className="fix-button" onPress={() => folder && onManage(folder, report.versionId)}>
                      打开 Mod 管理
                    </Button>
                  ) : null}
                  <Button onPress={() => selected && void launch(selected.id, true)}>仍然启动</Button>
                  <Button variant="ghost" onPress={() => setReport(null)}>
                    先不启动
                  </Button>
                </>
              }
            />
          ) : null}
          {showCrash && lastCrash ? (
            <FixCard
              title={`上次崩溃：${lastCrash.rule?.title ?? '没认出原因'}`}
              items={[`${crashTime(lastCrash.at)} 崩溃，已经分析过日志`]}
              actions={
                <>
                  <Button className="fix-button" onPress={() => setCrash(lastCrash)}>
                    查看原因与修复
                  </Button>
                  <Button variant="ghost" onPress={() => setDismissedCrash(lastCrash.id)}>
                    忽略
                  </Button>
                </>
              }
            />
          ) : null}
          {error ? (
            <Notice tone="fail" compact>
              {error}
            </Notice>
          ) : null}
        </div>
        {picker !== 'closed' ? (
          <div className="picker" data-state={picker} onAnimationEnd={(event) => event.target === event.currentTarget && picker === 'closing' && setPicker('closed')}>
            <VersionList
              folders={current.folders}
              folder={folder}
              instances={folder ? instances : []}
              error={instancesError}
              selectedId={selected?.id ?? null}
              onFolder={(path) => void apply(window.craft.updateSettings({ selectedFolder: path, selectedVersion: null }))}
              onSelect={(id) => {
                setPreview(null)
                void apply(window.craft.updateSettings({ selectedVersion: id, selectedFolder: folder }))
                setPicker('closing')
              }}
              onLaunch={(id) => {
                setPicker('closing')
                void launch(id)
              }}
              onManage={(id) => folder && onManage(folder, id)}
              onPickFolder={() =>
                void window.craft.pickFolder().then((path) => {
                  if (!path) return
                  const folders = current.folders.some((item) => item.path.toLowerCase() === path.toLowerCase()) ? current.folders : [...current.folders, { name: path, path }]
                  return apply(window.craft.updateSettings({ folders, selectedFolder: path, selectedVersion: null }))
                })
              }
              onImport={onImport}
              onRefresh={() => setScan((value) => value + 1)}
              onPreview={setPreview}
              onClose={selected ? () => setPicker('closing') : undefined}
            />
          </div>
        ) : null}
      </section>
      <CrashDialog
        diagnosis={crash}
        busy={crashBusy}
        result={crashResult}
        onClose={() => {
          setCrash(null)
          if (status?.state === 'failed') onOpenLogs()
        }}
        onAction={(action) => void runCrashAction(action)}
      />
    </div>
  )
}

function FixCard({ title, items, actions }: { title: string; items?: string[]; actions: ReactNode }): ReactElement {
  return (
    <div className="fix-card" role="status">
      <Wrench size={16} className="fix-card__icon" aria-hidden="true" />
      <div className="fix-card__body">
        <p className="fix-card__title">{title}</p>
        {items && items.length > 0 ? (
          <ul className="fix-card__items">
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
        <div className="fix-card__actions">{actions}</div>
      </div>
    </div>
  )
}
