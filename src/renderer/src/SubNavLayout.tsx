import { useLayoutEffect, useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Focusable, TooltipTrigger } from 'react-aria-components'
import { IconButton } from './ui/IconButton'
import { Tooltip } from './ui/Tooltip'

export interface SubNavItem<T extends string> {
  id: T
  label: string
  icon: ReactNode
}

export interface SubNavGroup<T extends string> {
  label?: string
  items: SubNavItem<T>[]
}

interface Props<T extends string> {
  label: string
  groups: SubNavGroup<T>[]
  active: T
  onChange(id: T): void
  header?: ReactNode
  onBack?: () => void
  backLabel?: string
  /** 左栏底部：放这一页的主操作（大按钮），和启动页的「启动游戏」同一个位置 */
  footer?: ReactNode
  children: ReactNode
}

export function SubNavLayout<T extends string>({ label, groups, active, onChange, header, onBack, backLabel, footer, children }: Props<T>): ReactElement {
  const nav = useRef<HTMLElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)

  // 选中滑块：量出当前项的位置，弹簧滑过去（和顶栏标签同一种手感）
  useLayoutEffect(() => {
    const list = nav.current
    const slider = thumb.current
    if (!list || !slider) return
    const place = (): void => {
      const item = list.querySelector<HTMLElement>('.subnav__item[aria-current="page"]')
      if (!item) {
        slider.style.opacity = '0'
        return
      }
      // 一路加 offset 到导航为止（分组本身是定位元素）；不用 getBoundingClientRect，免得量到落入动画的半路
      let x = 0
      let y = 0
      for (let node: HTMLElement | null = item; node && node !== list; node = node.offsetParent as HTMLElement | null) {
        x += node.offsetLeft
        y += node.offsetTop
      }
      slider.style.opacity = '1'
      slider.style.height = `${item.offsetHeight}px`
      slider.style.width = `${item.offsetWidth}px`
      slider.style.transform = `translate(${x}px, ${y}px)`
      // 第一次直接放到位，之后才滑；第一次和所在分组一起落下来（同一个延迟），落入途中不会错位
      if (!slider.dataset.ready) {
        const group = item.closest<HTMLElement>('.subnav > *')
        if (group) slider.style.animationDelay = getComputedStyle(group).animationDelay
        requestAnimationFrame(() => (slider.dataset.ready = '1'))
      }
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(list)
    return () => observer.disconnect()
  }, [active, groups])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.subnav__item')]
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1) % items.length
            : index <= 0
              ? items.length - 1
              : index - 1
    items[next]?.focus()
    event.preventDefault()
  }

  return (
    <div className="subnav-layout">
      <nav ref={nav} className="subnav" aria-label={label} onKeyDown={onKeyDown}>
        <span ref={thumb} className="subnav__thumb" aria-hidden="true" />
        {onBack ? (
          <div className="subnav__back">
            <IconButton aria-label={backLabel ?? '返回'} size="sm" onPress={onBack}>
              <ArrowLeft size={16} />
            </IconButton>
            <div className="subnav__header">{header}</div>
          </div>
        ) : header ? (
          <div className="subnav__header subnav__header--plain">{header}</div>
        ) : null}
        {groups.map((group, index) => (
          <div key={group.label ?? index} className="subnav__group" role="group" aria-label={group.label}>
            {group.label ? <div className="subnav__group-label">{group.label}</div> : null}
            {group.items.map((item) => (
              <TooltipTrigger key={item.id} delay={400}>
                <Focusable>
                  <button type="button" className="subnav__item" aria-label={item.label} aria-current={item.id === active ? 'page' : undefined} onClick={() => onChange(item.id)}>
                    <span className="subnav__icon" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span className="subnav__label">{item.label}</span>
                  </button>
                </Focusable>
                <Tooltip placement="right" className="subnav__tip">
                  {item.label}
                </Tooltip>
              </TooltipTrigger>
            ))}
          </div>
        ))}
        {footer ? <div className="subnav__footer">{footer}</div> : null}
      </nav>
      {/* 换分区时内容重新挂载，按「落入」节奏重新出现 */}
      <div className="subnav-content" key={active}>
        {children}
      </div>
    </div>
  )
}

interface PageHeadProps {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}

export function PageHead({ title, description, actions }: PageHeadProps): ReactElement {
  return (
    <header className="page-head">
      <div className="page-head__text">
        <h1 className="page-head__title">{title}</h1>
        {description ? <p className="page-head__desc">{description}</p> : null}
      </div>
      {actions ? <div className="page-head__actions">{actions}</div> : null}
    </header>
  )
}

interface EmptyBlockProps {
  icon?: ReactNode
  title: string
  children?: ReactNode
  actions?: ReactNode
}

export function EmptyBlock({ icon, title, children, actions }: EmptyBlockProps): ReactElement {
  return (
    <div className="empty-block">
      {icon ? (
        <span className="empty-block__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <h2 className="empty-block__title">{title}</h2>
      {children ? <p className="empty-block__text">{children}</p> : null}
      {actions ? <div className="empty-block__actions">{actions}</div> : null}
    </div>
  )
}
