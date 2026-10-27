import { useEffect, useState, type ReactElement } from 'react'
import { Coffee, Download, FolderOpen, FolderPlus, Gauge, Gamepad2, Import, Info, Palette, Plus, RefreshCw, Trash2, UserRound } from 'lucide-react'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { ListBoxItem } from './ui/ListBox'
import { Select } from './ui/Select'
import { SettingRow, SettingSection } from './ui/SettingRow'
import { Slider } from './ui/Slider'
import { Switch } from './ui/Switch'
import { MemorySlider } from './MemorySlider.tsx'
import { version } from '../../../package.json'
import type { DownloadProbe, DownloadSource, JavaEntry, LauncherSettings, ThemePreference } from '../../shared/api.ts'
import { MicrosoftLogin } from './MicrosoftLogin.tsx'
import { ImportPage } from './ImportPage.tsx'
import { accountKindLabel, accountKindTone, accountStatus } from './labels.ts'
import { ConfirmDialog } from './overlays.tsx'
import { SkinHead } from './SkinHead.tsx'
import { UpdateSection } from './UpdatePanel.tsx'
import { PageHead, SubNavLayout, type SubNavGroup } from './SubNavLayout.tsx'

export type SettingsSection = 'accounts' | 'folders' | 'java' | 'game' | 'download' | 'appearance' | 'import' | 'about'

const GROUPS: SubNavGroup<SettingsSection>[] = [
  {
    label: '启动',
    items: [
      { id: 'accounts', label: '账号', icon: <UserRound size={20} /> },
      { id: 'folders', label: '游戏目录', icon: <FolderOpen size={20} /> },
      { id: 'java', label: 'Java', icon: <Coffee size={20} /> },
      { id: 'game', label: '启动默认值', icon: <Gamepad2 size={20} /> }
    ]
  },
  {
    label: '启动器',
    items: [
      { id: 'download', label: '下载', icon: <Download size={20} /> },
      { id: 'appearance', label: '外观', icon: <Palette size={20} /> },
      { id: 'import', label: '导入', icon: <Import size={20} /> },
      { id: 'about', label: '关于', icon: <Info size={20} /> }
    ]
  }
]


const DOWNLOAD_SOURCES: { id: DownloadSource; label: string; description: string }[] = [
  { id: 'auto', label: '自动', description: '先用 BMCLAPI，失败时换官方源' },
  { id: 'bmclapi', label: 'BMCLAPI', description: '国内镜像，速度通常更快' },
  { id: 'official', label: '官方', description: 'Mojang 与各加载器的官方地址' }
]

const THEMES: { id: ThemePreference; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' }
]

const CREDITS = [
  { name: '@xmcl/core、@xmcl/user', note: 'MIT · 启动参数与离线账号' },
  { name: 'Prism Launcher、HMCL', note: 'GPL · 只参考功能结构，没有使用代码' },
  { name: 'PCL', note: '只读取它的配置用于迁移，没有使用代码与素材' },
  { name: 'BMCLAPI', note: '国内下载镜像' },
  { name: 'Modrinth', note: '社区资源' }
]

interface Pending {
  title: string
  text: string
  run(): Promise<void>
}

interface Props {
  settings: LauncherSettings
  apply(next: Promise<LauncherSettings>): Promise<void>
  section: SettingsSection
  onSection(section: SettingsSection): void
  onImported(): void
}

