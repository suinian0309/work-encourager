import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { nativeImage } from 'electron'
import type { Live2dModelInfo } from '@shared/types'

/** 贴图长边上限：8192² 的原图直接进显存约 620MB，2048 后约 46MB，细节仍然够看 */
const MAX_TEXTURE_EDGE = 2048
/** 单个模型允许的最大体积，超过则拒绝导入，避免拷一半撑爆磁盘 */
const MAX_MODEL_BYTES = 240 * 1024 * 1024
/** 扫描模型目录的最大深度，防止有人在盘根目录误选 */
const MAX_SCAN_DEPTH = 4

interface Model3Json {
  Version?: number
  FileReferences?: {
    Moc?: string
    Textures?: string[]
    Physics?: string
    Pose?: string
    DisplayInfo?: string
    Motions?: Record<string, Array<{ File?: string; Sound?: string; [key: string]: unknown }>>
    Expressions?: Array<{ Name?: string; File?: string }>
    [key: string]: unknown
  }
  Groups?: unknown
  HitAreas?: unknown
  Layout?: unknown
  [key: string]: unknown
}

export interface ImportResult {
  info: Live2dModelInfo
  stats: { textures: number; motions: number; expressions: number; bytes: number; resized: string[] }
}

/** 按需重命名的表情：只挑“表情类”的，切换服饰/体型的表达式不参与随机，否则会把角色脱掉一半 */
const SAFE_EXPRESSION_HINTS = ['＞＜', '脸红', '爱心', '圈圈', '兔牙', '冷汗', '流泪', '黑脸', '屑屑']

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/** 递归统计目录体积，用于导入前的容量阈值判断 */
async function dirBytes(path: string): Promise<number> {
  const info = await stat(path)
  if (!info.isDirectory()) return info.size
  const entries = await readdir(path, { withFileTypes: true })
  let total = 0
  for (const entry of entries) total += await dirBytes(join(path, entry.name))
  return total
}

/**
 * 判断贴图是否需要缩放，需要时用 Electron 自带的 nativeImage 解码后等比缩到长边上限，
 * 再编码成 PNG。失败时原样拷贝，保证导入不因为个别图片格式而整体失败。
 */
async function copyTexture(source: string, target: string): Promise<string | null> {
  const image = nativeImage.createFromPath(source)
  if (image.isEmpty()) {
    await copyFile(source, target)
    return null
  }
  const { width, height } = image.getSize()
  const longest = Math.max(width, height)
  if (longest <= MAX_TEXTURE_EDGE) {
    await copyFile(source, target)
    return null
  }
  const resized =
    width >= height
      ? image.resize({ width: MAX_TEXTURE_EDGE, quality: 'good' })
      : image.resize({ height: MAX_TEXTURE_EDGE, quality: 'good' })
  const png = resized.toPNG()
  await writeFile(target, png)
  const after = resized.getSize()
  return `${basename(source)} ${width}×${height} → ${after.width}×${after.height}`
}

/** 目录索引：小写相对路径 → 绝对路径；以及文件名 → 绝对路径列表，用于模型里写错大小写或路径的情况 */
interface FileIndex {
  root: string
  byPath: Map<string, string>
  byName: Map<string, string[]>
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

async function buildIndex(root: string): Promise<FileIndex> {
  const index: FileIndex = { root, byPath: new Map(), byName: new Map() }
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      const rel = normalizePath(relative(root, full))
      index.byPath.set(rel, full)
      const key = entry.name.toLowerCase()
      const list = index.byName.get(key)
      if (list) list.push(full)
      else index.byName.set(key, [full])
    }
  }
  await walk(root, 0)
  return index
}

function resolveRef(index: FileIndex, ref: string | undefined): string | null {
  if (!ref) return null
  const relative = resolve(index.root, ref)
  if (existsSync(relative)) return relative
  const normalized = normalizePath(ref)
  const direct = index.byPath.get(normalized)
  if (direct) return direct
  const tail = normalized.split('/').slice(-1)[0]
  const candidates = index.byName.get(tail)
  if (candidates && candidates.length === 1) return candidates[0]
  // 同名文件多个时，挑路径后缀最贴近引用写法的那一个
  if (candidates && candidates.length > 1) {
    const hit = candidates.find((item) => normalizePath(item).endsWith(normalized))
    if (hit) return hit
  }
  return null
}

