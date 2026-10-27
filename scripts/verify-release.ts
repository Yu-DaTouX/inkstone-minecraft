import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { MICROSOFT_CLIENT_ID } from '../src/shared/microsoft-config.ts'

const directory = resolve(process.argv.find((arg) => arg.startsWith('--dir='))?.slice(6) ?? 'dist')
const assetsOnly = process.argv.includes('--assets-only')
const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { version: string }
const installer = `Inkstone-Minecraft-Setup-${pkg.version}.exe`
const blockmap = `${installer}.blockmap`
const names = [installer, blockmap, 'latest.yml']
const assets = await Promise.all(names.map(async (name) => {
  const file = join(directory, name)
  const info = await stat(file)
  assert.ok(info.isFile() && info.size > 0, `Missing or empty release asset: ${name}`)
  const bytes = await readFile(file)
  return { name, size: info.size, sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('base64') }
}))
const metadata = await readFile(join(directory, 'latest.yml'), 'utf8')
assert.equal(metadata.match(/^version:\s*(\S+)/m)?.[1], pkg.version, 'Update version does not match package')
assert.equal(metadata.match(/^path:\s*(.+)$/m)?.[1].trim(), installer, 'Update path does not match installer')
assert.equal(metadata.match(/- url:\s*(.+)$/m)?.[1].trim(), installer, 'Update file URL does not match installer')
assert.equal(metadata.match(/^sha512:\s*(\S+)/m)?.[1], assets[0].sha512, 'Root update hash mismatch')
assert.equal(metadata.match(/^\s+sha512:\s*(\S+)/m)?.[1], assets[0].sha512, 'File update hash mismatch')
assert.equal(Number(metadata.match(/^\s+size:\s*(\d+)/m)?.[1]), assets[0].size, 'Update size mismatch')

if (!assetsOnly) {
  const require = createRequire(import.meta.url)
  const asar = require('@electron/asar') as { extractFile(archive: string, name: string): Buffer; listPackage(archive: string): string[] }
  const archive = join(directory, 'win-unpacked/resources/app.asar')
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString()) as { version: string }
  assert.equal(packaged.version, pkg.version, 'Packaged version mismatch')
  const main = asar.extractFile(archive, join('out', 'main', 'index.js')).toString()
  assert.ok(main.includes(MICROSOFT_CLIENT_ID), 'Packaged app is missing the Microsoft client ID')
  assert.ok(main.includes('craft:mods:watch'), 'Packaged app is missing Mod watch IPC')
  const preload = asar.extractFile(archive, join('out', 'preload', 'index.cjs')).toString()
  assert.ok(preload.includes('craft:microsoft:begin') && preload.includes('craft:mods:watch'), 'Packaged preload is incomplete')
  const files = asar.listPackage(archive)
  assert.ok(files.some((file) => /out[\\/]renderer[\\/]index\.html$/.test(file)), 'Packaged renderer is missing')
}
console.log(JSON.stringify({ version: pkg.version, directory, assetsOnly, packageVerified: !assetsOnly, assets }, null, 2))
