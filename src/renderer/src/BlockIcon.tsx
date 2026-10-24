// 版本图标：一个等轴方块，用那次大更新的标志性方块（1.20 樱花木板、1.19 幽匿块……），
// 快照是命令方块，远古版本是圆石。贴图全是代码按像素生成的 16×16，没有用游戏素材。
import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react'

type Rgb = [number, number, number]
type Texture = Uint8ClampedArray

interface Block {
  name: string
  top: () => Texture
  side: () => Texture
}

const N = 16

function hex(value: string): Rgb {
  const n = Number.parseInt(value.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 按坐标和种子算出 0–1 的伪随机数，同一个方块每次长得一样 */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function texture(paint: (x: number, y: number) => Rgb): Texture {
  const data = new Uint8ClampedArray(N * N * 4)
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const [r, g, b] = paint(x, y)
      const at = (y * N + x) * 4
      data[at] = r
      data[at + 1] = g
      data[at + 2] = b
      data[at + 3] = 255
    }
  }
  return data
}

const pick = (palette: string[], t: number): Rgb => hex(palette[Math.min(palette.length - 1, Math.floor(t * palette.length))])

/** 杂色：泥土、沙子、混凝土粉末那种 */
const noise = (palette: string[], seed: number) => () => texture((x, y) => pick(palette, hash(x, y, seed)))

/** 木板：四行一块，块与块之间一道暗缝，每块错开一道竖缝 */
const planks = (palette: string[], seam: string, seed: number) => () =>
  texture((x, y) => {
    const row = Math.floor(y / 4)
    if (y % 4 === 3) return hex(seam)
    if ((x + row * 7) % 16 === (row % 2 ? 4 : 11)) return hex(seam)
    return pick(palette, hash(x, row, seed) * 0.5 + hash(x, y, seed) * 0.5)
  })

/** 石头一类：随机撒几个点，按最近的点分块，块边描暗 */
const cells = (palette: string[], edge: string, seed: number, count = 11) => () => {
  const points = Array.from({ length: count }, (_, i) => [hash(i, 1, seed) * N, hash(i, 2, seed) * N] as const)
  const owner = (x: number, y: number): number => {
    let best = 0
    let distance = Infinity
    points.forEach(([px, py], i) => {
      const dx = Math.min(Math.abs(x - px), N - Math.abs(x - px))
      const dy = Math.min(Math.abs(y - py), N - Math.abs(y - py))
      const d = dx * dx + dy * dy
      if (d < distance) {
        distance = d
        best = i
      }
    })
    return best
  }
  return texture((x, y) => {
    const id = owner(x, y)
    if (owner((x + 1) % N, y) !== id || owner(x, (y + 1) % N) !== id) return hex(edge)
    return pick(palette, hash(id, 0, seed) * 0.6 + hash(x, y, seed) * 0.4)
  })
}

/** 草方块一类的侧面：上面几行是顶层颜色，往下滴几滴 */
const capped = (cap: string[], under: string[], seed: number) => () =>
  texture((x, y) => {
    const drip = 3 + Math.floor(hash(x, 7, seed) * 3)
    return y < drip ? pick(cap, hash(x, y, seed)) : pick(under, hash(x, y, seed + 1))
  })

/** 斑点：底色上撒亮点（幽匿、紫水晶、岩浆块） */
const spots = (base: string[], spot: string[], seed: number, density: number) => () =>
  texture((x, y) => {
    const near = hash(Math.floor(x / 2), Math.floor(y / 2), seed + 9) < density
    return near && hash(x, y, seed + 3) < 0.7 ? pick(spot, hash(x, y, seed + 5)) : pick(base, hash(x, y, seed))
  })

/** 整块的金属/宝石块：亮边、暗边、中间杂色 */
const gem = (palette: string[], light: string, dark: string, seed: number) => () =>
  texture((x, y) => {
    if (x === 0 || y === 0) return hex(light)
    if (x === N - 1 || y === N - 1) return hex(dark)
    if ((x === 1 || y === 1) && hash(x, y, seed) < 0.5) return hex(light)
    return pick(palette, hash(x, y, seed))
  })

/** 方砖：8×8 一格，格边暗（紫珀、海晶石砖） */
const tiles = (palette: string[], edge: string, seed: number, size = 8) => () =>
  texture((x, y) => (x % size === size - 1 || y % size === size - 1 ? hex(edge) : pick(palette, hash(x, y, seed))))

