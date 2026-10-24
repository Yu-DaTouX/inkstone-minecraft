import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import { FolderPlus, Import, RefreshCw, Settings2, X } from 'lucide-react'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { ListBoxItem } from './ui/ListBox'
import { Notice } from './ui/Notice'
import { SearchField } from './ui/TextField'
import { Select } from './ui/Select'
import { Skeleton } from './ui/Skeleton'
import type { GameFolder, InstanceInfo } from '../../shared/api.ts'
import { InstanceIcon } from './InstanceIcon.tsx'
import { LOADER_BIOME, LOADER_LABEL, loaderLabel } from './labels.ts'

/** 路径太长时保留开头和结尾，中间省略，目录名在结尾才分得清。 */
function middlePath(path: string, max = 52): string {
  if (path.length <= max) return path
  const tail = Math.ceil(max * 0.62)
  return `${path.slice(0, max - tail - 1)}…${path.slice(-tail)}`
}
import { EmptyBlock } from './SubNavLayout.tsx'

interface Props {
  folders: GameFolder[]
  folder: string | null
  instances: InstanceInfo[] | null
  error: string | null
  selectedId: string | null
  onFolder(path: string): void
  onSelect(id: string): void
  onLaunch(id: string): void
  onManage(id: string): void
  onPickFolder(): void
  onImport(): void
  onRefresh(): void
  /** 鼠标停在某一行上时预览它的地图，离开列表时传 null */
  onPreview?(id: string | null): void
  onClose?(): void
}

/** 选中高亮是一块独立的底，换行时滑过去而不是闪到新行。 */
function useMarker(list: HTMLUListElement | null, selectedId: string | null, rows: unknown): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!list || !selectedId) {
      setStyle(null)
      return
    }
    const place = (): void => {
      const row = list.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(selectedId)}"]`)
      setStyle(row ? { transform: `translateY(${row.offsetTop}px)`, height: row.offsetHeight } : null)
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(list)
    return () => observer.disconnect()
  }, [list, selectedId, rows])
  return style
}

