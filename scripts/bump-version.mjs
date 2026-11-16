// 把仓库内版本号统一升到 argv[2]（默认从根 package.json 读当前版本）
import { readFileSync, writeFileSync } from 'node:fs'

const FILES = [
  'package.json',
  'apps/electron/package.json',
  'apps/tauri/package.json',
  'apps/tauri/src-tauri/tauri.conf.json',
  'apps/tauri/src-tauri/Cargo.toml',
  'apps/slint/Cargo.toml'
]

const current = JSON.parse(readFileSync('package.json', 'utf8')).version
const target = process.argv[2]
if (!target || !/^\d+\.\d+\.\d+$/.test(target)) {
  console.error(`用法：node scripts/bump-version.mjs <x.y.z>（当前 ${current}）`)
  process.exit(1)
}
if (current === target) {
  console.log(`已是 ${target}，无需修改`)
  process.exit(0)
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
for (const file of FILES) {
  const text = readFileSync(file, 'utf8')
  const next = text.replace(new RegExp(escape(current), 'g'), target)
  if (next === text) {
    console.log(`${file}: 未找到 ${current}`)
    continue
  }
  writeFileSync(file, next, 'utf8')
  console.log(`${file}: ${current} → ${target}`)
}
