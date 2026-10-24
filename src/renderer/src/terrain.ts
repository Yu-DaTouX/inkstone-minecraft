// 以版本名为种子生成俯视地形，配色与明暗规则取自 Minecraft 地图物品：
// 每格颜色由生物群系决定，再按与北侧格的高差调亮或调暗。

type Rgb = readonly [number, number, number]

const DEEP: Rgb = [31, 63, 99]
const OCEAN: Rgb = [44, 91, 133]
const SHALLOW: Rgb = [64, 122, 164]
const BEACH: Rgb = [216, 197, 142]
const PLAINS: Rgb = [127, 178, 58]
const FOREST: Rgb = [79, 138, 46]
const DARK_FOREST: Rgb = [58, 104, 37]
const SAVANNA: Rgb = [168, 169, 72]
const DESERT: Rgb = [220, 194, 124]
const BADLANDS: Rgb = [184, 100, 58]
const CHERRY: Rgb = [233, 166, 194]
const SNOWY: Rgb = [226, 234, 236]
const STONE: Rgb = [138, 143, 147]
const PEAK: Rgb = [244, 247, 248]

export function seedOf(text: string): number {
  let hash = 2166136261
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function lattice(seed: number, x: number, y: number): number {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = smooth(x - x0)
  const fy = smooth(y - y0)
  const a = lattice(seed, x0, y0)
  const b = lattice(seed, x0 + 1, y0)
  const c = lattice(seed, x0, y0 + 1)
  const d = lattice(seed, x0 + 1, y0 + 1)
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

function fbm(seed: number, x: number, y: number, octaves: number): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  let norm = 0
  for (let i = 0; i < octaves; i += 1) {
    sum += valueNoise(seed + i * 1013, x * freq, y * freq) * amp
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return sum / norm
}

function biome(elevation: number, moisture: number, heat: number, rare: number): Rgb {
  if (elevation < 0.34) return DEEP
  if (elevation < 0.42) return OCEAN
  if (elevation < 0.46) return SHALLOW
  if (elevation < 0.48) return heat < 0.24 ? SNOWY : BEACH
  if (elevation > 0.78) return PEAK
  if (elevation > 0.69) return heat < 0.3 ? SNOWY : STONE
  if (heat < 0.24) return SNOWY
  if (heat > 0.66) {
    if (moisture < 0.38) return elevation > 0.58 ? BADLANDS : DESERT
    return SAVANNA
  }
  if (rare > 0.8 && moisture > 0.5) return CHERRY
  if (moisture > 0.62) return DARK_FOREST
  if (moisture > 0.48) return FOREST
  return PLAINS
}

export interface TerrainView {
  /** 采样的格数 */
  cols: number
  rows: number
  /** 一格在噪声空间里的大小，越大地形越碎 */
  scale: number
  /** 视野中心，噪声空间坐标 */
  originX?: number
  originY?: number
}

/** 生成 RGBA 像素（一格一像素），由 CSS 放大并保持像素感。 */
export function renderTerrain(text: string, view: TerrainView): Uint8ClampedArray<ArrayBuffer> {
  const seed = seedOf(text)
  const { cols, rows, scale } = view
  const ox = (view.originX ?? 0) - (cols * scale) / 2 + (seed % 997)
  const oy = (view.originY ?? 0) - (rows * scale) / 2 + ((seed >>> 10) % 991)
  const heights = new Float32Array(cols * (rows + 1))
  const sample = (col: number, row: number): number => {
    const x = ox + col * scale
    const y = oy + row * scale
    const warp = (fbm(seed ^ 0x5bd1, x * 0.08, y * 0.08, 2) - 0.5) * 1.6
    return fbm(seed, x * 0.055 + warp, y * 0.055 - warp, 4)
  }
  for (let row = -1; row < rows; row += 1) for (let col = 0; col < cols; col += 1) heights[(row + 1) * cols + col] = sample(col, row)
  const data = new Uint8ClampedArray(cols * rows * 4)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = ox + col * scale
      const y = oy + row * scale
      const elevation = heights[(row + 1) * cols + col]
      const north = heights[row * cols + col]
      const moisture = fbm(seed ^ 0x9e37, x * 0.035, y * 0.035, 3)
      const heat = fbm(seed ^ 0x2c1b, x * 0.018, y * 0.018, 2)
      const rare = fbm(seed ^ 0x7f4a, x * 0.04, y * 0.04, 2)
      const color = biome(elevation, moisture, heat, rare)
      const water = elevation < 0.46
      const delta = elevation - north
      const shade = water ? (((col + row) & 1) === 0 ? 0.97 : 1) * (0.9 + elevation * 0.25) : delta > 0.006 ? 1.08 : delta < -0.006 ? 0.84 : 0.96
      const at = (row * cols + col) * 4
      data[at] = color[0] * shade
      data[at + 1] = color[1] * shade
      data[at + 2] = color[2] * shade
      data[at + 3] = 255
    }
  }
  return data
}

/** 每格一个 0–1 的溶解阈值，过渡时阈值低于进度的格先换成新地图。 */
/**
 * 开屏时区块的加载顺序：以 8×8 格为一个区块，从中间往外一圈圈加载，同一圈里先后有点乱，
 * 像进世界时区块一块块冒出来。返回每格的 0–1 出现时刻。
 */
export function chunkOrder(cols: number, rows: number, text: string, chunk = 8): Float32Array {
  const seed = seedOf(text) ^ 0x51ed
  const order = new Float32Array(cols * rows)
  const cx = cols / chunk / 2
  const cy = rows / chunk / 2
  const far = Math.hypot(cx, cy) || 1
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const kx = Math.floor(col / chunk)
      const ky = Math.floor(row / chunk)
      const distance = Math.hypot(kx + 0.5 - cx, ky + 0.5 - cy) / far
      order[row * cols + col] = Math.min(0.999, distance * 0.82 + lattice(seed, kx, ky) * 0.16)
    }
  }
  return order
}

export function dissolveOrder(cols: number, rows: number, text: string): Float32Array {
  const seed = seedOf(text) ^ 0x3c6e
  const order = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      // 从左上向右下扫，叠一层随机，像地图逐格探索出来
      const sweep = (col / cols) * 0.55 + (row / rows) * 0.2
      order[row * cols + col] = Math.min(0.999, sweep + lattice(seed, col, row) * 0.42)
    }
  }
  return order
}
