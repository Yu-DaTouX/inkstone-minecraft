// 用 WebGL 的深度缓冲画一个部位，再贴回 2D 画布描边。
// 2D 版按面、按体素中心排远近，转到某些角度会有面盖错、外层穿模；有深度缓冲就不用排序了。
// 拿不到 WebGL（或上下文丢了）时 draw 返回 false，调用方退回 drawPart。

import { orient, place, toon, type Model, type Part, type Pose, type Vec } from './avatar.ts'

const VERTEX = `
attribute vec3 a_pos;
attribute vec2 a_uv;
attribute vec4 a_col;
uniform mat4 u_m;
varying vec2 v_uv;
varying vec4 v_col;
void main() {
  gl_Position = u_m * vec4(a_pos, 1.0);
  v_uv = a_uv;
  v_col = a_col;
}`

// a_col.a 为 1 时取贴图乘明暗（本体），为 0 时直接用顶点色（外层体素）
const FRAGMENT = `
precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_uv;
varying vec4 v_col;
void main() {
  vec3 texel = texture2D(u_tex, v_uv).rgb;
  vec3 color = mix(v_col.rgb, texel * v_col.rgb, v_col.a);
  gl_FragColor = vec4(min(color, vec3(1.0)), 1.0);
}`

/** 每个顶点 9 个数：位置 3、贴图坐标 2、颜色 4 */
const STRIDE = 9

interface Mesh {
  buffer: WebGLBuffer
  count: number
}

interface Uploaded {
  model: Model
  texture: WebGLTexture
  meshes: Map<Part, Mesh>
}

export interface GlAvatar {
  /** 开始画一个人：清深度。之后各部位共用这份深度，谁在前谁盖住，和画的先后无关 */
  begin(): void
  draw(target: CanvasRenderingContext2D, model: Model, part: Part, pose: Pose, ratio: number): boolean
  dispose(): void
}

function pushQuad(out: number[], corners: Vec[], uvs: [number, number][], color: [number, number, number, number]): void {
  for (const index of [0, 1, 2, 0, 2, 3]) out.push(...corners[index], ...uvs[index], ...color)
}

function meshData(model: Model, part: Part): Float32Array {
  const out: number[] = []
  const { width, height } = model.sheet
  for (const face of model.faces) {
    if (face.part !== part) continue
    const [tx, ty] = face.tex
    const ou = face.u.map((value) => value * face.w) as Vec
    const ov = face.v.map((value) => value * face.h) as Vec
    const p0 = face.o
    const p1: Vec = [p0[0] + ou[0], p0[1] + ou[1], p0[2] + ou[2]]
    const p2: Vec = [p1[0] + ov[0], p1[1] + ov[1], p1[2] + ov[2]]
    const p3: Vec = [p0[0] + ov[0], p0[1] + ov[1], p0[2] + ov[2]]
    const u0 = tx / width
    const u1 = (tx + face.w) / width
    const v0 = ty / height
    const v1 = (ty + face.h) / height
    const shade = toon(face.n)
    pushQuad(out, [p0, p1, p2, p3], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], [shade, shade, shade, 1])
  }
  for (const quad of model.voxels) {
    if (quad.part !== part) continue
    const shade = toon(quad.n) / 255
    pushQuad(out, quad.corners, [[0, 0], [0, 0], [0, 0], [0, 0]], [quad.color[0] * shade, quad.color[1] * shade, quad.color[2] * shade, 0])
  }
  return new Float32Array(out)
}

/** 模型坐标 → 裁剪坐标。place 是仿射的：三个基向量的转向是矩阵的三列，原点去哪儿是平移。 */
function matrix(part: Part, pose: Pose, width: number, height: number): Float32Array {
  const columns = [orient([1, 0, 0], part, pose), orient([0, 1, 0], part, pose), orient([0, 0, 1], part, pose)]
  const shift = place([0, 0, 0], part, pose)
  const sx = (2 * pose.scale) / width
  const sy = (2 * pose.scale) / height
  const m = new Float32Array(16)
  columns.forEach((c, k) => {
    m[k * 4] = c[0] * sx
    m[k * 4 + 1] = c[1] * sy
    // 离观众越近深度越小
    m[k * 4 + 2] = -c[2] / 64
  })
  m[12] = (2 * pose.cx) / width - 1 + shift[0] * sx
  m[13] = 1 - (2 * pose.cy) / height + shift[1] * sy
  m[14] = -shift[2] / 64
  m[15] = 1
  return m
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null
}

