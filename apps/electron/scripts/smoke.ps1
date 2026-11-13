# 开发期 UI 冒烟测试：真实启动 Electron，点击按钮、验证暂停/重置/设置保存/重启持久化
# 用法：powershell -ExecutionPolicy Bypass -File scripts/smoke.ps1
# 说明：本仓库所在的受限测试会话需要 --no-sandbox --disable-gpu；普通桌面环境可移除这两个参数。
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $SkipBuild) {
  pnpm build
}

$smokeDir = Join-Path $root '.smoke-run'
$dataDir = Join-Path $root '.smoke-run-data'
Remove-Item -Recurse -Force $smokeDir, $dataDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $smokeDir | Out-Null
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$env:WORK_ENC_SMOKE_DIR = $smokeDir

Write-Host '=== 第一阶段：默认配置、暂停、重置、设置保存、截图 ==='
$env:WORK_ENC_SMOKE_PHASE = '1'
& $electron . "--user-data-dir=$dataDir" --no-sandbox --disable-gpu

Write-Host '=== 第二阶段：重启后的持久化 ==='
$env:WORK_ENC_SMOKE_PHASE = '2'
& $electron . "--user-data-dir=$dataDir" --no-sandbox --disable-gpu

Write-Host "截图与结果：$smokeDir"
