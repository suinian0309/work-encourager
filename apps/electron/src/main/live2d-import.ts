import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { nativeImage } from 'electron'
import type { Live2dModelInfo } from '@shared/types'

/** 贴图长边上限：大肥鱼原图 8192² 直接进显存约 620MB，降到 1024 后约 14MB */
const MAX_TEXTURE_EDGE = 1024
/** 单个模型允许的最大体积，超过则拒绝导入，避免拷一半撑爆磁盘 */
const MAX_MODEL_BYTES = 240 * 1024 * 1024

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

function resolveRef(baseDir: string, ref: string | undefined): string | null {
  if (!ref) return null
  const target = resolve(baseDir, ref)
  return existsSync(target) ? target : null
}

/**
 * 导入一个 Live2D 模型：
 * 1. 读取 model3.json，解析 moc3 / 贴图 / 物理 / 动作 / 表情的引用；
 * 2. 全部改写成 ASCII 文件名拷贝到 <userData>/live2d/<id>/，避开中文路径在自定义协议与打包环境里的坑；
 * 3. 贴图长边超过 1024 的自动降采样，控制显存占用；
 * 4. 返回新模型的元信息，供 db.live2d 持久化。
 */
export async function importLive2dModel(
  modelJsonPath: string,
  rootDir: string
): Promise<ImportResult> {
  if (!existsSync(modelJsonPath)) throw new Error('找不到模型文件：' + modelJsonPath)
  if (!modelJsonPath.toLowerCase().endsWith('.model3.json')) {
    throw new Error('请选择 .model3.json 文件（Cubism 3/4/5 模型描述文件）')
  }

  const sourceDir = dirname(resolve(modelJsonPath))
  const raw = await readFile(modelJsonPath, 'utf8')
  let model: Model3Json
  try {
    model = JSON.parse(raw) as Model3Json
  } catch {
    throw new Error('model3.json 不是合法的 JSON，可能文件损坏')
  }

  const refs = model.FileReferences
  if (!refs || !refs.Moc) throw new Error('model3.json 里没有 Moc 字段，可能不是 Cubism 3+ 模型')
  const mocPath = resolveRef(sourceDir, refs.Moc)
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
      Textures: [],
    },
  }
  if (model.Groups) out.Groups = model.Groups
  if (model.HitAreas) out.HitAreas = model.HitAreas
  if (model.Layout) out.Layout = model.Layout

  await copyFile(mocPath, join(targetDir, 'model.moc3'))

  const resized: string[] = []
  const textures = refs.Textures ?? []
  for (let i = 0; i < textures.length; i += 1) {
    const source = resolveRef(sourceDir, textures[i])
    if (!source) throw new Error('模型引用的贴图不存在：' + textures[i])
    const target = join(targetDir, `tex${i}.png`)
    const note = await copyTexture(source, target)
    if (note) resized.push(note)
    out.FileReferences!.Textures!.push(`tex${i}.png`)
  }

  const physics = resolveRef(sourceDir, refs.Physics)
  if (physics) {
    await copyFile(physics, join(targetDir, 'physics3.json'))
    out.FileReferences!.Physics = 'physics3.json'
  }
  const displayInfo = resolveRef(sourceDir, refs.DisplayInfo)
  if (displayInfo) {
    await copyFile(displayInfo, join(targetDir, 'cdi3.json'))
    out.FileReferences!.DisplayInfo = 'cdi3.json'
  }
  const pose = resolveRef(sourceDir, refs.Pose)
  if (pose) {
    await copyFile(pose, join(targetDir, 'pose3.json'))
    out.FileReferences!.Pose = 'pose3.json'
  }

  let motionCount = 0
  if (refs.Motions) {
    const motions: Record<string, Array<Record<string, unknown>>> = {}
    for (const [group, list] of Object.entries(refs.Motions)) {
      const entries: Array<Record<string, unknown>> = []
      for (const item of list ?? []) {
        const source = resolveRef(sourceDir, item.File)
        if (!source) continue
        const file = `motions/m${motionCount}.motion3.json`
        await copyFile(source, join(targetDir, file))
        motionCount += 1
        const { File: _file, Sound: _sound, ...rest } = item
        entries.push({ ...rest, File: file })
      }
      if (entries.length > 0) motions[group] = entries
    }
    if (Object.keys(motions).length > 0) out.FileReferences!.Motions = motions
  }

  let expressionCount = 0
  if (refs.Expressions) {
    const expressions: Array<{ Name: string; File: string }> = []
    for (const item of refs.Expressions) {
      const source = resolveRef(sourceDir, item.File)
      if (!source) continue
      const file = `expressions/e${expressionCount}.exp3.json`
      await copyFile(source, join(targetDir, file))
      expressions.push({ Name: item.Name || basename(item.File || file, '.exp3.json'), File: file })
      expressionCount += 1
    }
    if (expressions.length > 0) out.FileReferences!.Expressions = expressions
  }

  await writeFile(join(targetDir, 'model3.json'), JSON.stringify(out, null, 2), 'utf8')

  const info: Live2dModelInfo = {
    id,
    name: basename(modelJsonPath).replace(/\.model3\.json$/i, ''),
    importedAt: Date.now(),
    textures: textures.length,
    source: modelJsonPath,
  }
  return {
    info,
    stats: { textures: textures.length, motions: motionCount, expressions: expressionCount, bytes: totalBytes, resized },
  }
}

/** 删除指定模型目录，忽略不存在的情况 */
export async function removeLive2dModel(rootDir: string, id: string): Promise<void> {
  if (!/^[a-f0-9]{8,40}$/.test(id)) throw new Error('模型 id 非法')
  await rm(join(rootDir, id), { recursive: true, force: true })
}
