import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Plus, Shirt } from 'lucide-react'
import type { Account } from '../../shared/api.ts'
import { accountKindLabel, accountStatus } from './labels.ts'
import { AvatarStage } from './AvatarStage.tsx'
import { refreshSkin, SkinHead } from './SkinHead.tsx'

const WHEEL_THRESHOLD = 40
const WHEEL_COOLDOWN_MS = 700

interface Props {
  accounts: Account[]
  selectedId: string | null
  onSelect(id: string): void
  onAdd(): void
}

/** 左栏的账号：三渲二的半身像，左右甩切换；下面一排小脸可以直接点。 */
export function AccountRing({ accounts, selectedId, onSelect, onAdd }: Props): ReactElement {
  const index = Math.max(0, accounts.findIndex((account) => account.id === selectedId))
  const current = accounts[index]
  const stage = useRef<HTMLDivElement>(null)
  const wheel = useRef({ sum: 0, lockedUntil: 0 })
  const [direction, setDirection] = useState<1 | -1>(1)
  const [skinError, setSkinError] = useState('')

  const pickSkin = async (account: Account): Promise<void> => {
    setSkinError('')
    try {
      const info = await window.craft.pickSkin(account.id)
      if (info) refreshSkin(account.id, info)
    } catch (cause) {
      setSkinError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause))
    }
  }

  const go = useCallback(
    (next: number): void => {
      if (accounts.length < 2) return
      // 两头相接：甩到最后一个再往后就回到第一个
      const wrapped = (next + accounts.length) % accounts.length
      const target = accounts[wrapped]
      if (!target || target.id === current?.id) return
      setDirection(next > index ? 1 : -1)
      onSelect(target.id)
    },
    [accounts, current?.id, index, onSelect]
  )

  useEffect(() => {
    const element = stage.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (delta === 0 || accounts.length < 2) return
      event.preventDefault()
      const now = performance.now()
      if (now < wheel.current.lockedUntil) return
      wheel.current.sum += delta
      if (Math.abs(wheel.current.sum) < WHEEL_THRESHOLD) return
      const step = wheel.current.sum > 0 ? 1 : -1
      wheel.current = { sum: 0, lockedUntil: now + WHEEL_COOLDOWN_MS }
      go(index + step)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [accounts.length, go, index])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') go(index - 1)
    else if (event.key === 'ArrowRight') go(index + 1)
    else return
    event.preventDefault()
  }

  return (
    <div className="who">
      <div
        ref={stage}
        className="who__stage"
        tabIndex={0}
        role="group"
        aria-roledescription="账号切换"
        aria-label={current ? `当前账号 ${current.name}，${index + 1} / ${accounts.length}，左右拖动头像、滚轮或方向键切换` : '账号'}
        onKeyDown={onKeyDown}
      >
        {current ? <AvatarStage account={current} direction={direction} onSwipe={(dir) => go(index + dir)} /> : null}
      </div>
      {current ? (
        <div className="who__text" key={current.id} data-dir={direction}>
          <div className="who__name">{current.name}</div>
          <div className="who__meta">
            {accountKindLabel(current)} · {accountStatus(current)}
          </div>
          {current.kind === 'offline' ? (
            <button type="button" className="who__skin" onClick={() => void pickSkin(current)}>
              <Shirt size={14} aria-hidden="true" />
              更换皮肤
            </button>
          ) : null}
          {skinError ? <div className="who__error" role="alert">{skinError}</div> : null}
        </div>
      ) : null}
      <div className="who__list" role="radiogroup" aria-label="账号">
        {accounts.map((account, position) => (
          <button
            key={account.id}
            type="button"
            role="radio"
            aria-checked={position === index}
            aria-label={account.name}
            title={account.name}
            className="who__pick"
            onClick={() => {
              if (position === index) return
              setDirection(position > index ? 1 : -1)
              onSelect(account.id)
            }}
          >
            <SkinHead account={account} size={26} />
          </button>
        ))}
        <button type="button" className="who__pick who__add" aria-label="添加账号" title="添加账号" onClick={onAdd}>
          <Plus size={16} />
        </button>
      </div>
      <div className="sr-only" aria-live="polite">
        {current ? `已切换到 ${current.name}（${accountKindLabel(current)}）` : ''}
      </div>
    </div>
  )
}