export function SettingsPage({ settings, apply, section, onSection, onImported }: Props): ReactElement {
  const [javas, setJavas] = useState<JavaEntry[] | null>(null)
  const [javaScan, setJavaScan] = useState(0)
  const [probe, setProbe] = useState<DownloadProbe[] | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [concurrency, setConcurrency] = useState(settings.downloadConcurrency)
  const update = (patch: Partial<LauncherSettings>): void => void apply(window.craft.updateSettings(patch))

  useEffect(() => setConcurrency(settings.downloadConcurrency), [settings.downloadConcurrency])

  useEffect(() => {
    if (section !== 'java') return
    let alive = true
    setJavas(null)
    void window.craft.javas().then(
      (list) => alive && setJavas(list),
      () => alive && setJavas([])
    )
    return () => {
      alive = false
    }
  }, [section, settings.extraJavaPaths, javaScan])

  const isCustomJava = (path: string): boolean => settings.extraJavaPaths.some((item) => item.toLowerCase() === path.toLowerCase())

  const addJava = async (): Promise<void> => {
    const path = await window.craft.pickJava()
    if (!path || isCustomJava(path)) return
    update({ extraJavaPaths: [...settings.extraJavaPaths, path] })
  }

  const runProbe = async (): Promise<void> => {
    setProbing(true)
    setProbeError('')
    try {
      const list = await window.craft.probeDownloadSources()
      setProbe(list)
    } catch (cause) {
      setProbeError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause))
    } finally {
      setProbing(false)
    }
  }

  const addFolder = async (): Promise<void> => {
    const path = await window.craft.pickFolder()
    if (!path || settings.folders.some((item) => item.path.toLowerCase() === path.toLowerCase())) return
    update({ folders: [...settings.folders, { name: path, path }] })
  }

  const confirm = async (): Promise<void> => {
    if (!pending) return
    setBusy(true)
    try {
      await pending.run()
      setPending(null)
    } finally {
      setBusy(false)
    }
  }

  const currentFolder = settings.selectedFolder ?? settings.folders[0]?.path

  return (
    <SubNavLayout label="设置" groups={GROUPS} active={section} onChange={onSection}>
      {section === 'import' ? (
        <ImportPage settings={settings} apply={apply} onDone={onImported} />
      ) : (
        <div className="subpage">
          {section === 'accounts' ? (
            <>
              <PageHead title="账号" description="在启动页左侧左右滑动头像切换账号。" />
              <SettingSection title="已添加">
                {settings.accounts.length === 0 ? <SettingRow label="还没有账号" description="在启动页左侧添加。" /> : null}
                {settings.accounts.map((account) => (
                  <SettingRow
                    key={account.id}
                    leading={<SkinHead account={account} size={36} />}
                    label={
                      <span className="settings-account">
                        {account.name}
                        <Badge tone={accountKindTone(account)}>{accountKindLabel(account)}</Badge>
                        {account.id === settings.selectedAccountId ? <Badge tone="accent">当前</Badge> : null}
                      </span>
                    }
                    description={accountStatus(account)}
                  >
                    <IconButton
                      aria-label={`移除 ${account.name}`}
                      onPress={() =>
                        setPending({
                          title: `移除账号 ${account.name}？`,
                          text: account.kind === 'offline' ? '离线账号随时可以重新添加。' : '移除后需要重新登录才能再用这个账号。',
                          run: () => apply(window.craft.removeAccount(account.id))
                        })
                      }
                    >
                      <Trash2 size={18} />
                    </IconButton>
                  </SettingRow>
                ))}
              </SettingSection>
              <SettingSection title="登录方式">
                <SettingRow label="离线" description="输入名字即可，只能进单机和离线服务器。">
                  <Badge tone="ok">可用</Badge>
                </SettingRow>
                <SettingRow label="Microsoft 正版" description="用微软设备码登录；凭据由系统加密保存，启动时自动刷新。">
                  <MicrosoftLogin onSignedIn={(next) => apply(Promise.resolve(next))} />
                </SettingRow>
                <SettingRow label="外置登录" description="LittleSkin 等 authlib-injector 皮肤站。">
                  <Badge>开发中</Badge>
                </SettingRow>
              </SettingSection>
            </>
          ) : section === 'folders' ? (
            <>
              <PageHead
                title="游戏目录"
                description="每个目录是一个 .minecraft 文件夹，里面的版本会出现在启动页。"
                actions={
                  <Button icon={<FolderPlus size={18} />} onPress={() => void addFolder()}>
                    添加目录
                  </Button>
                }
              />
              <SettingSection title="已添加">
                {settings.folders.length === 0 ? <SettingRow label="还没有游戏目录" /> : null}
                {settings.folders.map((folder) => (
                  <SettingRow key={folder.path} label={folder.name} description={folder.path}>
                    {currentFolder === folder.path ? (
                      <Badge tone="accent">当前</Badge>
                    ) : (
                      <Button variant="ghost" onPress={() => update({ selectedFolder: folder.path, selectedVersion: null })}>
                        设为当前
                      </Button>
                    )}
                    <IconButton
                      aria-label={`移除 ${folder.name}`}
                     
                      onPress={() =>
                        setPending({
                          title: `移除目录 ${folder.name}？`,
                          text: '只是不再在启动器里显示，文件夹和里面的游戏都不会删除。',
                          run: () => {
                            const folders = settings.folders.filter((item) => item.path !== folder.path)
                            return apply(
                              window.craft.updateSettings({ folders, selectedFolder: settings.selectedFolder === folder.path ? (folders[0]?.path ?? null) : settings.selectedFolder })
                            )
                          }
                        })
                      }
                    >
                      <Trash2 size={18} />
                    </IconButton>
                  </SettingRow>
                ))}
              </SettingSection>
            </>
          ) : section === 'java' ? (
            <>
              <PageHead
                title="Java"
                description="启动时按版本要求自动挑选；PCL 为单个版本指定的 Java 优先使用。"
                actions={
                  <>
                    <Button variant="ghost" icon={<RefreshCw size={18} />} onPress={() => setJavaScan((value) => value + 1)}>
                      重新检测
                    </Button>
                    <Button icon={<Plus size={18} />} onPress={() => void addJava()}>
                      添加 Java
                    </Button>
                  </>
                }
              />
              <SettingSection title={javas && javas.length > 0 ? `找到 ${javas.length} 个 Java` : '找到的 Java'}>
                {javas === null ? <SettingRow label="正在检测…" /> : null}
                {javas?.length === 0 ? <SettingRow label="没有找到 Java" description="点右上角「添加 Java」指定一个 java 可执行文件。" /> : null}
                {javas?.map((java) => (
                  <SettingRow key={java.path} label={`Java ${java.majorVersion}`} description={java.path}>
                    <Badge tone={isCustomJava(java.path) ? 'accent' : 'neutral'}>{isCustomJava(java.path) ? '已指定' : '自动检测'}</Badge>
                    <span className="page__muted">{java.version}</span>
                    {isCustomJava(java.path) ? (
                      <IconButton
                        aria-label={`移除 Java ${java.majorVersion}`}
                       
                        onPress={() => update({ extraJavaPaths: settings.extraJavaPaths.filter((item) => item.toLowerCase() !== java.path.toLowerCase()) })}
                      >
                        <Trash2 size={18} />
                      </IconButton>
                    ) : null}
                  </SettingRow>
                ))}
              </SettingSection>
            </>
          ) : section === 'game' ? (
            <>
              <PageHead title="启动默认值" description="所有版本默认使用这些值。" />
              <SettingSection title="内存">
                <SettingRow label="最大内存" description="分给游戏的 Java 堆内存上限。版本里没单独设置时用这个。" block>
                  <MemorySlider value={settings.maxMemoryMb} onCommit={(value) => update({ maxMemoryMb: value })} />
                </SettingRow>
              </SettingSection>
              <SettingSection title="启动器">
                <SettingRow label="关闭窗口时退到托盘" description="游戏是独立进程，关掉或退出启动器都不会让游戏退出。">
                  <Switch aria-label="关闭窗口时退到托盘" isSelected={settings.closeToTray} onChange={(value) => update({ closeToTray: value })} />
                </SettingRow>
              </SettingSection>
            </>
          ) : section === 'download' ? (
            <>
              <PageHead
                title="下载"
                description="安装游戏、加载器和资源时使用。"
                actions={
                  <Button icon={<Gauge size={18} />} isDisabled={probing} onPress={() => void runProbe()}>
                    {probing ? '正在测速…' : '测速'}
                  </Button>
                }
              />
              <SettingSection title="下载源">
                <SettingRow label="下载源" description={DOWNLOAD_SOURCES.find((item) => item.id === settings.downloadSource)?.description}>
                  <Select aria-label="下载源" selectedKey={settings.downloadSource} onSelectionChange={(key) => key != null && update({ downloadSource: key as DownloadSource })}>
                    {DOWNLOAD_SOURCES.map((item) => (
                      <ListBoxItem key={item.id} id={item.id} textValue={item.label}>
                        {item.label}
                      </ListBoxItem>
                    ))}
                  </Select>
                </SettingRow>
                {probe?.map((item) => (
                  <SettingRow
                    key={item.source}
                    label={item.label}
                    description={item.error ? `测速失败：${item.error}` : item.bytes > 0 ? `读取 ${Math.round(item.bytes / 1024)} KB 的版本清单` : '没有拿到数据'}
                  >
                    <Badge tone={item.error ? 'fail' : item.source === 'bmclapi' ? 'accent' : 'neutral'}>{item.error ? '不可用' : `${item.ms} 毫秒`}</Badge>
                  </SettingRow>
                ))}
                {probeError ? <SettingRow label="测速失败" description={probeError} /> : null}
                <SettingRow label="同时下载" description="网络不稳定时调低。" block>
                  <Slider
                    aria-label="同时下载数"
                    className="settings-slider"
                    minValue={4}
                    maxValue={64}
                    step={4}
                    showValue
                    value={concurrency}
                    onChange={(value) => setConcurrency(Array.isArray(value) ? (value[0] ?? 16) : value)}
                    onChangeEnd={(value) => update({ downloadConcurrency: Array.isArray(value) ? (value[0] ?? 16) : value })}
                  />
                </SettingRow>
              </SettingSection>
            </>
          ) : section === 'appearance' ? (
            <>
              <PageHead title="外观" />
              <SettingSection title="主题">
                <SettingRow label="颜色主题">
                  <Select aria-label="颜色主题" selectedKey={settings.theme} onSelectionChange={(key) => key != null && update({ theme: key as ThemePreference })}>
                    {THEMES.map((item) => (
                      <ListBoxItem key={item.id} id={item.id} textValue={item.label}>
                        {item.label}
                      </ListBoxItem>
                    ))}
                  </Select>
                </SettingRow>
              </SettingSection>
            </>
          ) : (
            <>
              <PageHead title="Inkstone Minecraft" description={`版本 ${version} · 可独立运行，也可作为砚的插件。`} />
              <UpdateSection />
              <SettingSection title="数据">
                <SettingRow label="账号" description="账号列表保存名字与 UUID；Microsoft 刷新凭据由系统加密单独保存，移除账号时删除。" />
                <SettingRow label="删除" description="删除版本、Mod 与存档时移到回收站。" />
              </SettingSection>
              <SettingSection title="致谢与许可">
                {CREDITS.map((item) => (
                  <SettingRow key={item.name} label={item.name} description={item.note} />
                ))}
              </SettingSection>
            </>
          )}
        </div>
      )}
      <ConfirmDialog open={!!pending} title={pending?.title ?? ''} confirmLabel="移除" danger busy={busy} onConfirm={() => void confirm()} onCancel={() => !busy && setPending(null)}>
        {pending?.text}
      </ConfirmDialog>
    </SubNavLayout>
  )
}
