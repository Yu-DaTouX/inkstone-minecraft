// 生成应用图标 build/icon.png（256×256 等轴草方块，和顶栏、托盘图标同一套像素）。
// 不依赖图像库：逐像素做仿射逆映射，自己编码成 PNG。用法：node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const SIZE = 256
const N = 16

function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const hex = (v) => [(v >> 16) & 255, (v >> 8) & 255, v & 255]
const pick = (list, t) => hex(list[Math.min(list.length - 1, Math.floor(t * list.length))])
const GRASS = [0x5f9c34, 0x6aaa3a, 0x7bbd45, 0x558d2e]
const DIRT = [0x79553a, 0x866043, 0x5c3f2a, 0x96704f]
const top = (x, y) => pick(GRASS, hash(x, y, 1))
const side = (x, y) => (y < 3 + Math.floor(hash(x, 7, 1) * 3) ? pick(GRASS, hash(x, y, 1)) : pick(DIRT, hash(x, y, 2)))

// 和 BlockIcon 一样的几何：顶面菱形，左右两个侧面
const w = SIZE * 0.44
const h = w * 1.12
const cx = SIZE / 2
const y0 = (SIZE - (w + h)) / 2
const faces = [
  { o: [cx - w, y0 + w / 2], u: [w, -w / 2], v: [w, w / 2], tex: top, shade: 1 },
  { o: [cx - w, y0 + w / 2], u: [w, w / 2], v: [0, h], tex: side, shade: 0.8 },
  { o: [cx, y0 + w], u: [w, -w / 2], v: [0, h], tex: side, shade: 0.62 }
]

const pixels = Buffer.alloc(SIZE * SIZE * 4)
for (let py = 0; py < SIZE; py += 1) {
  for (let px = 0; px < SIZE; px += 1) {
    for (const face of faces) {
      // 解 p = o + s*u + t*v
      const [ux, uy] = face.u
      const [vx, vy] = face.v
      const det = ux * vy - uy * vx
      const dx = px + 0.5 - face.o[0]
      const dy = py + 0.5 - face.o[1]
      const s = (dx * vy - dy * vx) / det
      const t = (ux * dy - uy * dx) / det
      if (s < 0 || s >= 1 || t < 0 || t >= 1) continue
      const [r, g, b] = face.tex(Math.floor(s * N), Math.floor(t * N))
      const at = (py * SIZE + px) * 4
      pixels[at] = Math.round(r * face.shade)
      pixels[at + 1] = Math.round(g * face.shade)
      pixels[at + 2] = Math.round(b * face.shade)
      pixels[at + 3] = 255
      break
    }
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8
ihdr[9] = 6
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y += 1) pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log('build/icon.png', png.length, 'bytes')