/** 竖条纹，带两道横箍（干草块、木桶） */
const banded = (palette: string[], band: string, seed: number, rows: number[]) => () =>
  texture((x, y) => (rows.includes(y) ? hex(band) : pick(palette, x % 3 === 2 ? 0.05 : hash(x, Math.floor(y / 5), seed) * 0.5 + 0.5)))

/** 南瓜侧面：竖着的瓣 */
const ribs = (palette: string[], groove: string, seed: number) => () =>
  texture((x, y) => (x % 4 === 0 ? hex(groove) : pick(palette, hash(x, y, seed))))

/** 横纹：深板岩那种一层一层的 */
const layers = (palette: string[], seed: number) => () => texture((x, y) => pick(palette, hash(Math.floor(x / 3), y, seed) * 0.7 + hash(x, y, seed) * 0.3))

/** 命令方块：橙色外框、深色内框、中间一个箭头 */
const command = () =>
  texture((x, y) => {
    const ring = Math.min(x, y, N - 1 - x, N - 1 - y)
    if (ring === 0) return hex('#7a4a2a')
    if (ring < 4) return pick(['#c77a3b', '#d68a45', '#b86b30'], hash(x, y, 4))
    if (ring === 4) return hex('#3b3b3b')
    const arrow = y >= 6 && y <= 9 && x >= 6 && x <= 9 && Math.abs(x - 7.5) <= 9 - y + 0.5
    return arrow ? hex('#e8e8e8') : hex('#5a5a5a')
  })

const GRASS_TOP = ['#5f9c34', '#6aaa3a', '#7bbd45', '#558d2e']
const DIRT = ['#79553a', '#866043', '#5c3f2a', '#96704f']

