import { useEffect, useRef, type PointerEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { Account } from '../../shared/api.ts'
import { buildModel, chips, drawCube, drawPart, fallbackSheet, partOrder, screen, spin, type Chip, type Model, type Pose, type Vec } from './avatar.ts'
import { createGlAvatar } from './avatar-gl.ts'
import { prefersReducedMotion } from './SeedTerrain.tsx'
import { drawFallbackFace, loadSkin, useSkinVersion } from './SkinHead.tsx'

const OUTLINE_PX = 2.4
const FLASH_MS = 320
const SWIPE_PX = 64
const SWIPE_VELOCITY = 0.55
const DEG = Math.PI / 180
const BASE_YAW = 20 * DEG
const BASE_PITCH = 9 * DEG
const SHIRTS = ['#3c6e9e', '#5a8a3c', '#9a4b3a', '#6b5a8e', '#3f7f7a', '#8a6d2f']

// 换人的节奏，照着游戏里点着的 TNT：先闪白、鼓一下，然后炸开
const PRIME_MS = 230
const SHAKE_MS = 280
const SHAKE_PX = 5
const REBUILD_AT = PRIME_MS + 210
const ASSEMBLE_MS = 380
/** 碎块的单位是皮肤像素、时间是毫秒 */
const GRAVITY = 0.00005
const DRAG_MS = 520

const modelCache = new Map<string, { version: number; model: Promise<Model> }>()

/** 细手臂皮肤右臂最外一列是空的；元数据没写时靠这个认出来。 */
function looksSlim(sheet: HTMLCanvasElement): boolean {
  if (sheet.height < 64) return false
  const data = (sheet.getContext('2d') as CanvasRenderingContext2D).getImageData(54, 20, 2, 12).data
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false
  return true
}

function loadModel(account: Account, version: number): Promise<Model> {
  const cached = modelCache.get(account.id)
  if (cached && cached.version === version) return cached.model
  const request = loadSkin(account.id).then(
    (skin) =>
      new Promise<Model>((resolve) => {
        const fromSheet = (sheet: HTMLCanvasElement, slim: boolean): void => {
          const ctx = sheet.getContext('2d') as CanvasRenderingContext2D
          resolve(buildModel(ctx.getImageData(0, 0, sheet.width, sheet.height), slim))
        }
        const fallback = (): void => {
          const face = document.createElement('canvas')
          face.width = 8
          face.height = 8
          drawFallbackFace(face.getContext('2d') as CanvasRenderingContext2D, account.uuid)
          const seed = parseInt(account.uuid.replace(/[^0-9a-f]/gi, '').slice(4, 6) || '0', 16)
          fromSheet(fallbackSheet(face, SHIRTS[seed % SHIRTS.length]), false)
        }
        if (!skin.dataUrl) {
          fallback()
          return
        }
        const image = new Image()
        image.onload = () => {
          const sheet = document.createElement('canvas')
          sheet.width = 64
          sheet.height = image.height >= 64 ? 64 : 32
          sheet.getContext('2d')?.drawImage(image, 0, 0, 64, sheet.height, 0, 0, 64, sheet.height)
          fromSheet(sheet, skin.slim || looksSlim(sheet))
        }
        image.onerror = fallback
        image.src = skin.dataUrl
      })
  )
  modelCache.set(account.id, { version, model: request })
  return request
}

interface Debris {
  chip: Chip
  velocity: Vec
  axis: Vec
  spin: number
  life: number
}

interface Puff {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  delay: number
  life: number
  /** 爆心那几团是白的、很快就散；其余是灰烟 */
  white: boolean
}

interface Incoming {
  chip: Chip
  from: Vec
  axis: Vec
  turn: number
  delay: number
}

interface Swap {
  start: number
  dir: 1 | -1
  old: Model
  /** 炸开那一刻才拆碎块，接得上最后一帧的姿势 */
  boom: { pose: Pose; debris: Debris[]; puffs: Puff[]; end: number } | null
  rebuild: { pose: Pose; incoming: Incoming[]; end: number } | null
  landed: boolean
}

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3)
const easeBack = (t: number): number => 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2)
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const between = (min: number, max: number): number => min + Math.random() * (max - min)

