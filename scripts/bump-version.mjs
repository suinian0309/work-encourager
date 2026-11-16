// 一次性脚本：把仓库内版本号统一升到 1.3.0
import { readFileSync, writeFileSync } from 'node:fs'

const targets = [
  ['package.json', /"version":\s*"1\.2\.0"/g, '"version": "1.3.0"'],
  ['apps/electron/package.json', /"version":\s*"1\.2\.0"/g, '"version": "1.3.0"'],
  ['apps/tauri/package.json', /"version":\s*"1\.2\.0"/g, '"version": "1.3.0"'],
  ['apps/tauri/src-tauri/tauri.conf.json', /"version":\s*"1\.2\.0"/g, '"version": "1.3.0"'],
  ['apps/tauri/src-tauri/Cargo.toml', /^version = "1\.2\.0"$/m, 'version = "1.3.0"'],
  ['apps/slint/Cargo.toml', /^version = "1\.2\.0"$/m, 'version = "1.3.0"']
]

for (const [file, from, to] of targets) {
  const text = readFileSync(file, 'utf8')
  const next = text.replace(from, to)
  if (next === text) {
    console.log(`${file}: 无需修改（可能已是 1.3.0）`)
    continue
  }
  writeFileSync(file, next, 'utf8')
  console.log(`${file}: 已升级`)
}
