import { invoke } from '@tauri-apps/api/core'
import type { Live2dModelInfo } from '@shared/types'

/** 贴图长边上限：原图 8192² 直接进显存约 620MB，降到 1024 后约 14MB */
const MAX_TEXTURE_EDGE = 1024
/** 模型目录体积上限，超过直接拒绝，避免一次读几 GB 卡死渲染进程 */
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

export interface TauriImportResult {
  info: Live2dModelInfo
  stats: { textures: number; motions: number; expressions: number; bytes: number; resized: string[] }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

function dirOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
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

/** 用 canvas 把贴图等比缩到长边 1024，失败时退回原图，保证导入不整体失败 */
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

/**
 * 在渲染层整理用户选择的模型目录：
 * - 所有文件改写成 ASCII 文件名（中文路径在打包环境与自定义协议里容易出问题）；
 * - 贴图用 canvas 降采样，控制显存；
 * - 通过 live2d_save 命令落盘到 <data>/live2d/<id>/。
 */
export async function importLive2dFromFiles(files: FileList): Promise<TauriImportResult> {
  const list = Array.from(files)
  if (list.length === 0) throw new Error('没有选择任何文件')

  const byPath = new Map<string, File>()
  for (const file of list) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    byPath.set(normalizePath(relative), file)
  }

  const modelEntry = list.find((file) => file.name.toLowerCase().endsWith('.model3.json'))
  if (!modelEntry) throw new Error('目录里没有 .model3.json，请选择模型所在文件夹')

  const relativeModel = normalizePath((modelEntry as File & { webkitRelativePath?: string }).webkitRelativePath || modelEntry.name)
  const sourceDir = dirOf(relativeModel)
  const lookup = (ref: string | undefined): File | null => {
    if (!ref) return null
    return byPath.get(normalizePath(joinPath(sourceDir, ref))) ?? null
  }

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

  let motionCount = 0
  if (refs.Motions) {
    const motions: Record<string, Array<Record<string, unknown>>> = {}
    for (const [group, items] of Object.entries(refs.Motions)) {
      const entries: Array<Record<string, unknown>> = []
      for (const item of items ?? []) {
        const file = lookup(item.File)
        if (!file) continue
        const name = `motions/m${motionCount}.motion3.json`
        writes.push([name, base64OfText(await file.text())])
        motionCount += 1
        const { File: _file, Sound: _sound, ...rest } = item
        entries.push({ ...rest, File: name })
      }
      if (entries.length > 0) motions[group] = entries
    }
    if (Object.keys(motions).length > 0) out.FileReferences!.Motions = motions
  }

  let expressionCount = 0
  if (refs.Expressions) {
    const expressions: Array<{ Name: string; File: string }> = []
    for (const item of refs.Expressions) {
      const file = lookup(item.File)
      if (!file) continue
      const name = `expressions/e${expressionCount}.exp3.json`
      writes.push([name, base64OfText(await file.text())])
      expressions.push({
        Name: item.Name || (item.File ?? name).replace(/\.exp3\.json$/i, ''),
        File: name
      })
      expressionCount += 1
    }
    if (expressions.length > 0) out.FileReferences!.Expressions = expressions
  }

  writes.push(['model3.json', base64OfText(JSON.stringify(out, null, 2))])
  await invoke('live2d_save', { id, files: writes })

  return {
    info: {
      id,
      name: modelEntry.name.replace(/\.model3\.json$/i, ''),
      importedAt: Date.now(),
      textures: textures.length,
      source: (modelEntry as File & { webkitRelativePath?: string }).webkitRelativePath || modelEntry.name
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
