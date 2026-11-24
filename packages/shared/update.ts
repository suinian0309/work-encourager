/**
 * 版本与更新：型号无关的公共部分（版本号比较、更新包信息类型）。
 *
 * 真正的网络与落盘动作在各端自己的壳里做（Electron 主进程、Tauri Rust 侧），
 * 这里只放两端都要用的判断逻辑，避免两份实现算出两种结论。
 */

/** 更新源仓库（GitHub Releases） */
export const UPDATE_REPO = 'suinian0309/work-encourager'

export interface UpdateAssetInfo {
  name: string
  size: number
  url: string
}

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  notes: string
  publishedAt: string
  pageUrl: string
  /** 当前平台能直接装的那个包，找不到就是 null（例如只有 zip） */
  asset: UpdateAssetInfo | null
  checkedAt: number
}

export interface UpdateProgress {
  phase: 'download' | 'install'
  received: number
  total: number
  percent: number
}

export interface UpdateDownloadResult {
  ok: boolean
  path?: string
  message?: string
}

export type UpdateState = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready'

/** 把 "v1.4.10" / "1.4" 这类字符串拆成数字数组，非数字段落按 0 处理 */
export function parseVersion(input: string): number[] {
  const cleaned = String(input ?? '').trim().replace(/^v/i, '')
  const main = cleaned.split('-')[0] ?? ''
  return main.split('.').map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) && value >= 0 ? value : 0
  })
}

/** 返回 >0 表示 a 比 b 新，<0 表示 a 比 b 旧，0 表示相同 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l > r ? 1 : -1
  }
  return 0
}

/** 从 Release 的资产列表里挑出能直接安装的包 */
export function pickInstaller(
  assets: readonly UpdateAssetInfo[],
  flavor: 'electron' | 'tauri'
): UpdateAssetInfo | null {
  const msix = assets.filter((item) => /\.msi$/i.test(item.name))
  if (msix.length === 0) return null
  if (flavor === 'electron') {
    return msix.find((item) => /electron/i.test(item.name)) ?? null
  }
  const tauri = msix.find((item) => /tauri/i.test(item.name))
  if (tauri) return tauri
  // 本地构建出来的包名是「上班鼓励器_x.y.z_x64_zh-CN.msi」，没有 tauri 字样
  return msix.find((item) => !/electron/i.test(item.name)) ?? null
}