const BLOCKS: Record<string, Block> = {
  grass: { name: '草方块', top: noise(GRASS_TOP, 1), side: capped(GRASS_TOP, DIRT, 1) },
  cobblestone: { name: '圆石', top: cells(['#7d7d7d', '#8f8f8f', '#6b6b6b', '#a0a0a0'], '#4a4a4a', 2), side: cells(['#7d7d7d', '#8f8f8f', '#6b6b6b', '#a0a0a0'], '#4a4a4a', 3) },
  mossy: { name: '苔石', top: cells(['#6e7a5a', '#5e7a3e', '#808080', '#4f6b36'], '#3d4433', 4), side: cells(['#6e7a5a', '#5e7a3e', '#808080', '#4f6b36'], '#3d4433', 5) },
  oak: { name: '橡木木板', top: planks(['#b8945f', '#a8864f', '#c29d66'], '#7a5c33', 6), side: planks(['#b8945f', '#a8864f', '#c29d66'], '#7a5c33', 7) },
  command: { name: '命令方块', top: command, side: command },
  jungle: { name: '丛林原木', top: planks(['#a5754f', '#b4835a'], '#7d5638', 8), side: ribs(['#56431e', '#4a3a19', '#5e4c25'], '#3a2c12', 8) },
  emerald: { name: '绿宝石块', top: gem(['#2fcf6a', '#41dc7b', '#22b25a'], '#9ff2bd', '#13803e', 9), side: gem(['#2fcf6a', '#41dc7b', '#22b25a'], '#9ff2bd', '#13803e', 9) },
  pumpkin: { name: '南瓜', top: noise(['#c47614', '#d2841c', '#b86c10'], 10), side: ribs(['#e08a1e', '#d27c16', '#ea9a2c'], '#a85c0c', 10) },
  redstone: { name: '红石块', top: gem(['#b0190f', '#c42617', '#9a130b'], '#ff6a50', '#640a05', 11), side: gem(['#b0190f', '#c42617', '#9a130b'], '#ff6a50', '#640a05', 11) },
  hay: { name: '干草块', top: noise(['#c9a52a', '#b38f1f', '#d8b437'], 12), side: banded(['#a8821a', '#c9a52a', '#dcbc3e'], '#8a3a1c', 12, [2, 3, 12, 13]) },
  redsand: { name: '红沙', top: noise(['#be6621', '#c97330', '#ad5a1c', '#d47e3a'], 13), side: noise(['#be6621', '#c97330', '#ad5a1c', '#d47e3a'], 14) },
  prismarine: { name: '海晶石', top: noise(['#5aa392', '#6bb5a0', '#4a8f86', '#7cc0b0', '#5f8f9c'], 15), side: noise(['#5aa392', '#6bb5a0', '#4a8f86', '#7cc0b0', '#5f8f9c'], 16) },
  purpur: { name: '紫珀块', top: tiles(['#a97ca9', '#b48ab4', '#9e6f9e'], '#7a527a', 17), side: tiles(['#a97ca9', '#b48ab4', '#9e6f9e'], '#7a527a', 18) },
  magma: { name: '岩浆块', top: spots(['#4a1a0c', '#5c220e', '#3a1408'], ['#ff8a1c', '#e8641a', '#ffb43a'], 19, 0.45), side: spots(['#4a1a0c', '#5c220e', '#3a1408'], ['#ff8a1c', '#e8641a', '#ffb43a'], 20, 0.45) },
  darkoak: { name: '深色橡木木板', top: planks(['#4a3018', '#553820', '#402812'], '#2a1a0a', 21), side: planks(['#4a3018', '#553820', '#402812'], '#2a1a0a', 22) },
  concrete: { name: '黄绿色混凝土', top: noise(['#5ea918', '#62ad1c', '#5aa414'], 23), side: noise(['#5ea918', '#62ad1c', '#5aa414'], 24) },
  coral: { name: '管珊瑚块', top: spots(['#3456d4', '#2a48c2', '#3d62e0'], ['#6a8cff', '#1c35a0'], 25, 0.5), side: spots(['#3456d4', '#2a48c2', '#3d62e0'], ['#6a8cff', '#1c35a0'], 26, 0.5) },
  barrel: { name: '木桶', top: tiles(['#8a6239', '#7a5530', '#96703f'], '#4f3519', 27, 16), side: banded(['#7a5530', '#8a6239', '#96703f'], '#4a4a4a', 27, [1, 14]) },
  honey: { name: '蜜脾块', top: tiles(['#e5a12a', '#f0b23a', '#d68f1e'], '#a8650c', 28, 4), side: tiles(['#e5a12a', '#f0b23a', '#d68f1e'], '#a8650c', 29, 4) },
  crimson: { name: '绯红菌岩', top: noise(['#9a1a1a', '#b02424', '#7f1414', '#c23a2a'], 30), side: capped(['#9a1a1a', '#b02424', '#7f1414'], ['#6b2a2a', '#7a3030', '#5a2222', '#8a3a3a'], 30) },
  amethyst: { name: '紫水晶块', top: spots(['#7a55b8', '#8a63c8', '#6a48a3'], ['#c9a6f2', '#e4cdfc'], 31, 0.35), side: spots(['#7a55b8', '#8a63c8', '#6a48a3'], ['#c9a6f2', '#e4cdfc'], 32, 0.35) },
  deepslate: { name: '深板岩', top: noise(['#4d4d52', '#58585e', '#424247', '#626268'], 33), side: layers(['#3f3f44', '#4d4d52', '#58585e', '#36363a'], 34) },
  sculk: { name: '幽匿块', top: spots(['#0c1f26', '#0f2a33', '#0a1a20'], ['#2fd3d8', '#1aa7b0', '#7ef5f0'], 35, 0.3), side: spots(['#0c1f26', '#0f2a33', '#0a1a20'], ['#2fd3d8', '#1aa7b0'], 36, 0.3) },
  cherry: { name: '樱花木板', top: planks(['#e8b4b0', '#f0c3be', '#dca29f'], '#b87c7a', 37), side: planks(['#e8b4b0', '#f0c3be', '#dca29f'], '#b87c7a', 38) },
  copper: { name: '铜块', top: gem(['#c06a48', '#cf7a56', '#b05e3e', '#d98a63'], '#f0a682', '#8a4228', 39), side: gem(['#c06a48', '#cf7a56', '#b05e3e', '#d98a63'], '#f0a682', '#8a4228', 39) },
  paleoak: { name: '苍白橡木木板', top: planks(['#e6dcd6', '#ddd2cb', '#efe7e2'], '#b5aaa2', 40), side: planks(['#e6dcd6', '#ddd2cb', '#efe7e2'], '#b5aaa2', 41) }
}