/** 目录里可能有多个 model3.json，取层级最浅、文件名最短的那个（主模型通常在最外层） */
async function findModelJson(dir: string): Promise<string | null> {
  const found: string[] = []
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) return
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (/\.model3\.json$/i.test(entry.name)) {
        found.push(full)
      }
    }
  }
  await walk(dir, 0)
  if (found.length === 0) return null
  found.sort((a, b) => relative(dir, a).split(/[\\/]/).length - relative(dir, b).split(/[\\/]/).length || a.length - b.length)
  return found[0]
}

/** 模型没在 model3.json 里挂动作/表情时（VTube Studio 导出的模型经常这样），从目录里扫出来 */
function scanMotions(index: FileIndex): string[] {
  const list = [...index.byPath.entries()]
    .filter(([rel]) => rel.endsWith('.motion3.json'))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, full]) => full)
  return list
}

function scanExpressions(index: FileIndex): string[] {
  return [...index.byPath.entries()]
    .filter(([rel]) => rel.endsWith('.exp3.json'))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, full]) => full)
}

function isIdleMotion(path: string): boolean {
  return /idle|待机|闲置/i.test(basename(path))
}

function isSafeExpression(path: string): boolean {
  const name = basename(path)
  return SAFE_EXPRESSION_HINTS.some((hint) => name.includes(hint))
}

/**
 * 导入一个 Live2D 模型：
 * 1. 输入可以是 .model3.json，也可以是模型文件夹（文件夹里递归找 model3.json）；
 * 2. 引用一律按“相对路径 → 大小写不敏感 → 同名唯一”三级解析，兼容中文目录与 texture 子目录；
 * 3. model3.json 没挂动作/表情时，自动扫描 *.motion3.json 与 *.exp3.json；
 * 4. 全部改写成 ASCII 文件名拷到 <userData>/live2d/<id>/，避开中文路径在自定义协议与打包环境里的坑；
 * 5. 贴图长边超过 2048 的自动降采样，控制显存占用。
 */
