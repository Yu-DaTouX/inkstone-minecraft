#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = join(root, 'src/renderer/src/design/tokens.json')
const tokens = JSON.parse(readFileSync(source, 'utf8'))
const HEADER = '由 scripts/design/build-tokens.mjs 生成，不要手改。'

const pair = ([light, dark]) => (light === dark ? light : `light-dark(${light}, ${dark})`)

function darkShadowLines(indent = '    ') {
  return Object.entries(tokens.shadow).map(([name, value]) => `${indent}--shadow-${name}: ${value[1]};`)
}

function baseDensityValue(key) {
  const groups = [['t-', tokens.type], ['d-', tokens.d], ['size-', tokens.size], ['r-', tokens.radius]]
  for (const [prefix, group] of groups) {
    if (!key.startsWith(prefix)) continue
    const value = group[key.slice(prefix.length)]
    if (value !== undefined) return Array.isArray(value) ? value.slice(0, 2) : value
  }
  throw new Error(`密度令牌 ${key} 没有对应的基础值`)
}

function buildCss() {
  const lines = []
  lines.push(`/* ${HEADER} */`)
  lines.push('@layer tokens {')
  lines.push('  :root {')
  lines.push('    color-scheme: light dark;')
  for (const [name, value] of Object.entries(tokens.color)) lines.push(`    --${name}: ${pair(value)};`)
  for (const [name, value] of Object.entries(tokens.syntax ?? {})) lines.push(`    --syn-${name}: ${pair(value)};`)
  const [inkLight, inkDark] = tokens.alphaInk
  tokens.alpha.forEach((a, i) => lines.push(`    --alpha-${i}: ${pair([`rgba(${inkLight},${a})`, `rgba(${inkDark},${a})`])};`))
  tokens.data.forEach((value, i) => lines.push(`    --data-${i + 1}: ${pair(value)};`))
  for (const [name, value] of Object.entries(tokens.shadow)) lines.push(`    --shadow-${name}: ${value[0]};`)
  for (const [name, value] of Object.entries(tokens.ring)) lines.push(`    --ring-${name}: ${value};`)
  for (const [name, value] of Object.entries(tokens.font)) lines.push(`    --font-${name}: ${value};`)
  for (const [name, [size, lh, weight]] of Object.entries(tokens.type)) {
    lines.push(`    --t-${name}: ${size}px;`)
    lines.push(`    --t-${name}-lh: ${lh}px;`)
    if (weight !== 400) lines.push(`    --t-${name}-w: ${weight};`)
  }
  for (const [name, v] of Object.entries(tokens.weight)) lines.push(`    --w-${name}: ${v};`)
  tokens.space.forEach((v) => lines.push(`    --s-${String(v).replace('.', '_')}: ${v}px;`))
  for (const [name, v] of Object.entries(tokens.radius)) lines.push(`    --r-${name}: ${v}px;`)
  for (const [name, v] of Object.entries(tokens.size)) lines.push(`    --size-${name}: ${v}px;`)
  for (const [name, v] of Object.entries(tokens.motion)) lines.push(`    --${name.startsWith('ease') ? name : `dur-${name}`}: ${v};`)
  lines.push(`    --press-scale: ${tokens.press.scale};`)
  for (const [name, v] of Object.entries(tokens.z ?? {})) lines.push(`    --z-${name}: ${v};`)
  for (const [k, v] of Object.entries(tokens.d)) lines.push(`    --d-${k}: ${v}px;`)
  lines.push('  }')
  lines.push("  :root[data-theme='light'] { color-scheme: light; }")
  lines.push("  :root[data-theme='dark'] { color-scheme: dark; }")
  lines.push('  @media (prefers-color-scheme: dark) {')
  lines.push("    :root:not([data-theme='light']) {")
  lines.push(...darkShadowLines('      '))
  lines.push('    }')
  lines.push('  }')
  lines.push("  :root[data-theme='dark'] {")
  lines.push(...darkShadowLines())
  lines.push('  }')
  const overridden = new Set(Object.values(tokens.density).flatMap((values) => Object.keys(values)))
  lines.push("  [data-density-scope='compact'] {")
  for (const k of overridden) {
    const value = baseDensityValue(k)
    if (Array.isArray(value)) {
      lines.push(`    --${k}: ${value[0]}px;`)
      lines.push(`    --${k}-lh: ${value[1]}px;`)
    } else lines.push(`    --${k}: ${value}px;`)
  }
  lines.push('  }')
  for (const [name, values] of Object.entries(tokens.density)) {
    lines.push(`  :root[data-density='${name}'], [data-density-scope='${name}'] {`)
    for (const [k, v] of Object.entries(values)) {
      if (Array.isArray(v)) {
        lines.push(`    --${k}: ${v[0]}px;`)
        lines.push(`    --${k}-lh: ${v[1]}px;`)
      } else lines.push(`    --${k}: ${v}px;`)
    }
    lines.push('  }')
  }
  lines.push('}')
  return lines.join('\n') + '\n'
}

// 从砚（E:/pi-desktop，提交 ac6ab9ff）拆来；砚那边的 MCP 主题与手机端生成物不适用，已去掉。
const outputs = [
  [join(root, 'src/renderer/src/design/tokens.css'), buildCss()],
]

const check = process.argv.includes('--check')
let stale = 0
for (const [file, content] of outputs) {
  const rel = relative(root, file).replaceAll('\\', '/')
  if (check) {
    const current = existsSync(file) ? readFileSync(file, 'utf8').replaceAll('\r\n', '\n') : null
    if (current !== content) {
      stale += 1
      console.error(`生成物过期：${rel}（运行 node scripts/design/build-tokens.mjs）`)
    }
  } else {
    writeFileSync(file, content)
    console.log(`已生成 ${rel}`)
  }
}
if (check) {
  if (stale) process.exit(1)
  console.log('令牌生成物与来源一致')
}
