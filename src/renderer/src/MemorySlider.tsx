import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { Slider, SliderThumb, SliderTrack } from 'react-aria-components'
import type { SystemMemory } from '../../shared/api.ts'
import { memoryLabel } from './labels.ts'

const STEP = 512
const MIN = 1024

let cached: Promise<SystemMemory> | null = null

/** 本机内存只读一次；拿不到时按 16 GB 估 */
export function useSystemMemory(): SystemMemory | null {
  const [memory, setMemory] = useState<SystemMemory | null>(null)
  useEffect(() => {
    let alive = true
    cached ??= window.craft.systemMemory().catch(() => ({ totalMb: 16384, freeMb: 8192 }))
    void cached.then((value) => alive && setMemory(value))
    return () => {
      alive = false
    }
  }, [])
  return memory
}

/** 数字慢慢追到目标值（ease-out），不是一下跳过去 */
function useTween(target: number, ms = 260): number {
  const [current, setCurrent] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    const start = performance.now()
    const origin = from.current
    let raf = 0
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / ms)
      const value = origin + (target - origin) * (1 - Math.pow(1 - t, 3))
      from.current = value
      setCurrent(value)
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return current
}

function snap(value: number): number {
  return Math.round(value / STEP) * STEP
}

export function memoryRange(totalMb: number): { max: number; low: number; high: number } {
  const max = Math.max(4096, snap(Math.min(totalMb * 0.9, 65536)))
  const high = Math.max(2048, Math.min(8192, snap(totalMb / 2)))
  const low = Math.min(4096, high)
  return { max, low, high }
}

interface Props {
  value: number
  onCommit(value: number): void
  label?: string
  isDisabled?: boolean
}

export function MemorySlider({ value, onCommit, label = '最大内存', isDisabled }: Props): ReactElement {
  const memory = useSystemMemory()
  const total = memory?.totalMb ?? 16384
  const { max, low, high } = memoryRange(total)
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const shown = Math.min(Math.max(draft, MIN), max)
  const pct = (mb: number) => `${((Math.min(Math.max(mb, MIN), max) - MIN) / (max - MIN)) * 100}%`
  const tone = shown > total * 0.75 ? 'fail' : shown < 2048 ? 'warn' : shown >= low && shown <= high ? 'ok' : 'neutral'
  const hint =
    tone === 'fail'
      ? '超过本机内存的四分之三，系统和游戏都可能变卡'
      : tone === 'warn'
        ? '太少了，1.13 以后的版本可能进不去'
        : tone === 'ok'
          ? '在推荐范围里'
          : shown > high
            ? '大型整合包才需要这么多'
            : '原版够用，装 Mod 可以再加'
  const take = (next: number | number[]) => (Array.isArray(next) ? (next[0] ?? MIN) : next)
  const tweened = useTween(shown)
  const display = Math.abs(tweened - shown) < 8 ? memoryLabel(shown) : `${(tweened / 1024).toFixed(1)} GB`
  // 填充是一条铺满整条轨道的渐变（推荐区内绿 → 偏多变黄 → 超过 3/4 变红），按当前值裁出左边一段
  const gradient = {
    '--fill': pct(shown),
    '--g-ok': pct(high),
    '--g-warn': pct(Math.max(high + STEP, total * 0.6)),
    '--g-fail': pct(total * 0.75)
  } as CSSProperties

  return (
    <Slider
      className="mem-slider"
      aria-label={label}
      minValue={MIN}
      maxValue={max}
      step={STEP}
      value={shown}
      isDisabled={isDisabled}
      onChange={(next) => setDraft(take(next))}
      onChangeEnd={(next) => onCommit(take(next))}
      data-tone={tone}
    >
      <div className="mem-slider__head">
        <output className="mem-slider__value">{display}</output>
        <span key={hint} className="mem-slider__hint">
          {hint}
        </span>
      </div>
      <SliderTrack className="mem-slider__track">
        <span className="mem-slider__zone" style={{ '--from': pct(low), '--to': pct(high) } as CSSProperties} aria-hidden="true" />
        <span className="mem-slider__fill" style={gradient} aria-hidden="true" />
        <SliderThumb className="ui-slider__thumb" />
      </SliderTrack>
      <div className="mem-slider__scale" aria-hidden="true">
        <span>{memoryLabel(MIN)}</span>
        <span>
          推荐 {memoryLabel(low)}–{memoryLabel(high)}
          {memory ? ` · 本机 ${memoryLabel(snap(total))}，空闲 ${memoryLabel(snap(memory.freeMb))}` : ''}
        </span>
        <span>{memoryLabel(max)}</span>
      </div>
    </Slider>
  )
}
