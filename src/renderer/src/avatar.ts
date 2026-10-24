// 三渲二玩家半身像：按皮肤贴图把头、身体、两条胳膊拼成方块模型（正交投影）。
// 本体每个面一次仿射贴图；外层（帽子、外套、袖子）照 3d-Skin-Layers 的做法，
// 每个像素挤成一个有厚度的小体素。明暗只分几档、外面描粗边，是「三渲二」的味道。
// 换账号时整个人变成一颗颗带明暗的小方块（见 AvatarStage 的爆炸）。

export type Vec = [number, number, number]
export type Rgb = [number, number, number]
export type Part = 'head' | 'body' | 'armR' | 'armL'

export interface Pose {
  /** 整个人的朝向与镜头俯角 */
  yaw: number
  pitch: number
  /** 头相对身体的转动（看鼠标） */
  headYaw: number
  headPitch: number
  scale: number
  cx: number
  cy: number
  /** 胳膊绕肩膀的转动：[前后摆, 向外抬]，弧度；不填就是垂着 */
  armR?: [number, number]
  armL?: [number, number]
}

export interface Face {
  /** 面的左上角，以及每个贴图像素在模型里的横向、纵向步长 */
  o: Vec
  u: Vec
  v: Vec
  n: Vec
  w: number
  h: number
  /** 这个面在皮肤贴图里的左上角 */
  tex: [number, number]
  part: Part
  texels: Uint8ClampedArray
  shaded: Map<number, HTMLCanvasElement>
}

export interface VoxelQuad {
  corners: [Vec, Vec, Vec, Vec]
  center: Vec
  n: Vec
  /** 体素长在哪个面上；那个面背对镜头时整颗体素都不画 */
  parent: Vec
  color: Rgb
  part: Part
  outer: boolean
}

export interface Model {
  faces: Face[]
  voxels: VoxelQuad[]
  sheet: ImageData
}

interface Box {
  uv: [number, number]
  size: [number, number, number]
  center: Vec
  part: Part
}

/** 模型坐标：y 朝上，脖子在原点，单位是皮肤像素。外层贴图在本体贴图的固定偏移处。 */
function boxes(slim: boolean, legacy: boolean): { base: Box; overlay: [number, number] | null; thickness: number }[] {
  const arm = slim ? 3 : 4
  const armX = 4 + arm / 2
  return [
    { base: { uv: [0, 0], size: [8, 8, 8], center: [0, 4, 0], part: 'head' }, overlay: [32, 0], thickness: 0.5 },
    { base: { uv: [16, 16], size: [8, 12, 4], center: [0, -6, 0], part: 'body' }, overlay: legacy ? null : [16, 32], thickness: 0.35 },
    { base: { uv: [40, 16], size: [arm, 12, 4], center: [-armX, -6, 0], part: 'armR' }, overlay: legacy ? null : [40, 32], thickness: 0.35 },
    { base: { uv: legacy ? [40, 16] : [32, 48], size: [arm, 12, 4], center: [armX, -6, 0], part: 'armL' }, overlay: legacy ? null : [48, 48], thickness: 0.35 }
  ]
}

/** 方块的六个面在贴图里的位置（Minecraft 的标准展开），以及它们在模型里怎么摆。 */
function boxFaces(box: Box, uv: [number, number]): { tex: [number, number, number, number]; o: Vec; u: Vec; v: Vec; n: Vec }[] {
  const [w, h, d] = box.size
  const [u0, v0] = uv
  const [cx, cy, cz] = box.center
  const hx = w / 2
  const hy = h / 2
  const hz = d / 2
  return [
    { tex: [u0 + d, v0 + d, w, h], o: [cx - hx, cy + hy, cz + hz], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] },
    { tex: [u0 + d * 2 + w, v0 + d, w, h], o: [cx + hx, cy + hy, cz - hz], u: [-1, 0, 0], v: [0, -1, 0], n: [0, 0, -1] },
    { tex: [u0, v0 + d, d, h], o: [cx - hx, cy + hy, cz - hz], u: [0, 0, 1], v: [0, -1, 0], n: [-1, 0, 0] },
    { tex: [u0 + d + w, v0 + d, d, h], o: [cx + hx, cy + hy, cz + hz], u: [0, 0, -1], v: [0, -1, 0], n: [1, 0, 0] },
    { tex: [u0 + d, v0, w, d], o: [cx - hx, cy + hy, cz - hz], u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0] },
    { tex: [u0 + d + w, v0, w, d], o: [cx - hx, cy - hy, cz + hz], u: [1, 0, 0], v: [0, 0, -1], n: [0, -1, 0] }
  ]
}