export async function importLive2dModel(inputPath: string, rootDir: string): Promise<ImportResult> {
  if (!existsSync(inputPath)) throw new Error('找不到模型：' + inputPath)

  const inputStat = await stat(inputPath)
  let modelJsonPath: string
  if (inputStat.isDirectory()) {
    const found = await findModelJson(inputPath)
    if (!found) throw new Error('这个文件夹里没有 *.model3.json，请选择 Cubism 3/4/5 的模型目录')
    modelJsonPath = found
  } else {
    if (!inputPath.toLowerCase().endsWith('.model3.json')) {
      throw new Error('请选择 .model3.json 文件（Cubism 3/4/5 模型描述文件）')
    }
    modelJsonPath = inputPath
  }

  const sourceDir = dirname(resolve(modelJsonPath))
  const index = await buildIndex(sourceDir)
  const raw = await readFile(modelJsonPath, 'utf8')
  let model: Model3Json
  try {
    model = JSON.parse(raw) as Model3Json
  } catch {
    throw new Error('model3.json 不是合法的 JSON，可能文件损坏')
  }

  const refs = model.FileReferences
  if (!refs || !refs.Moc) throw new Error('model3.json 里没有 Moc 字段，可能不是 Cubism 3+ 模型')
  const mocPath = resolveRef(index, refs.Moc)
  if (!mocPath) throw new Error('模型引用的 moc3 文件不存在：' + refs.Moc)

  const totalBytes = await dirBytes(sourceDir)
  if (totalBytes > MAX_MODEL_BYTES) {
    throw new Error(`模型目录 ${Math.round(totalBytes / 1024 / 1024)}MB，超过 ${MAX_MODEL_BYTES / 1024 / 1024}MB 上限`)
  }

  const id = createHash('sha1').update(resolve(modelJsonPath) + ':' + Date.now()).digest('hex').slice(0, 12)
  const targetDir = join(rootDir, id)
  await ensureDir(join(targetDir, 'motions'))
  await ensureDir(join(targetDir, 'expressions'))

  const out: Model3Json = {
    Version: model.Version ?? 3,
    FileReferences: {
      Moc: 'model.moc3',
      Textures: []
    }
  }
  if (model.Groups) out.Groups = model.Groups
  if (model.HitAreas) out.HitAreas = model.HitAreas
  if (model.Layout) out.Layout = model.Layout

  await copyFile(mocPath, join(targetDir, 'model.moc3'))

  const resized: string[] = []
  const textures = refs.Textures ?? []
  if (textures.length === 0) throw new Error('model3.json 里没有 Textures，模型不完整')
  for (let i = 0; i < textures.length; i += 1) {
    const source = resolveRef(index, textures[i])
    if (!source) throw new Error('模型引用的贴图不存在：' + textures[i])
    const target = join(targetDir, `tex${i}.png`)
    const note = await copyTexture(source, target)
    if (note) resized.push(note)
    out.FileReferences!.Textures!.push(`tex${i}.png`)
  }

  const physics = resolveRef(index, refs.Physics)
  if (physics) {
    await copyFile(physics, join(targetDir, 'physics3.json'))
    out.FileReferences!.Physics = 'physics3.json'
  }
  const displayInfo = resolveRef(index, refs.DisplayInfo)
  if (displayInfo) {
    await copyFile(displayInfo, join(targetDir, 'cdi3.json'))
    out.FileReferences!.DisplayInfo = 'cdi3.json'
  }
  const pose = resolveRef(index, refs.Pose)
  if (pose) {
    await copyFile(pose, join(targetDir, 'pose3.json'))
    out.FileReferences!.Pose = 'pose3.json'
  }

  // 动作：优先用 model3.json 里声明的分组，没有就扫描目录；IDLE 单独成组循环播放，其余归到 TapBody 随机点
  const declared: Array<{ group: string; file: string }> = []
  if (refs.Motions) {
    for (const [group, list] of Object.entries(refs.Motions)) {
      for (const item of list ?? []) {
        const source = resolveRef(index, item.File)
        if (source) declared.push({ group, file: source })
      }
    }
  }
  const motionFiles = declared.length > 0 ? declared : scanMotions(index).map((file) => ({
    group: isIdleMotion(file) ? 'Idle' : 'TapBody',
    file
  }))

  const motions: Record<string, Array<{ File: string }>> = {}
  let motionCount = 0
  for (const item of motionFiles) {
    const file = `motions/m${motionCount}.motion3.json`
    await copyFile(item.file, join(targetDir, file))
    motionCount += 1
    const group = motions[item.group] ?? (motions[item.group] = [])
    group.push({ File: file })
  }
  // 没有 IDLE 时用第一个动作兜底，避免角色僵住
  if (!motions['Idle'] && motions['TapBody']?.[0]) {
    motions['Idle'] = [motions['TapBody'][0]]
  }
  if (Object.keys(motions).length > 0) out.FileReferences!.Motions = motions

  // 表情：同样优先用声明，其次扫描；只保留“表情类”的，服饰/体型的开关表达式会让角色状态错乱
  const expressionFiles: string[] = []
  if (refs.Expressions && refs.Expressions.length > 0) {
    for (const item of refs.Expressions) {
      const source = resolveRef(index, item.File)
      if (source) expressionFiles.push(source)
    }
  } else {
    expressionFiles.push(...scanExpressions(index).filter(isSafeExpression))
  }

  const expressions: Array<{ Name: string; File: string }> = []
  for (const source of expressionFiles) {
    const file = `expressions/e${expressions.length}.exp3.json`
    await copyFile(source, join(targetDir, file))
    expressions.push({ Name: basename(source, extname(source)).replace(/\.exp3$/i, ''), File: file })
  }
  if (expressions.length > 0) out.FileReferences!.Expressions = expressions

  await writeFile(join(targetDir, 'model3.json'), JSON.stringify(out, null, 2), 'utf8')

  const name = inputStat.isDirectory()
    ? basename(resolve(inputPath))
    : basename(modelJsonPath).replace(/\.model3\.json$/i, '')
  const info: Live2dModelInfo = {
    id,
    name: name.slice(0, 60),
    importedAt: Date.now(),
    textures: textures.length,
    source: resolve(inputPath)
  }
  return {
    info,
    stats: { textures: textures.length, motions: motionCount, expressions: expressions.length, bytes: totalBytes, resized }
  }
}

/** 删除指定模型目录，忽略不存在的情况 */
export async function removeLive2dModel(rootDir: string, id: string): Promise<void> {
  if (!/^[a-f0-9]{8,40}$/.test(id)) throw new Error('模型 id 非法')
  await rm(join(rootDir, id), { recursive: true, force: true })
}
