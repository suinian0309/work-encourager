import { invoke } from '@tauri-apps/api/core'
import type { Live2dModelInfo } from '@shared/types'

/** 贴图长边上限：原图 8192² 进显存约 620MB，降到 2048 后约 20MB 内，同时保留细节 */
const MAX_TEXTURE_EDGE = 2048
/** 模型目录体积上限，超过直接拒绝，避免一次读几 GB 卡死渲染进程 */
const MAX_MODEL_BYTES = 240 * 1024 * 1024
/** 动作/表情目录最多往下找几层 */
const MAX_SCAN_DEPTH = 4
/**
 * 只自动启用“改了不吓人”的表情。
 * 官方模型目录里常把眼镜、钢盆、换裙子这类换装项也做成 exp3，
 * 全量挂上去会导致点一下就变成完全不同的造型。
 */
const SAFE_EXPRESSION_HINTS = ['＞＜', '脸红', '爱心', '圈圈', '兔牙', '冷汗', '流泪', '黑脸', '屑屑']

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

export interface TauriImportResult {
  info: Live2dModelInfo
  stats: { textures: number; motions: number; expressions: number; bytes: number; resized: string[] }
}

interface FileIndex {
  byPath: Map<string, File>
  byName: Map<string, File[]>
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

function dirOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function nameOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

function depthOf(path: string): number {
  return path.split('/').length - 1
}

function joinPath(dir: string, ref: string): string {
  const clean = ref.replace(/\\/g, '/')
  return dir ? `${dir}/${clean}` : clean
}

function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

function base64OfText(text: string): string {
  const bytes = new TextEncoder().encode(text)
  return base64Of(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
}

function relativeOf(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
}

function buildIndex(files: File[]): FileIndex {
  const byPath = new Map<string, File>()
  const byName = new Map<string, File[]>()
  for (const file of files) {
    const key = normalizePath(relativeOf(file))
    byPath.set(key, file)
    const name = nameOf(key)
    const bucket = byName.get(name)
    if (bucket) bucket.push(file)
    else byName.set(name, [file])
  }
  return { byPath, byName }
}

/**
 * 把 model3.json 里的引用解析成真实文件。
 * 顺序：相对模型目录 → 大小写不敏感全路径 → 同名唯一 → 相对根目录 → 后缀唯一。
 */
function resolveRef(index: FileIndex, sourceDir: string, ref: string | undefined): File | null {
  if (!ref) return null
  const direct = index.byPath.get(normalizePath(joinPath(sourceDir, ref)))
  if (direct) return direct
  const rootRelative = index.byPath.get(normalizePath(ref))
  if (rootRelative) return rootRelative
  const base = nameOf(ref.replace(/\\/g, '/')).toLowerCase()
  const sameName = index.byName.get(base)
  if (sameName && sameName.length === 1) return sameName[0]
  const suffix = ref.replace(/\\/g, '/').toLowerCase()
  const matches = Array.from(index.byPath.entries()).filter(([path]) => path.endsWith('/' + suffix) || path === suffix)
  return matches.length === 1 ? matches[0][1] : null
}

/** 用 canvas 把贴图等比缩到长边 2048，失败时退回原图，保证导入不整体失败 */
async function textureBase64(file: File): Promise<{ data: string; note: string | null }> {
  const original = base64Of(await file.arrayBuffer())
  try {
    const bitmap = await createImageBitmap(file)
    const longest = Math.max(bitmap.width, bitmap.height)
    if (longest <= MAX_TEXTURE_EDGE) {
      bitmap.close()
      return { data: original, note: null }
    }
    const scale = MAX_TEXTURE_EDGE / longest
    const width = Math.round(bitmap.width * scale)
    const height = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      bitmap.close()
      return { data: original, note: null }
    }
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const dataUrl = canvas.toDataURL('image/png')
    return { data: dataUrl, note: `${file.name} ${bitmap.width}×${bitmap.height} → ${width}×${height}` }
  } catch {
    return { data: original, note: null }
  }
}

function isIdleMotion(name: string): boolean {
  return /idle|待机|静止|呼吸|默认/i.test(name)
}

function isSafeExpression(name: string): boolean {
  return SAFE_EXPRESSION_HINTS.some((hint) => name.includes(hint))
}

/**
 * 在渲染层整理用户选择的模型目录：
 * - 所有文件改写成 ASCII 文件名（中文路径在打包环境与自定义协议里容易出问题）；
 * - 贴图用 canvas 降采样，控制显存；
 * - model3.json 没声明动作/表情时，扫描目录里的 motion3/exp3 并挂上去；
 * - 通过 live2d_save 命令落盘到 <data>/live2d/<id>/。
 */
export async function importLive2dFromFiles(files: FileList): Promise<TauriImportResult> {
  const list = Array.from(files)
  if (list.length === 0) throw new Error('没有选择任何文件')

  const index = buildIndex(list)
  const modelEntries = list
    .filter((file) => file.name.toLowerCase().endsWith('.model3.json'))
    .sort((a, b) => depthOf(normalizePath(relativeOf(a))) - depthOf(normalizePath(relativeOf(b))))
  const modelEntry = modelEntries[0]
  if (!modelEntry) throw new Error('目录里没有 .model3.json，请选择模型所在文件夹')

  const relativeModel = normalizePath(relativeOf(modelEntry))
  const sourceDir = dirOf(relativeModel)
  const rootDepth = depthOf(relativeModel) - 1
  const lookup = (ref: string | undefined): File | null => resolveRef(index, sourceDir, ref)

  let model: Model3Json
  try {
    model = JSON.parse(await modelEntry.text()) as Model3Json
  } catch {
    throw new Error('model3.json 不是合法的 JSON，可能文件损坏')
  }
  const refs = model.FileReferences
  if (!refs || !refs.Moc) throw new Error('model3.json 里没有 Moc 字段，可能不是 Cubism 3+ 模型')
  const moc = lookup(refs.Moc)
  if (!moc) throw new Error('模型引用的 moc3 文件不存在：' + refs.Moc)

  const totalBytes = list.reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > MAX_MODEL_BYTES) {
    throw new Error(
      `模型目录 ${Math.round(totalBytes / 1024 / 1024)}MB，超过 ${MAX_MODEL_BYTES / 1024 / 1024}MB 上限`
    )
  }