const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k]
const neg = (a: Vec): Vec => [-a[0], -a[1], -a[2]]

/**
 * 外层像素挤成体素：顶面朝外，四周只在旁边没有像素的地方补侧面。
 * 两个面的外层在棱上会留一道缺口（各自只盖到本体的棱），斜着看就露馅。
 * 所以棱上的像素往外多伸出一个厚度把角补上：前后面横向伸，顶底面横竖都伸，左右面不伸，补出来的块互不重叠。
 */
function voxelize(face: { o: Vec; u: Vec; v: Vec; n: Vec }, w: number, h: number, sheet: ImageData, tx: number, ty: number, thickness: number, part: Part, out: VoxelQuad[], extU: boolean, extV: boolean): void {
  const solid = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < w && j < h && sheet.data[((ty + j) * sheet.width + tx + i) * 4 + 3] >= 128
  const lift = mul(face.n, thickness)
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      if (!solid(i, j)) continue
      const at = ((ty + j) * sheet.width + tx + i) * 4
      const color: Rgb = [sheet.data[at], sheet.data[at + 1], sheet.data[at + 2]]
      const before = (on: boolean, first: boolean) => (on && first ? thickness : 0)
      const su = 1 + before(extU, i === 0) + before(extU, i === w - 1)
      const sv = 1 + before(extV, j === 0) + before(extV, j === h - 1)
      const p = add(add(face.o, mul(face.u, i - before(extU, i === 0))), mul(face.v, j - before(extV, j === 0)))
      const pu = add(p, mul(face.u, su))
      const pv = add(p, mul(face.v, sv))
      const puv = add(pu, mul(face.v, sv))
      const quad = (corners: [Vec, Vec, Vec, Vec], n: Vec, outer: boolean): void => {
        const center = mul(corners.reduce((sum, corner) => add(sum, corner), [0, 0, 0] as Vec), 0.25)
        out.push({ corners, center, n, parent: face.n, color, part, outer })
      }
      quad([add(p, lift), add(pu, lift), add(puv, lift), add(pv, lift)], face.n, true)
      if (!solid(i - 1, j)) quad([p, pv, add(pv, lift), add(p, lift)], neg(face.u), false)
      if (!solid(i + 1, j)) quad([pu, puv, add(puv, lift), add(pu, lift)], face.u, false)
      if (!solid(i, j - 1)) quad([p, pu, add(pu, lift), add(p, lift)], neg(face.v), false)
      if (!solid(i, j + 1)) quad([pv, puv, add(puv, lift), add(pv, lift)], face.v, false)
    }
  }
}

/** 从 64×64 皮肤（旧版 64×32 也行）拼出模型。 */
export function buildModel(sheet: ImageData, slim: boolean): Model {
  const legacy = sheet.height < 64
  const faces: Face[] = []
  const voxels: VoxelQuad[] = []
  for (const { base, overlay, thickness } of boxes(slim, legacy)) {
    for (const face of boxFaces(base, base.uv)) {
      const [tx, ty, w, h] = face.tex
      const texels = new Uint8ClampedArray(w * h * 4)
      for (let j = 0; j < h; j += 1) {
        for (let i = 0; i < w; i += 1) {
          const from = ((ty + j) * sheet.width + tx + i) * 4
          const to = (j * w + i) * 4
          texels[to] = sheet.data[from]
          texels[to + 1] = sheet.data[from + 1]
          texels[to + 2] = sheet.data[from + 2]
          texels[to + 3] = 255
        }
      }
      faces.push({ o: face.o, u: face.u, v: face.v, n: face.n, w, h, tex: [tx, ty], part: base.part, texels, shaded: new Map() })
    }
    if (overlay) {
      boxFaces(base, overlay).forEach((face, index) => {
        const [tx, ty, w, h] = face.tex
        // 0 前 1 后 2 左 3 右 4 顶 5 底
        voxelize(face, w, h, sheet, tx, ty, thickness, base.part, voxels, index !== 2 && index !== 3, index >= 4)
      })
    }
  }
  return { faces, voxels, sheet }
}