export function VersionList({ folders, folder, instances, error, selectedId, onFolder, onSelect, onLaunch, onManage, onPickFolder, onImport, onRefresh, onPreview, onClose }: Props): ReactElement {
  const [query, setQuery] = useState('')
  const [list, setList] = useState<HTMLUListElement | null>(null)
  const firstPaint = useRef(true)
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!instances || !needle) return instances
    return instances.filter((item) => item.id.toLowerCase().includes(needle) || (item.minecraftVersion ?? '').includes(needle) || item.loader.includes(needle))
  }, [instances, query])
  const marker = useMarker(list, selectedId, visible)
  const folderName = folders.find((item) => item.path === folder)?.name

  useLayoutEffect(() => {
    if (visible && visible.length > 0) firstPaint.current = false
  }, [visible])

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End' && event.key !== 'Enter') return
    const picks = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.vrow__pick')].filter((pick) => !pick.disabled)
    if (picks.length === 0) return
    const index = picks.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Enter') {
      const id = picks[index]?.dataset.versionId
      if (!id) return
      event.preventDefault()
      onManage(id)
      return
    }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? picks.length - 1 : event.key === 'ArrowDown' ? Math.min(index + 1, picks.length - 1) : Math.max(index - 1, 0)
    picks[next]?.focus()
    event.preventDefault()
  }

  if (folders.length === 0) {
    return (
      <div className="legend legend--empty">
        <EmptyBlock
          icon={<FolderPlus size={20} />}
          title="还没有游戏目录"
          actions={
            <>
              <Button variant="primary" icon={<Import size={14} />} onPress={onImport}>
                从 PCL 迁移
              </Button>
              <Button icon={<FolderPlus size={14} />} onPress={onPickFolder}>
                选择游戏目录
              </Button>
            </>
          }
        >
          可以把 PCL 的目录、账号和 Java 一起带过来，也可以直接选一个 .minecraft 文件夹。
        </EmptyBlock>
      </div>
    )
  }

  return (
    <div className="legend">
      <div className="legend__head">
        <h2 className="legend__title">
          版本
          {instances ? <span className="legend__count">{instances.length}</span> : null}
        </h2>
        <div className="legend__tools">
          <IconButton aria-label="重新扫描版本" size="sm" onPress={onRefresh}>
            <RefreshCw size={16} />
          </IconButton>
          <IconButton aria-label="添加游戏目录" size="sm" onPress={onPickFolder}>
            <FolderPlus size={16} />
          </IconButton>
          {onClose ? (
            <IconButton aria-label="收起版本列表" size="sm" onPress={onClose}>
              <X size={16} />
            </IconButton>
          ) : null}
        </div>
      </div>
      <div className="legend__filters">
        <Select aria-label="游戏目录" className="legend__folder" selectedKey={folder} onSelectionChange={(key) => key != null && onFolder(String(key))}>
          {folders.map((item) => (
            <ListBoxItem key={item.path} id={item.path} textValue={item.name}>
              {item.name}
            </ListBoxItem>
          ))}
        </Select>
        <SearchField aria-label="搜索版本" className="legend__search" placeholder="搜索" value={query} onChange={setQuery} />
      </div>
      <div className="legend__path" title={folder ?? undefined}>
        {folder && folderName !== folder ? middlePath(folder) : null}
      </div>
      <div className="vrow vrow--head" aria-hidden="true">
        <span />
        <span>名称</span>
        <span>加载器</span>
        <span className="vrow__num">MC</span>
        <span className="vrow__num">Mod</span>
        <span />
      </div>
      {error ? (
        <div className="legend__notice">
          <Notice tone="fail" compact title="读取版本列表失败" action={<Button size="sm" variant="ghost" onPress={onRefresh}>重试</Button>}>
            {error}
          </Notice>
        </div>
      ) : visible === null ? (
        <div className="legend__skeletons" aria-busy="true">
          <span className="sr-only">正在扫描版本…</span>
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="vrow vrow--skeleton" style={{ '--i': row } as CSSProperties}>
              <Skeleton shape="rect" width={32} height={32} />
              <Skeleton width="70%" height={12} />
              <Skeleton width="60%" height={10} />
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="legend__empty">
          <EmptyBlock
            title={query ? '没有匹配的版本' : '这个目录里没有可启动的版本'}
            actions={
              query ? (
                <Button size="sm" onPress={() => setQuery('')}>
                  清空搜索
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onPress={onRefresh}>
                  重新扫描
                </Button>
              )
            }
          >
            {query ? '换个关键词试试。' : '用下载页装一个，或换一个游戏目录。'}
          </EmptyBlock>
        </div>
      ) : (
        <ul ref={setList} className="legend__list" aria-label="版本" onKeyDown={onListKeyDown} onPointerLeave={() => onPreview?.(null)} data-entering={firstPaint.current ? '1' : undefined}>
          {marker ? <li className="legend__marker" style={marker} aria-hidden="true" /> : null}
          {visible.map((item, index) => {
            const broken = !!item.error && !item.minecraftVersion
            const selected = selectedId === item.id
            return (
              <li
                key={item.id}
                className="vrow"
                data-row-id={item.id}
                data-selected={selected ? '1' : undefined}
                data-broken={broken ? '1' : undefined}
                style={{ '--i': Math.min(index, 10) } as CSSProperties}
                onPointerEnter={broken ? undefined : () => onPreview?.(item.id)}
              >
                <button
                  type="button"
                  className="vrow__pick"
                  data-version-id={item.id}
                  aria-pressed={selected}
                  aria-label={item.id}
                  disabled={broken}
                  onClick={() => onSelect(item.id)}
                  onDoubleClick={() => onLaunch(item.id)}
                  title={broken ? item.error ?? undefined : '双击直接启动'}
                />
                <InstanceIcon folder={item.folder} versionId={item.id} size={32} />
                <span className="vrow__name">
                  <span className="vrow__id">{item.id}</span>
                  {broken ? <span className="vrow__err">{item.error}</span> : null}
                </span>
                <span className="vrow__loader">
                  <i style={{ background: LOADER_BIOME[item.loader] }} />
                  <span title={broken ? undefined : loaderLabel(item)}>
                    {broken ? '—' : LOADER_LABEL[item.loader]}
                    {!broken && item.loaderVersion && item.loader !== 'vanilla' ? <span className="vrow__ldver"> {item.loaderVersion}</span> : null}
                  </span>
                </span>
                <span className="vrow__num">{item.minecraftVersion ?? '—'}</span>
                <span className="vrow__num" data-zero={item.modCount === 0 ? '1' : undefined}>
                  {item.modCount || '—'}
                </span>
                <IconButton aria-label={`管理 ${item.id}`} size="sm" className="vrow__manage" onPress={() => onManage(item.id)}>
                  <Settings2 size={16} />
                </IconButton>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
