/**
 * postbuild.js — Copy static files not processed by Vite into dist/
 */
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const pub  = resolve(root, 'public')
const dist = resolve(root, 'dist')

function copy(src, dest) {
  const s = resolve(pub, src)
  if (!existsSync(s)) return
  const d = resolve(dist, dest || src)
  mkdirSync(dirname(d), { recursive: true })
  copyFileSync(s, d)
  console.log(`  copied: ${src}`)
}

function copyDir(src, dest) {
  const s = resolve(pub, src)
  if (!existsSync(s)) return
  cpSync(s, resolve(dist, dest || src), { recursive: true })
  console.log(`  copied dir: ${src}/`)
}

console.log('[postbuild] Copying static files...')
copy('robots.txt')
copy('sitemap.xml')
copy('manifest.json')
copy('google2e5bb7df731f7762.html')
copyDir('img')
console.log('[postbuild] Done.')