function rotate(p: Vec, yaw: number, pitch: number): Vec {
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const x = p[0] * cy + p[2] * sy
  const z1 = -p[0] * sy + p[2] * cy
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  return [x, p[1] * cp - z1 * sp, p[1] * sp + z1 * cp]
}

/** 头自己的转动：先点头（绕头的横轴），再扭头（绕竖轴）。顺序反了头会歪着转。 */
function turnHead(p: Vec, yaw: number, pitch: number): Vec {
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const y = p[1] * cp - p[2] * sp
  const z = p[1] * sp + p[2] * cp
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  return [p[0] * cy + z * sy, y, -p[0] * sy + z * cy]
}

/** 胳膊绕肩膀转：先前后摆（绕 x 轴），再向外抬（绕 z 轴）。肩膀在胳膊顶往下 2 格。 */
function swingArm(p: Vec, side: number, swing: [number, number]): Vec {
  const [pitch, raise] = swing
  const px = side * 5
  const x = p[0] - px
  const y0 = p[1] + 2
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const y = y0 * cp - p[2] * sp
  const z = y0 * sp + p[2] * cp
  // 向外抬：右胳膊（在 -x 边）往 -x 转，左胳膊往 +x 转
  const angle = side * raise
  const cr = Math.cos(angle)
  const sr = Math.sin(angle)
  return [px + x * cr - y * sr, x * sr + y * cr - 2, z]
}

/** 先按部位转（头看鼠标、胳膊摆动），再整体转到镜头里。结果是镜头坐标：x 右、y 上、z 朝向观众。 */
export function place(p: Vec, part: Part, pose: Pose): Vec {
  let local = p
  if (part === 'head') local = turnHead(p, pose.headYaw, pose.headPitch)
  else if (part === 'armR' && pose.armR) local = swingArm(p, -1, pose.armR)
  else if (part === 'armL' && pose.armL) local = swingArm(p, 1, pose.armL)
  return rotate(local, pose.yaw, pose.pitch)
}

const ORIGIN: Vec = [0, 0, 0]

/** 只转方向不平移：法线、坐标轴用这个（胳膊绕肩膀转带了平移）。 */
export function orient(n: Vec, part: Part, pose: Pose): Vec {
  const a = place(n, part, pose)
  const o = place(ORIGIN, part, pose)
  return [a[0] - o[0], a[1] - o[1], a[2] - o[2]]
}

export function screen(p: Vec, pose: Pose): [number, number] {
  return [pose.cx + p[0] * pose.scale, pose.cy - p[1] * pose.scale]
}

/** 光从左上前方来。 */
export const LIGHT: Vec = (() => {
  const raw: Vec = [-0.55, 0.75, 0.6]
  const length = Math.hypot(...raw)
  return [raw[0] / length, raw[1] / length, raw[2] / length]
})()

/**
 * 明暗跟着面在模型里的朝向走，和游戏里一样：顶面最亮、正背面次之、两侧更暗、底面最暗。
 * 不随转动变化，头转来转去时不会有哪块突然变亮。
 */
export function toon(normal: Vec): number {
  if (normal[1] > 0.5) return 1.06
  if (normal[1] < -0.5) return 0.6
  if (Math.abs(normal[2]) > 0.5) return 0.94
  return normal[0] < 0 ? 0.8 : 0.72
}

export function rgb(color: Rgb, shade: number): string {
  return `rgb(${Math.min(255, Math.round(color[0] * shade))}, ${Math.min(255, Math.round(color[1] * shade))}, ${Math.min(255, Math.round(color[2] * shade))})`
}

function shadedCanvas(face: Face, shade: number): HTMLCanvasElement {
  let canvas = face.shaded.get(shade)
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.width = face.w
    canvas.height = face.h
    const data = new Uint8ClampedArray(face.texels)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.min(255, data[i] * shade)
      data[i + 1] = Math.min(255, data[i + 1] * shade)
      data[i + 2] = Math.min(255, data[i + 2] * shade)
    }
    canvas.getContext('2d')?.putImageData(new ImageData(data, face.w, face.h), 0, 0)
    face.shaded.set(shade, canvas)
  }
  return canvas
}

