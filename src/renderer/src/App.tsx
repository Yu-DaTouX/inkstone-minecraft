import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { Download, Play, Settings } from 'lucide-react'
import type { LauncherSettings, LaunchStatus } from '../../shared/api.ts'
import { LaunchPage } from './LaunchPage.tsx'
import { GameLogSheet } from './LogSheet.tsx'
import type { SettingsSection } from './SettingsPage.tsx'
import { TaskIndicator } from './TaskIndicator.tsx'
import { TerrainBand } from './SeedTerrain.tsx'
import { BlockIcon } from './BlockIcon.tsx'
import { UpdateBadge } from './UpdatePanel.tsx'

const DownloadPage = lazy(() => import('./DownloadPage.tsx').then((module) => ({ default: module.DownloadPage })))
const SettingsPage = lazy(() => import('./SettingsPage.tsx').then((module) => ({ default: module.SettingsPage })))
const VersionPage = lazy(() => import('./VersionPage.tsx').then((module) => ({ default: module.VersionPage })))

/** 页面切换：新页面挂载时自己做进场动画（见 launch.css），这里只负责更新。
 *  不用 View Transitions，因为 view-transition-name 会截断玻璃的背景模糊。 */
function transition(update: () => void): void {
  update()
}

type Page = 'launch' | 'download' | 'settings'

interface VersionRoute {
  folder: string
  id: string
  section?: 'mods' | 'repair' | 'settings'
}

const PAGES = [
  { value: 'launch', label: '启动', Icon: Play },
  { value: 'download', label: '下载', Icon: Download },
  { value: 'settings', label: '设置', Icon: Settings }
] as const

/** 顶栏导航：文字直接写在玻璃上，选中底块在页签之间滑动。 */
function NavTabs({ value, onChange }: { value: Page; onChange(next: Page): void }): ReactElement {
  const host = useRef<HTMLElement>(null)
  const [thumb, setThumb] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    const place = (): void => {
      const active = element.querySelector<HTMLElement>(`[data-page="${value}"]`)
      setThumb(active ? { transform: `translateX(${active.offsetLeft}px)`, width: active.offsetWidth } : null)
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    return () => observer.disconnect()
  }, [value])
  return (
    <nav ref={host} className="nav" aria-label="页面">
      {thumb ? <span className="nav__thumb" style={thumb} aria-hidden="true" /> : null}
      {PAGES.map(({ value: page, label, Icon }) => (
        <button key={page} type="button" className="nav__tab" data-page={page} aria-current={page === value ? 'page' : undefined} onClick={() => onChange(page)}>
          <Icon size={16} strokeWidth={page === value ? 2.2 : 1.8} aria-hidden="true" />
          {label}
        </button>
      ))}
    </nav>
  )
}

export function App(): ReactElement {
  const [page, setPage] = useState<Page>('launch')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('accounts')
  const [version, setVersion] = useState<VersionRoute | null>(null)
  const [settings, setSettings] = useState<LauncherSettings | null>(null)
  const [status, setStatus] = useState<LaunchStatus | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [world, setWorld] = useState('Inkstone Minecraft')

  useEffect(() => {
    const update = (): void => { document.documentElement.dataset.background = document.hidden || !document.hasFocus() ? '1' : '0' }
    update()
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [])

  useEffect(() => {
    void window.craft.settings().then((loaded) => {
      setSettings(loaded)
      if (loaded.folders.length === 0 && loaded.importedFromPclAt === null) {
        setSettingsSection('import')
        setPage('settings')
      }
    })
    void window.craft.status().then(setStatus)
    return window.craft.onStatus(setStatus)
  }, [])

  useEffect(() => {
    if (status?.state === 'failed' && !status.crashId) setLogOpen(true)
  }, [status?.state])

  useEffect(() => {
    const theme = settings?.theme ?? 'system'
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [settings?.theme])

  const apply = useCallback(async (next: Promise<LauncherSettings>): Promise<void> => {
    setSettings(await next)
  }, [])

  const openSettings = (section: SettingsSection): void => {
    transition(() => {
      setSettingsSection(section)
      setPage('settings')
    })
  }

  return (
    <div className="shell" data-run={status?.state ?? 'idle'} data-sheet={page !== 'launch' || version ? '1' : undefined}>
      <TerrainBand seed={world} cell={8} className="world" />
      <header className="shell__bar">
        <div className="shell__brand">
          <BlockIcon version="" size={24} className="shell__mark" />
          <span className="shell__name">Inkstone</span>
        </div>
        <NavTabs
          value={page}
          onChange={(next) => {
            if (next === page && !version) return
            transition(() => {
              setPage(next)
              setVersion(null)
            })
          }}
        />
        <div className="shell__tools">
          <UpdateBadge />
          <TaskIndicator />
        </div>
      </header>
      <main className="shell__page" key={page === 'launch' && version ? 'version' : page}>
        <Suspense fallback={<p className="shell__loading">正在打开页面…</p>}>
        {!settings ? (
          <p className="shell__loading">正在读取设置…</p>
        ) : page === 'launch' && version ? (
          <VersionPage
            key={`${version.folder}|${version.id}`}
            folder={version.folder}
            versionId={version.id}
            initialSection={version.section}
            settings={settings}
            onBack={() => transition(() => setVersion(null))}
            onOpenLogs={() => setLogOpen(true)}
            onRenamed={(id) => setVersion({ folder: version.folder, id })}
          />
        ) : page === 'launch' ? (
          <LaunchPage
            settings={settings}
            status={status}
            apply={apply}
            onImport={() => openSettings('import')}
            onManage={(folder, id, section) => transition(() => setVersion({ folder, id, section }))}
            onOpenLogs={() => setLogOpen(true)}
            onOpenSettings={openSettings}
            onWorld={setWorld}
          />
        ) : page === 'download' ? (
          <DownloadPage onWorld={setWorld} />
        ) : (
          <SettingsPage settings={settings} apply={apply} section={settingsSection} onSection={setSettingsSection} onImported={() => setPage('launch')} />
        )}
        </Suspense>
      </main>
      <GameLogSheet status={status} open={logOpen} folder={settings?.selectedFolder ?? null} versionId={status?.versionId ?? settings?.selectedVersion ?? null} onClose={() => setLogOpen(false)} />
    </div>
  )
}