const BY_MINOR: Record<number, string> = {
  2: 'jungle',
  3: 'emerald',
  4: 'pumpkin',
  5: 'redstone',
  6: 'hay',
  7: 'redsand',
  8: 'prismarine',
  9: 'purpur',
  10: 'magma',
  11: 'darkoak',
  12: 'concrete',
  13: 'coral',
  14: 'barrel',
  15: 'honey',
  16: 'crimson',
  17: 'amethyst',
  18: 'deepslate',
  19: 'sculk',
  20: 'cherry',
  21: 'copper'
}

/** 从版本号（也接受「1.21.1-Fabric 0.16」这样的实例名）挑方块 */
export function blockFor(version: string): string {
  const id = version.trim().toLowerCase()
  // 周快照（24w14a）、新式快照（26.4-snapshot-5）、预发布和候选版都算快照
  if (/^\d{2}w\d{2}|-(snapshot|pre|rc)|pre-release|release candidate/.test(id)) return 'command'
  if (/^(b\d|beta)/.test(id)) return 'cobblestone'
  if (/^(a\d|alpha|c0\.|inf-|rd-)/.test(id)) return 'mossy'
  const match = /^(\d+)\.(\d+)/.exec(id)
  if (!match) return 'grass'
  const major = Number(match[1])
  const minor = Number(match[2])
  // 2026 起按年份编号（26.1…）
  if (major >= 25) return 'paleoak'
  if (major !== 1) return 'grass'
  return BY_MINOR[minor] ?? (minor > 21 ? 'paleoak' : 'grass')
}

export function blockName(version: string): string {
  return BLOCKS[blockFor(version)].name
}

const textures = new Map<string, { top: HTMLCanvasElement; side: HTMLCanvasElement }>()

function faceCanvas(data: Texture): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = N
  canvas.height = N
  canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(data), N, N), 0, 0)
  return canvas
}

function texturesOf(id: string): { top: HTMLCanvasElement; side: HTMLCanvasElement } {
  let found = textures.get(id)
  if (!found) {
    const block = BLOCKS[id] ?? BLOCKS.grass
    found = { top: faceCanvas(block.top()), side: faceCanvas(block.side()) }
    textures.set(id, found)
  }
  return found
}

/** 等轴画一个方块：顶面、左面、右面三次仿射贴图，左右面压暗，跟游戏里方块的明暗一致 */
function drawBlock(ctx: CanvasRenderingContext2D, id: string, size: number): void {
  const { top, side } = texturesOf(id)
  const w = size * 0.44
  const h = w * 1.12
  const cx = size / 2
  const y0 = (size - (w + h)) / 2
  const left = [cx - w, y0 + w / 2]
  const bottom = [cx, y0 + w]
  ctx.clearRect(0, 0, size, size)
  ctx.imageSmoothingEnabled = false
  const face = (image: HTMLCanvasElement, a: number, b: number, c: number, d: number, e: number, f: number, shade: number): void => {
    ctx.setTransform(a / N, b / N, c / N, d / N, e, f)
    ctx.drawImage(image, -0.03, -0.03, N + 0.06, N + 0.06)
    if (shade > 0) {
      ctx.fillStyle = `rgba(0, 0, 0, ${shade})`
      ctx.fillRect(-0.03, -0.03, N + 0.06, N + 0.06)
    }
  }
  face(top, w, -w / 2, w, w / 2, left[0], left[1], 0)
  face(side, w, w / 2, 0, h, left[0], left[1], 0.2)
  face(side, w, -w / 2, 0, h, bottom[0], bottom[1], 0.38)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

interface Props {
  version: string
  size?: number
  className?: string
}

export function BlockIcon({ version, size = 36, className }: Props): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null)
  const id = blockFor(version)
  useEffect(() => {
    const element = canvas.current
    const ctx = element?.getContext('2d')
    if (!element || !ctx) return
    const pixels = Math.round(size * (window.devicePixelRatio || 1))
    element.width = pixels
    element.height = pixels
    drawBlock(ctx, id, pixels)
  }, [id, size])
  return (
    <canvas
      ref={canvas}
      className={className ? `block-icon ${className}` : 'block-icon'}
      style={{ '--icon': `${size}px` } as CSSProperties}
      role="img"
      aria-label={BLOCKS[id].name}
    />
  )
}