function unit(v: Vec): Vec {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

const randomAxis = (): Vec => unit([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5])

/** 爆点在胸口稍后面：头上的碎块往上飞，身上的往两边散。 */
const BLAST: Vec = [0, -3, -1.5]

function explode(old: Model, pose: Pose, dir: 1 | -1, now: number): NonNullable<Swap['boom']> {
  const debris = chips(old, pose).map((chip): Debris => {
    const out = unit([chip.pos[0] - BLAST[0] + between(-2, 2), chip.pos[1] - BLAST[1] + between(-2, 2), chip.pos[2] - BLAST[2] + between(-1, 1)])
    const speed = between(0.01, 0.034)
    return {
      chip,
      velocity: [out[0] * speed - dir * between(0, 0.008), out[1] * speed + between(0.006, 0.014), out[2] * speed],
      axis: randomAxis(),
      spin: between(0.004, 0.014) * (Math.random() < 0.5 ? -1 : 1),
      life: between(680, 1060)
    }
  })
  const puffs = Array.from({ length: 20 }, (_, index): Puff => {
    const white = index < 5
    const x = white ? between(-3, 3) : between(-7, 7)
    const y = white ? between(-6, 2) : between(-11, 7)
    return {
      x,
      y,
      vx: (x - BLAST[0]) * 0.0007 + between(-0.002, 0.002),
      vy: (y - BLAST[1]) * 0.0004 + between(0.002, 0.006),
      radius: white ? between(2.6, 3.6) : between(1.6, 3.2),
      delay: white ? between(0, 30) : between(20, 140),
      life: white ? between(130, 200) : between(420, 760),
      white
    }
  })
  // 先画的在下面：灰烟垫底，白色爆心盖在上面
  puffs.reverse()
  const end = now + Math.max(...debris.map((item) => item.life), ...puffs.map((puff) => puff.delay + puff.life), 0)
  return { pose, debris, puffs, end }
}

function rebuild(next: Model, pose: Pose, dir: 1 | -1, now: number): NonNullable<Swap['rebuild']> {
  const targets = chips(next, pose)
  const top = Math.max(...targets.map((chip) => chip.pos[1]))
  const bottom = Math.min(...targets.map((chip) => chip.pos[1]))
  const incoming = targets.map(
    (chip): Incoming => ({
      chip,
      from: [chip.pos[0] + dir * between(9, 22), chip.pos[1] + between(-6, 5), chip.pos[2] + between(-6, 6)],
      axis: randomAxis(),
      turn: between(1.5, 4) * (Math.random() < 0.5 ? -1 : 1),
      // 从下往上拼：身体先落位，头最后
      delay: ((chip.pos[1] - bottom) / Math.max(top - bottom, 1)) * 260 + Math.random() * 110
    })
  )
  return { pose, incoming, end: now + Math.max(...incoming.map((item) => item.delay), 0) + ASSEMBLE_MS }
}

/** 整数坐标的固定噪声，0–1。 */
function noise(a: number, b: number, c: number): number {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * 像素烟团：一格一格填颜色，只有三档灰、没有半透明。边缘按噪声啃掉一圈，
 * 消散时按噪声一格格抠掉（抖动消失），和游戏里的烟雾粒子一个味道。
 */
function paintSmoke(image: ImageData, puffs: Puff[], sinceBoom: number, toCell: (x: number, y: number) => [number, number], cellsPerUnit: number): void {
  const { data, width, height } = image
  data.fill(0)
  puffs.forEach((puff, index) => {
    const age = sinceBoom - puff.delay
    if (age <= 0 || age >= puff.life) return
    const life = age / puff.life
    const drift = 400 * (1 - Math.exp(-age / 400))
    const [cx, cy] = toCell(puff.x + puff.vx * drift, puff.y + puff.vy * drift)
    const radius = puff.radius * (0.5 + 0.5 * easeOut(Math.min(1, life * 1.8))) * cellsPerUnit
    const base = puff.white ? 255 : 232 - 96 * life
    const ox = Math.round(cx)
    const oy = Math.round(cy)
    for (let j = Math.max(0, Math.floor(cy - radius)); j <= Math.min(height - 1, Math.ceil(cy + radius)); j += 1) {
      for (let i = Math.max(0, Math.floor(cx - radius)); i <= Math.min(width - 1, Math.ceil(cx + radius)); i += 1) {
        const dx = (i + 0.5 - cx) / radius
        const dy = (j + 0.5 - cy) / radius
        const d = Math.hypot(dx, dy)
        if (d > 1) continue
        // 噪声跟着烟团走，烟团飘的时候花纹不闪
        const n = noise(i - ox, j - oy, index)
        if (d > 0.7 && n < (d - 0.7) / 0.3) continue
        if (life > 0.4 && n < (life - 0.4) / 0.6) continue
        const lit = -dx * 0.6 - dy * 0.75
        const value = Math.min(255, Math.round(base * (lit > 0.2 ? 1.08 : lit < -0.35 ? 0.76 : 0.93)))
        const at = (j * width + i) * 4
        data[at] = value
        data[at + 1] = value
        data[at + 2] = Math.min(255, value + 3)
        data[at + 3] = 255
      }
    }
  })
}

interface Props {
  account: Account
  /** 1：切到下一个（往左甩），-1：切到上一个 */
  direction: 1 | -1
  onSwipe(direction: 1 | -1): void
}

/** 三渲二半身像：头看着鼠标，拖动转身，甩一下换人（旧的像 TNT 一样炸成方块，新的一块块拼起来）。 */
export function AvatarStage({ account, direction, onSwipe }: Props): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null)
  /** 碎块和烟铺满整个窗口画，飞出左栏也不会被切掉 */
  const fx = useRef<HTMLCanvasElement>(null)
  const live = useRef({
    model: null as Model | null,
    swap: null as Swap | null,
    flashAt: -Infinity,
    yaw: BASE_YAW,
    headYaw: 0,
    headPitch: 0,
    drag: 0,
    mouse: null as { x: number; y: number } | null,
    /** 外壳上的启动状态，和它开始的时间 */
    run: 'idle',
    runSince: 0,
    direction,
    reduced: prefersReducedMotion()
  })
  const gesture = useRef<{ id: number; x: number; lastX: number; lastAt: number; velocity: number } | null>(null)
  const skinVersion = useSkinVersion(account.id)

  live.current.direction = direction

  // 换账号：旧人物炸掉，新人物拼起来
  useEffect(() => {
    let alive = true
    void loadModel(account, skinVersion).then((next) => {
      if (!alive) return
      const state = live.current
      const previous = state.model
      state.model = next
      if (!previous || previous === next || state.reduced) return
      state.swap = { start: performance.now(), dir: state.direction, old: previous, boom: null, rebuild: null, landed: false }
    })
    return () => {
      alive = false
    }
  }, [account, skinVersion])

  // 鼠标在窗口里任何地方，头都转过去看
  useEffect(() => {
    const onMove = (event: globalThis.PointerEvent): void => {
      live.current.mouse = { x: event.clientX, y: event.clientY }
    }
    const onLeave = (): void => {
      live.current.mouse = null
    }
    window.addEventListener('pointermove', onMove)
    document.documentElement.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  // 画面循环
  useEffect(() => {
    const element = canvas.current
    const ctx = element?.getContext('2d')
    const fxElement = fx.current
    const fxCtx = fxElement?.getContext('2d')
    if (!element || !ctx || !fxElement || !fxCtx) return
    const layer = document.createElement('canvas')
    const ink = document.createElement('canvas')
    const smoke = document.createElement('canvas')
    const layerCtx = layer.getContext('2d') as CanvasRenderingContext2D
    const inkCtx = ink.getContext('2d') as CanvasRenderingContext2D
    const smokeCtx = smoke.getContext('2d') as CanvasRenderingContext2D
    let smokeImage: ImageData | null = null
    // 有 WebGL 就用深度缓冲画，任何角度都不会面盖错；没有就退回 2D
    const gl = createGlAvatar()
    let fxDirty = false
    let raf = 0
    let last = performance.now()

    const resizeFx = (): void => {
      const ratio = window.devicePixelRatio || 1
      fxElement.width = Math.max(1, Math.round(fxElement.clientWidth * ratio))
      fxElement.height = Math.max(1, Math.round(fxElement.clientHeight * ratio))
    }
    const fxObserver = new ResizeObserver(resizeFx)
    fxObserver.observe(fxElement)
    resizeFx()

    const resize = (): void => {
      const ratio = window.devicePixelRatio || 1
      const width = Math.max(1, Math.round(element.clientWidth * ratio))
      const height = Math.max(1, Math.round(element.clientHeight * ratio))
      for (const target of [element, layer, ink]) {
        if (target.width !== width || target.height !== height) {
          target.width = width
          target.height = height
        }
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      const state = live.current
      const dt = Math.min(now - last, 64)
      last = now
      const ratio = window.devicePixelRatio || 1
      const idle = !state.reduced

      // 头看向鼠标；鼠标不在窗口里就慢慢左右看看
      let targetHeadYaw = idle ? Math.sin(now / 2600) * 14 * DEG : 0
      let targetHeadPitch = idle ? Math.sin(now / 3700) * 4 * DEG : 0
      if (state.mouse) {
        const rect = element.getBoundingClientRect()
        const headX = rect.left + rect.width / 2
        const headY = rect.top + rect.height * 0.32
        const dx = state.mouse.x - headX
        const dy = state.mouse.y - headY
        targetHeadYaw = clamp(Math.atan2(dx, 480) - BASE_YAW, -30 * DEG, 26 * DEG)
        targetHeadPitch = clamp(Math.atan2(dy, 520), -14 * DEG, 12 * DEG)
      }
      const follow = 1 - Math.exp(-dt / 120)
      state.headYaw += (targetHeadYaw - state.headYaw) * follow
      state.headPitch += (targetHeadPitch - state.headPitch) * follow
      // 身体跟着头转一点点
      state.yaw += (BASE_YAW + state.headYaw * 0.22 - state.yaw) * (1 - Math.exp(-dt / 260))
      if (!gesture.current) state.drag *= Math.exp(-dt / 140)

      const pose = poseFor(element, state.yaw + state.drag, state.headYaw, state.headPitch, idle ? now : 0)
      // 启动游戏：原地蹦着、两手前后甩，像在跑；进程起来后挥挥手
      const run = element.closest('.shell')?.getAttribute('data-run') ?? 'idle'
      if (run !== state.run) {
        state.run = run
        state.runSince = now
      }
      const since = now - state.runSince
      if (idle && run === 'starting') {
        const phase = (since / HOP_MS) * Math.PI * 2
        const ramp = Math.min(1, since / 300)
        pose.cy -= Math.max(0, Math.sin(phase)) * 1.4 * pose.scale * ramp
        const swing = Math.sin(phase) * 0.7 * ramp
        pose.armR = [swing, 0.06]
        pose.armL = [-swing, 0.06]
      } else if (idle && run === 'running' && since < WAVE_MS) {
        const up = clamp(Math.min(since / 280, (WAVE_MS - since) / 360), 0, 1)
        // 右手从身侧举到头边，左右摆几下打招呼
        const lift = easeOut(up)
        pose.armR = [-0.2 * lift, 2.55 * lift + Math.sin(since / 95) * 0.3 * up]
      }
      const theme = document.documentElement.dataset.theme
      const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
      const o = OUTLINE_PX * ratio
      const offsets = [[o, 0], [-o, 0], [0, o], [0, -o], [o * 0.7, o * 0.7], [-o * 0.7, o * 0.7], [o * 0.7, -o * 0.7], [-o * 0.7, -o * 0.7]]

      /** 剪影染成一个颜色放进 ink。 */
      const silhouette = (color: string): void => {
        inkCtx.globalCompositeOperation = 'source-over'
        inkCtx.clearRect(0, 0, ink.width, ink.height)
        inkCtx.drawImage(layer, 0, 0)
        inkCtx.globalCompositeOperation = 'source-in'
        inkCtx.fillStyle = color
        inkCtx.fillRect(0, 0, ink.width, ink.height)
      }

      /** 画一个部位：先画到 layer，再把剪影染成墨色往八个方向挪一点垫在下面，就是描边；white 是盖一层白（闪白）。 */
      const stamp = (draw: () => void, white: number): void => {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        layerCtx.setTransform(1, 0, 0, 1, 0, 0)
        layerCtx.clearRect(0, 0, layer.width, layer.height)
        layerCtx.setTransform(ratio, 0, 0, ratio, 0, 0)
        draw()
        silhouette(dark ? '#08090a' : '#1b1c19')
        for (const [dx, dy] of offsets) ctx.drawImage(ink, dx, dy)
        ctx.drawImage(layer, 0, 0)
        if (white > 0) {
          silhouette('#ffffff')
          ctx.globalAlpha = Math.min(1, white)
          ctx.drawImage(ink, 0, 0)
          ctx.globalAlpha = 1
        }
      }

      const drawModel = (model: Model, at: Pose, white: number): void => {
        gl?.begin()
        for (const part of partOrder(at)) stamp(() => gl?.draw(layerCtx, model, part, at, ratio) || drawPart(layerCtx, model, part, at, ratio), white)
      }

      const swap = state.swap
      const t = swap ? now - swap.start : 0

      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, element.width, element.height)
      const shadow = swap && !swap.landed ? (t < PRIME_MS ? 1 : clamp((t - REBUILD_AT) / 400, 0.12, 1)) : 1
      // 身后一圈淡淡的光，把人物从地图上托出来
      const glowY = (pose.cy - 2 * pose.scale) * ratio
      const glow = ctx.createRadialGradient(pose.cx * ratio, glowY, 0, pose.cx * ratio, glowY, 120 * ratio)
      glow.addColorStop(0, dark ? `rgba(255, 255, 255, ${0.07 * shadow})` : `rgba(255, 255, 255, ${0.5 * shadow})`)
      glow.addColorStop(1, 'rgba(255, 255, 255, 0)')
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, element.width, element.height)

      if (!swap && fxDirty) {
        fxCtx.setTransform(1, 0, 0, 1, 0, 0)
        fxCtx.clearRect(0, 0, fxElement.width, fxElement.height)
        fxDirty = false
      }
      if (!swap) {
        if (state.model) drawModel(state.model, pose, 0.5 * (1 - (now - state.flashAt) / FLASH_MS))
        return
      }

      // 点着：一闪一闪地变白，同时鼓起来一点
      if (t < PRIME_MS) {
        const p = t / PRIME_MS
        const swell = 1 + 0.07 * p * p
        const primed = { ...pose, scale: pose.scale * swell, cy: pose.cy - 3 * pose.scale * (swell - 1) }
        const blink = Math.floor(t / 58) % 2 === 0 ? 1 : 0.35
        drawModel(swap.old, primed, (0.2 + 0.8 * p) * blink)
        swap.boom = null
        return
      }
      if (!swap.boom) {
        const swell = 1.07
        swap.boom = explode(swap.old, { ...pose, scale: pose.scale * swell, cy: pose.cy - 3 * pose.scale * (swell - 1) }, swap.dir, now)
        state.yaw = BASE_YAW
        state.drag = 0
      }
      const boom = swap.boom
      const sinceBoom = t - PRIME_MS

      // 炸开后画面抖一下
      const shake = sinceBoom < SHAKE_MS ? Math.pow(1 - sinceBoom / SHAKE_MS, 2) * SHAKE_PX : 0
      const sx = shake ? between(-shake, shake) : 0
      const sy = shake ? between(-shake, shake) : 0
      ctx.setTransform(ratio, 0, 0, ratio, sx * ratio, sy * ratio)
      ctx.lineWidth = 0.5
      ctx.lineJoin = 'round'

      // 新人物：一块块飞回来拼上，拼完换成正常的样子并闪一下
      if (swap.landed && state.model) {
        drawModel(state.model, pose, 0.5 * (1 - (now - state.flashAt) / FLASH_MS))
        ctx.setTransform(ratio, 0, 0, ratio, sx * ratio, sy * ratio)
      } else if (t >= REBUILD_AT && state.model) {
        if (!swap.rebuild) swap.rebuild = rebuild(state.model, pose, swap.dir, now)
        const build = swap.rebuild
        const since = t - REBUILD_AT
        const cubes: { pos: Vec; axes: Chip['axes']; size: number; chip: Chip }[] = []
        for (const item of build.incoming) {
          const p = clamp((since - item.delay) / ASSEMBLE_MS, 0, 1)
          if (p <= 0) continue
          const move = easeOut(p)
          const from = item.from
          const to = item.chip.pos
          cubes.push({
            pos: [from[0] + (to[0] - from[0]) * move, from[1] + (to[1] - from[1]) * move, from[2] + (to[2] - from[2]) * move],
            axes: p >= 1 ? item.chip.axes : spin(item.chip.axes, item.axis, item.turn * (1 - move)),
            size: 0.3 + 0.7 * easeBack(p),
            chip: item.chip
          })
        }
        cubes.sort((a, b) => a.pos[2] - b.pos[2])
        for (const cube of cubes) drawCube(ctx, cube.pos, cube.axes, cube.size, cube.chip.color, build.pose)
        if (now >= build.end) {
          swap.landed = true
          state.flashAt = now
        }
      }

      // 碎块和烟画在铺满窗口的那张画布上，坐标按人物画布的位置挪过去
      const rect = element.getBoundingClientRect()
      fxCtx.setTransform(1, 0, 0, 1, 0, 0)
      fxCtx.clearRect(0, 0, fxElement.width, fxElement.height)
      fxDirty = true
      fxCtx.setTransform(ratio, 0, 0, ratio, (rect.left + sx) * ratio, (rect.top + sy) * ratio)
      fxCtx.lineWidth = 0.5
      fxCtx.lineJoin = 'round'

      // 碎块：往外崩、往下掉、自己翻滚，最后缩小淡掉
      const pieces: { pos: Vec; axes: Chip['axes']; size: number; alpha: number; chip: Chip }[] = []
      const glide = DRAG_MS * (1 - Math.exp(-sinceBoom / DRAG_MS))
      for (const item of boom.debris) {
        if (sinceBoom >= item.life) continue
        const life = sinceBoom / item.life
        const p = item.chip.pos
        pieces.push({
          pos: [p[0] + item.velocity[0] * glide, p[1] + item.velocity[1] * glide - 0.5 * GRAVITY * sinceBoom * sinceBoom, p[2] + item.velocity[2] * glide],
          axes: spin(item.chip.axes, item.axis, item.spin * sinceBoom),
          size: 1 - 0.45 * life,
          alpha: life < 0.7 ? 1 : 1 - (life - 0.7) / 0.3,
          chip: item.chip
        })
      }
      pieces.sort((a, b) => a.pos[2] - b.pos[2])
      for (const piece of pieces) {
        fxCtx.globalAlpha = piece.alpha
        drawCube(fxCtx, piece.pos, piece.axes, piece.size, piece.chip.color, boom.pose)
      }
      fxCtx.globalAlpha = 1

      // 烟团：一格烟是半个皮肤像素，画在小图上再按最近邻放大
      const cell = Math.max(3, Math.round(boom.pose.scale / 2))
      const cols = Math.ceil(fxElement.clientWidth / cell)
      const rows = Math.ceil(fxElement.clientHeight / cell)
      if (!smokeImage || smokeImage.width !== cols || smokeImage.height !== rows) {
        smoke.width = cols
        smoke.height = rows
        smokeImage = smokeCtx.createImageData(cols, rows)
      }
      paintSmoke(
        smokeImage,
        boom.puffs,
        sinceBoom,
        (x, y) => {
          const [px, py] = screen([x, y, 0], boom.pose)
          return [(px + rect.left) / cell, (py + rect.top) / cell]
        },
        boom.pose.scale / cell
      )
      smokeCtx.putImageData(smokeImage, 0, 0)
      fxCtx.setTransform(ratio, 0, 0, ratio, sx * ratio, sy * ratio)
      fxCtx.imageSmoothingEnabled = false
      fxCtx.drawImage(smoke, 0, 0, cols * cell, rows * cell)

      if (swap.landed && now >= boom.end) state.swap = null
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      fxObserver.disconnect()
      gl?.dispose()
    }
  }, [])

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = { id: event.pointerId, x: event.clientX, lastX: event.clientX, lastAt: performance.now(), velocity: 0 }
  }

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    const active = gesture.current
    if (!active || active.id !== event.pointerId) return
    const now = performance.now()
    active.velocity = active.velocity * 0.6 + ((event.clientX - active.lastX) / Math.max(now - active.lastAt, 1)) * 0.4
    active.lastX = event.clientX
    active.lastAt = now
    // 拖动直接转身，越转越沉
    const dx = event.clientX - active.x
    live.current.drag = (dx / (1 + Math.abs(dx) / 240)) * 0.9 * DEG
  }

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>): void => {
    const active = gesture.current
    gesture.current = null
    if (!active || active.id !== event.pointerId) return
    const dx = event.clientX - active.x
    if (Math.abs(dx) > SWIPE_PX || Math.abs(active.velocity) > SWIPE_VELOCITY) onSwipe(dx < 0 ? 1 : -1)
  }

  return (
    <>
      <canvas
        ref={canvas}
        className="avatar"
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      {createPortal(<canvas ref={fx} className="avatar-fx" aria-hidden="true" />, document.body)}
    </>
  )
}

/** 半身像构图：头在上三分之一，身体往下被画布底边的渐隐切掉。 */
const HOP_MS = 640
const WAVE_MS = 1700

function poseFor(element: HTMLCanvasElement, yaw: number, headYaw: number, headPitch: number, now: number): Pose {
  const width = element.clientWidth
  const height = element.clientHeight
  // 横向多留几格：启动时胳膊会甩出去
  const scale = Math.min(width / 28, height / 21)
  const breathe = now ? Math.sin(now / 1900) * 1.5 : 0
  return { yaw, pitch: BASE_PITCH, headYaw, headPitch, scale, cx: width / 2, cy: height * 0.5 + breathe }
}
