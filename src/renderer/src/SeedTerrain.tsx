import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { chunkOrder, dissolveOrder, renderTerrain } from './terrain.ts'

const DISSOLVE_MS = 560
/** 开屏区块加载的总时长，以及每个区块从冒出到落定的时长 */
const REVEAL_MS = 1250
const POP = 0.16
const iconCache = new Map<string, Uint8ClampedArray<ArrayBuffer>>()

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface IconProps {
  seed: string
  size?: number
  className?: string
}

const ICON_CELLS = 12

/** 小图块：版本没有自带图标时的标识。 */
export function TerrainIcon({ seed, size = 28, className }: IconProps): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    let pixels = iconCache.get(seed)
    if (!pixels) {
      pixels = renderTerrain(seed, { cols: ICON_CELLS, rows: ICON_CELLS, scale: 2.4 })
      iconCache.set(seed, pixels)
    }
    context.putImageData(new ImageData(pixels, ICON_CELLS, ICON_CELLS), 0, 0)
  }, [seed])
  return (
    <canvas
      ref={canvas}
      className={className ? `terrain-icon ${className}` : 'terrain-icon'}
      width={ICON_CELLS}
      height={ICON_CELLS}
      style={{ '--icon': `${size}px` } as CSSProperties}
      aria-hidden="true"
    />
  )
}

interface BandProps {
  seed: string
  /** 一格的屏幕像素 */
  cell?: number
  className?: string
}

/** 大图带：铺满容器，换种子时逐格溶解到新地图。 */
export function TerrainBand({ seed, cell = 6, className }: BandProps): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const shown = useRef<{ seed: string; cols: number; rows: number; pixels: Uint8ClampedArray<ArrayBuffer> } | null>(null)
  const [grid, setGrid] = useState<{ cols: number; rows: number } | null>(null)
  /** 开屏加载开始的时间；加载途中换了种子（启动页刚读到版本）就接着用新地图加载完 */
  const revealAt = useRef<number | null>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return
    const measure = (): void => {
      const cols = Math.max(1, Math.ceil(element.clientWidth / cell))
      const rows = Math.max(1, Math.ceil(element.clientHeight / cell))
      setGrid((prev) => (prev && prev.cols === cols && prev.rows === rows ? prev : { cols, rows }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [cell])

  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context || !grid) return
    const { cols, rows } = grid
    const next = renderTerrain(seed, { cols, rows, scale: 1 })
    const previous = shown.current
    shown.current = { seed, cols, rows, pixels: next }
    const sameGrid = previous && previous.cols === cols && previous.rows === rows
    const revealing = revealAt.current !== null && performance.now() - revealAt.current < REVEAL_MS
    if ((!previous || revealing) && !prefersReducedMotion()) {
      // 开屏：区块从中间往外一块块加载出来，刚出来的区块亮一下再落定
      const order = chunkOrder(cols, rows, 'reveal')
      const frame = new ImageData(cols, rows)
      revealAt.current ??= performance.now()
      const start = revealAt.current
      let raf = 0
      const step = (now: number): void => {
        const t = Math.min(1, (now - start) / REVEAL_MS)
        const out = frame.data
        for (let i = 0; i < order.length; i += 1) {
          const at = i * 4
          const local = (t * (1 + POP) - order[i]) / POP
          if (local <= 0) {
            out[at + 3] = 0
            continue
          }
          const glow = local >= 1 ? 0 : (1 - local) * 0.55
          out[at] = next[at] + (255 - next[at]) * glow
          out[at + 1] = next[at + 1] + (255 - next[at + 1]) * glow
          out[at + 2] = next[at + 2] + (255 - next[at + 2]) * glow
          out[at + 3] = 255
        }
        context.putImageData(frame, 0, 0)
        if (t < 1) raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
      return () => cancelAnimationFrame(raf)
    }
    if (!previous || !sameGrid || previous.seed === seed || prefersReducedMotion()) {
      context.putImageData(new ImageData(next, cols, rows), 0, 0)
      return
    }
    const order = dissolveOrder(cols, rows, seed)
    const frame = new ImageData(cols, rows)
    const from = previous.pixels
    const start = performance.now()
    let raf = 0
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / DISSOLVE_MS)
      const progress = 1 - Math.pow(1 - t, 3)
      const out = frame.data
      for (let i = 0; i < order.length; i += 1) {
        const source = order[i] < progress ? next : from
        const at = i * 4
        out[at] = source[at]
        out[at + 1] = source[at + 1]
        out[at + 2] = source[at + 2]
        out[at + 3] = 255
      }
      context.putImageData(frame, 0, 0)
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [seed, grid])

  return (
    <div ref={host} className={className ? `terrain-band ${className}` : 'terrain-band'} aria-hidden="true">
      <canvas
        ref={canvas}
        width={grid?.cols ?? 1}
        height={grid?.rows ?? 1}
        style={grid ? { width: grid.cols * cell, height: grid.rows * cell } : undefined}
      />
    </div>
  )
}