  const id = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

  const out: Model3Json = {
    Version: model.Version ?? 3,
    FileReferences: { Moc: 'model.moc3', Textures: [] }
  }
  if (model.Groups) out.Groups = model.Groups
  if (model.HitAreas) out.HitAreas = model.HitAreas
  if (model.Layout) out.Layout = model.Layout

  const writes: Array<[string, string]> = []
  writes.push(['model.moc3', base64Of(await moc.arrayBuffer())])

  const resized: string[] = []
  const textures = refs.Textures ?? []
  for (let i = 0; i < textures.length; i += 1) {
    const file = lookup(textures[i])
    if (!file) throw new Error('模型引用的贴图不存在：' + textures[i])
    const { data, note } = await textureBase64(file)
    if (note) resized.push(note)
    writes.push([`tex${i}.png`, data])
    out.FileReferences!.Textures!.push(`tex${i}.png`)
  }

  const physics = lookup(refs.Physics)
  if (physics) {
    writes.push(['physics3.json', base64OfText(await physics.text())])
    out.FileReferences!.Physics = 'physics3.json'
  }
  const displayInfo = lookup(refs.DisplayInfo)
  if (displayInfo) {
    writes.push(['cdi3.json', base64OfText(await displayInfo.text())])
    out.FileReferences!.DisplayInfo = 'cdi3.json'
  }
  const pose = lookup(refs.Pose)
  if (pose) {
    writes.push(['pose3.json', base64OfText(await pose.text())])
    out.FileReferences!.Pose = 'pose3.json'
  }

  const inScope = (file: File): boolean => depthOf(normalizePath(relativeOf(file))) - rootDepth <= MAX_SCAN_DEPTH

  // 动作：优先用 model3.json 的声明；没声明时扫描目录
  const motionFiles: File[] = []
  if (refs.Motions && Object.keys(refs.Motions).length > 0) {
    for (const items of Object.values(refs.Motions)) {
      for (const item of items ?? []) {
        const file = lookup(item.File)
        if (file) motionFiles.push(file)
      }
    }
  } else {
    const scanned = list
      .filter((file) => file.name.toLowerCase().endsWith('.motion3.json') && inScope(file))
      .sort((a, b) => relativeOf(a).localeCompare(relativeOf(b)))
    motionFiles.push(...scanned)
  }

  const motions: Record<string, Array<{ File: string }>> = {}
  let motionCount = 0
  for (const file of motionFiles) {
    const name = `motions/m${motionCount}.motion3.json`
    writes.push([name, base64OfText(await file.text())])
    motionCount += 1
    const group = isIdleMotion(file.name.replace(/\.motion3\.json$/i, '')) ? 'Idle' : 'TapBody'
    if (!motions[group]) motions[group] = []
    motions[group].push({ File: name })
  }
  if (motionCount > 0) {
    if (!motions.Idle && motions.TapBody?.length) {
      motions.Idle = [motions.TapBody[0]]
    }
    if (!motions.TapBody && motions.Idle?.length) {
      motions.TapBody = motions.Idle.slice(1)
    }
    out.FileReferences!.Motions = motions
  }

  // 表情：同样优先声明，其次扫描；扫描时只收安全项
  const expressionFiles: Array<{ file: File; name: string }> = []
  if (refs.Expressions && refs.Expressions.length > 0) {
    for (const item of refs.Expressions) {
      const file = lookup(item.File)
      if (!file) continue
      const name = item.Name || file.name.replace(/\.exp3\.json$/i, '')
      expressionFiles.push({ file, name })
    }
  } else {
    const scanned = list
      .filter((file) => file.name.toLowerCase().endsWith('.exp3.json') && inScope(file))
      .sort((a, b) => relativeOf(a).localeCompare(relativeOf(b)))
    for (const file of scanned) {
      const name = file.name.replace(/\.exp3\.json$/i, '')
      if (!isSafeExpression(name)) continue
      expressionFiles.push({ file, name })
    }
  }

  const expressions: Array<{ Name: string; File: string }> = []
  let expressionCount = 0
  for (const item of expressionFiles) {
    const name = `expressions/e${expressionCount}.exp3.json`
    writes.push([name, base64OfText(await item.file.text())])
    expressions.push({ Name: item.name, File: name })
    expressionCount += 1
  }
  if (expressions.length > 0) out.FileReferences!.Expressions = expressions

  writes.push(['model3.json', base64OfText(JSON.stringify(out, null, 2))])
  await invoke('live2d_save', { id, files: writes })

  return {
    info: {
      id,
      name: modelEntry.name.replace(/\.model3\.json$/i, ''),
      importedAt: Date.now(),
      textures: textures.length,
      source: relativeOf(modelEntry)
    },
    stats: {
      textures: textures.length,
      motions: motionCount,
      expressions: expressionCount,
      bytes: totalBytes,
      resized
    }
  }
}