export function createGlAvatar(): GlAvatar | null {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: true, depth: true, preserveDrawingBuffer: true })
  if (!gl) return null
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  const program = gl.createProgram()
  if (!vertex || !fragment || !program) return null
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null
  const aPos = gl.getAttribLocation(program, 'a_pos')
  const aUv = gl.getAttribLocation(program, 'a_uv')
  const aCol = gl.getAttribLocation(program, 'a_col')
  const uM = gl.getUniformLocation(program, 'u_m')
  const uTex = gl.getUniformLocation(program, 'u_tex')
  let lost = false
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    lost = true
  })
  const uploaded = new WeakMap<Model, Uploaded>()
  const owned: Uploaded[] = []

  const upload = (model: Model): Uploaded => {
    let found = uploaded.get(model)
    if (found) return found
    const texture = gl.createTexture() as WebGLTexture
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, model.sheet)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    found = { model, texture, meshes: new Map() }
    for (const part of ['head', 'body', 'armR', 'armL'] as Part[]) {
      const data = meshData(model, part)
      const buffer = gl.createBuffer() as WebGLBuffer
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
      found.meshes.set(part, { buffer, count: data.length / STRIDE })
    }
    uploaded.set(model, found)
    owned.push(found)
    // 换过几次皮肤后把旧的显存放掉，只留最近两个模型（换皮动画里新旧同时在画）
    while (owned.length > 2) {
      const old = owned.shift() as Uploaded
      gl.deleteTexture(old.texture)
      for (const mesh of old.meshes.values()) gl.deleteBuffer(mesh.buffer)
      uploaded.delete(old.model)
    }
    return found
  }

  let fresh = true

  return {
    begin() {
      fresh = true
    },
    draw(target, model, part, pose, ratio) {
      if (lost || gl.isContextLost()) return false
      const width = target.canvas.width
      const height = target.canvas.height
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      const entry = upload(model)
      const mesh = entry.meshes.get(part)
      if (!mesh || mesh.count === 0) return true
      gl.viewport(0, 0, width, height)
      gl.clearColor(0, 0, 0, 0)
      gl.clearDepth(1)
      // 每个部位只清颜色：被前面部位挡住的地方深度测试不过，不会画出来
      gl.clear(fresh ? gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT : gl.COLOR_BUFFER_BIT)
      fresh = false
      gl.enable(gl.DEPTH_TEST)
      gl.depthFunc(gl.LEQUAL)
      gl.disable(gl.CULL_FACE)
      gl.useProgram(program)
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer)
      gl.enableVertexAttribArray(aPos)
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, STRIDE * 4, 0)
      gl.enableVertexAttribArray(aUv)
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, STRIDE * 4, 12)
      gl.enableVertexAttribArray(aCol)
      gl.vertexAttribPointer(aCol, 4, gl.FLOAT, false, STRIDE * 4, 20)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, entry.texture)
      gl.uniform1i(uTex, 0)
      // pose 是 CSS 像素，画布是设备像素
      gl.uniformMatrix4fv(uM, false, matrix(part, pose, width / ratio, height / ratio))
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count)
      target.save()
      target.setTransform(1, 0, 0, 1, 0, 0)
      target.drawImage(canvas, 0, 0)
      target.restore()
      return true
    },
    dispose() {
      for (const entry of owned) {
        gl.deleteTexture(entry.texture)
        for (const mesh of entry.meshes.values()) gl.deleteBuffer(mesh.buffer)
      }
      owned.length = 0
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
}