/** 各部位由远到近的顺序：分开画、分开描边，部位之间才有轮廓线。 */
export function partOrder(pose: Pose): Part[] {
  const centers: [Part, Vec][] = [
    ['armR', [-6, -6, 0]],
    ['armL', [6, -6, 0]],
    ['body', [0, -6, 0]],
    ['head', [0, 4, 0]]
  ]
  return centers
    .map(([part, center]) => [part, place(center, part, pose)[2] + (part === 'head' ? 100 : 0)] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([part]) => part)
}

function fillQuad(ctx: CanvasRenderingContext2D, points: [number, number][], fill: string): void {
  ctx.beginPath()
  ctx.moveTo(points[0][0], points[0][1])
  for (let k = 1; k < points.length; k += 1) ctx.lineTo(points[k][0], points[k][1])
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  // 同色描一圈细边，盖住相邻小面之间的抗锯齿缝
  ctx.strokeStyle = fill
  ctx.stroke()
}

/** 画一个部位：本体每个面一次仿射贴图（锐利、无缝），外层体素按远近逐个画。 */
export function drawPart(ctx: CanvasRenderingContext2D, model: Model, part: Part, pose: Pose, ratio: number): void {
  ctx.imageSmoothingEnabled = false
  for (const face of model.faces) {
    if (face.part !== part) continue
    const n = orient(face.n, part, pose)
    if (n[2] <= 0.015) continue
    const p0 = screen(place(face.o, part, pose), pose)
    const pu = screen(place(add(face.o, mul(face.u, face.w)), part, pose), pose)
    const pv = screen(place(add(face.o, mul(face.v, face.h)), part, pose), pose)
    const a = [(pu[0] - p0[0]) / face.w, (pu[1] - p0[1]) / face.w]
    const b = [(pv[0] - p0[0]) / face.h, (pv[1] - p0[1]) / face.h]
    ctx.setTransform(a[0] * ratio, a[1] * ratio, b[0] * ratio, b[1] * ratio, p0[0] * ratio, p0[1] * ratio)
    ctx.drawImage(shadedCanvas(face, toon(face.n)), -0.02, -0.02, face.w + 0.04, face.h + 0.04)
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.lineWidth = 0.5
  ctx.lineJoin = 'round'
  const visible: { depth: number; points: [number, number][]; fill: string }[] = []
  for (const quad of model.voxels) {
    if (quad.part !== part) continue
    if (orient(quad.parent, part, pose)[2] < -0.05) continue
    const n = orient(quad.n, part, pose)
    if (n[2] <= 0.01) continue
    visible.push({
      depth: place(quad.center, part, pose)[2],
      points: quad.corners.map((corner) => screen(place(corner, part, pose), pose)),
      fill: rgb(quad.color, toon(quad.n))
    })
  }
  visible.sort((x, y) => x.depth - y.depth)
  for (const quad of visible) fillQuad(ctx, quad.points, quad.fill)
}

/** 一颗碎块：镜头坐标里的位置、颜色、朝向（三个轴）。 */
export interface Chip {
  pos: Vec
  color: Rgb
  axes: [Vec, Vec, Vec]
  part: Part
}

function axesOf(part: Part, pose: Pose): [Vec, Vec, Vec] {
  return [orient([1, 0, 0], part, pose), orient([0, 1, 0], part, pose), orient([0, 0, 1], part, pose)]
}

/** 把看得见的每个像素（本体和外层体素顶面）拆成一颗小方块。 */
export function chips(model: Model, pose: Pose): Chip[] {
  const out: Chip[] = []
  const axes = new Map<Part, [Vec, Vec, Vec]>()
  const axesFor = (part: Part): [Vec, Vec, Vec] => {
    let found = axes.get(part)
    if (!found) {
      found = axesOf(part, pose)
      axes.set(part, found)
    }
    return found
  }
  for (const face of model.faces) {
    if (orient(face.n, face.part, pose)[2] <= 0.015) continue
    // 方块中心往里缩半格，碎块正好填满原来的位置
    const inset = mul(face.n, -0.5)
    for (let j = 0; j < face.h; j += 1) {
      for (let i = 0; i < face.w; i += 1) {
        const at = (j * face.w + i) * 4
        const center = add(add(add(face.o, mul(face.u, i + 0.5)), mul(face.v, j + 0.5)), inset)
        out.push({ pos: place(center, face.part, pose), color: [face.texels[at], face.texels[at + 1], face.texels[at + 2]], axes: axesFor(face.part), part: face.part })
      }
    }
  }
  for (const quad of model.voxels) {
    if (!quad.outer || orient(quad.n, quad.part, pose)[2] <= 0.01) continue
    out.push({ pos: place(add(quad.center, mul(quad.n, -0.45)), quad.part, pose), color: quad.color, axes: axesFor(quad.part), part: quad.part })
  }
  return out
}

/** 画一颗有明暗的小方块（不描边，像游戏里的方块碎屑）。 */
export function drawCube(ctx: CanvasRenderingContext2D, pos: Vec, axes: [Vec, Vec, Vec], size: number, color: Rgb, pose: Pose): void {
  const h = size / 2
  for (let k = 0; k < 3; k += 1) {
    const a = axes[k]
    const e1 = mul(axes[(k + 1) % 3], h)
    const e2 = mul(axes[(k + 2) % 3], h)
    for (const sign of [1, -1]) {
      const n = mul(a, sign)
      if (n[2] <= 0) continue
      const c = add(pos, mul(n, h))
      const light = n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]
      const fill = rgb(color, 0.5 + 0.55 * Math.max(0, light))
      fillQuad(
        ctx,
        [screen(add(add(c, e1), e2), pose), screen(add(c, add(neg(e1), e2)), pose), screen(add(c, add(neg(e1), neg(e2))), pose), screen(add(c, add(e1, neg(e2))), pose)],
        fill
      )
    }
  }
}

/** 绕任意轴把三个轴转一个角度（碎块翻滚用）。 */
export function spin(axes: [Vec, Vec, Vec], axis: Vec, angle: number): [Vec, Vec, Vec] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const turn = (v: Vec): Vec => {
    const dot = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2]
    const cross: Vec = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]]
    return [v[0] * c + cross[0] * s + axis[0] * dot * (1 - c), v[1] * c + cross[1] * s + axis[1] * dot * (1 - c), v[2] * c + cross[2] * s + axis[2] * dot * (1 - c)]
  }
  return [turn(axes[0]), turn(axes[1]), turn(axes[2])]
}

/** 没有皮肤时按 UUID 拼一张贴图：正脸用像素脸，头顶和后脑是头发，衣服取一个颜色。 */
export function fallbackSheet(face: HTMLCanvasElement, shirt: string): HTMLCanvasElement {
  const faceCtx = face.getContext('2d') as CanvasRenderingContext2D
  const pixel = (x: number, y: number): string => {
    const [r, g, b] = faceCtx.getImageData(x, y, 1, 1).data
    return `rgb(${r}, ${g}, ${b})`
  }
  const hair = pixel(3, 0)
  const skin = pixel(3, 7)
  const sheet = document.createElement('canvas')
  sheet.width = 64
  sheet.height = 64
  const ctx = sheet.getContext('2d') as CanvasRenderingContext2D
  ctx.fillStyle = skin
  ctx.fillRect(0, 0, 32, 16)
  ctx.fillStyle = hair
  ctx.fillRect(8, 0, 8, 8)
  ctx.fillRect(0, 8, 32, 2)
  ctx.fillRect(24, 8, 8, 6)
  ctx.fillRect(0, 10, 3, 2)
  ctx.fillRect(21, 10, 3, 2)
  ctx.drawImage(face, 8, 8)
  // 身体和胳膊：衣服，袖口往下露出手
  ctx.fillStyle = shirt
  ctx.fillRect(16, 16, 40, 16)
  ctx.fillRect(32, 48, 16, 16)
  ctx.fillStyle = skin
  ctx.fillRect(40, 28, 16, 4)
  ctx.fillRect(32, 60, 16, 4)
  return sheet
}
