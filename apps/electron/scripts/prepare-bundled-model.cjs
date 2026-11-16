/**
 * 把用户自有的 Live2D 模型整理成「随包附带」的形态。
 *
 * 用法：electron scripts/prepare-bundled-model.cjs "F:\\DSH\\live2d-dafeiyu\\DeepSeek"
 *
 * 产出：
 *   assets/live2d/<id>/model3.json ...   统一 ASCII 命名、贴图长边 2048
 *   assets/live2d/manifest.json          { id, name, textures, importedAt }
 *   同步复制到 apps/electron/resources/live2d 与 apps/tauri/src-tauri/resources/live2d
 *
 * 注意：这些产物是用户的美术素材，不进 Git（见 .gitignore）。
 */
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const MAX_TEXTURE_EDGE = 2048
const SAFE_EXPRESSION_HINTS = ['＞＜', '脸红', '爱心', '圈圈', '兔牙', '冷汗', '流泪', '黑脸', '屑屑']

const repoRoot = path.resolve(__dirname, '..', '..', '..')

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

function isIdle(name) {
  return /idle|待机|静止|呼吸|默认/i.test(name)
}

function resizeTexture(file) {
  const image = nativeImage.createFromPath(file)
  const size = image.getSize()
  const longest = Math.max(size.width, size.height)
  if (longest <= MAX_TEXTURE_EDGE) return { buffer: fs.readFileSync(file), note: null }
  const scale = MAX_TEXTURE_EDGE / longest
  const resized = image.resize({
    width: Math.round(size.width * scale),
    height: Math.round(size.height * scale),
    quality: 'best'
  })
  return {
    buffer: resized.toPNG(),
    note: `${path.basename(file)} ${size.width}×${size.height} → ${resized.getSize().width}×${resized.getSize().height}`
  }
}

async function main() {
  const source = process.argv[2] || process.env.WORK_ENC_MODEL_SOURCE
  if (!source || !fs.existsSync(source)) {
    console.error('用法：electron scripts/prepare-bundled-model.cjs <模型目录>')
    app.exit(1)
    return
  }

  const files = walk(source)
  const byPath = new Map(files.map((file) => [path.relative(source, file).replace(/\\/g, '/').toLowerCase(), file]))
  const byName = new Map()
  for (const file of files) {
    const key = path.basename(file).toLowerCase()
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key).push(file)
  }

  const modelFile = files
    .filter((file) => file.toLowerCase().endsWith('.model3.json'))
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)[0]
  if (!modelFile) {
    console.error('目录里没有 .model3.json')
    app.exit(1)
    return
  }

  const sourceDir = path.dirname(modelFile)
  const resolve = (ref) => {
    if (!ref) return null
    const rel = path.relative(source, path.resolve(sourceDir, ref)).replace(/\\/g, '/').toLowerCase()
    if (byPath.has(rel)) return byPath.get(rel)
    const base = path.basename(ref).toLowerCase()
    const same = byName.get(base)
    if (same && same.length === 1) return same[0]
    return null
  }

  const model = JSON.parse(fs.readFileSync(modelFile, 'utf8'))
  const refs = model.FileReferences || {}
  const mocPath = resolve(refs.Moc)
  if (!mocPath) throw new Error('moc3 找不到：' + refs.Moc)

  const id = require('node:crypto').randomBytes(6).toString('hex')
  const outRoot = path.join(repoRoot, 'assets', 'live2d')
  const outDir = path.join(outRoot, id)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(outDir, 'motions'), { recursive: true })
  fs.mkdirSync(path.join(outDir, 'expressions'), { recursive: true })

  const out = { Version: model.Version ?? 3, FileReferences: { Moc: 'model.moc3', Textures: [] } }
  if (model.Groups) out.Groups = model.Groups
  if (model.HitAreas) out.HitAreas = model.HitAreas
  if (model.Layout) out.Layout = model.Layout

  fs.copyFileSync(mocPath, path.join(outDir, 'model.moc3'))

  const textures = refs.Textures || []
  const resized = []
  textures.forEach((ref, index) => {
    const file = resolve(ref)
    if (!file) throw new Error('贴图找不到：' + ref)
    const { buffer, note } = resizeTexture(file)
    if (note) resized.push(note)
    fs.writeFileSync(path.join(outDir, `tex${index}.png`), buffer)
    out.FileReferences.Textures.push(`tex${index}.png`)
  })

  for (const [key, target] of [
    ['Physics', 'physics3.json'],
    ['Pose', 'pose3.json'],
    ['DisplayInfo', 'cdi3.json']
  ]) {
    const file = resolve(refs[key])
    if (file) {
      fs.copyFileSync(file, path.join(outDir, target))
      out.FileReferences[key] = target
    }
  }

  const declaredMotions = refs.Motions ? Object.values(refs.Motions).flat().map((item) => resolve(item.File)) : []
  const motionFiles = (declaredMotions.filter(Boolean).length ? declaredMotions.filter(Boolean) : files.filter((file) => file.toLowerCase().endsWith('.motion3.json'))).sort()
  const motions = {}
  motionFiles.forEach((file, index) => {
    const name = `motions/m${index}.motion3.json`
    fs.copyFileSync(file, path.join(outDir, name))
    const group = isIdle(path.basename(file)) ? 'Idle' : 'TapBody'
    if (!motions[group]) motions[group] = []
    motions[group].push({ File: name })
  })
  if (motions.TapBody && !motions.Idle) motions.Idle = [motions.TapBody[0]]
  if (motions.Idle && !motions.TapBody) motions.TapBody = motions.Idle.slice(1)
  if (Object.keys(motions).length) out.FileReferences.Motions = motions

  const declaredExpressions = (refs.Expressions || []).map((item) => ({ file: resolve(item.File), name: item.Name }))
  const expressionEntries = declaredExpressions.filter((item) => item.file).length
    ? declaredExpressions.filter((item) => item.file)
    : files
        .filter((file) => file.toLowerCase().endsWith('.exp3.json'))
        .map((file) => ({ file, name: path.basename(file).replace(/\.exp3\.json$/i, '') }))
        .filter((item) => SAFE_EXPRESSION_HINTS.some((hint) => item.name.includes(hint)))
  const expressions = []
  expressionEntries.forEach((item, index) => {
    const name = `expressions/e${index}.exp3.json`
    fs.copyFileSync(item.file, path.join(outDir, name))
    expressions.push({ Name: item.name, File: name })
  })
  if (expressions.length) out.FileReferences.Expressions = expressions

  fs.writeFileSync(path.join(outDir, 'model3.json'), JSON.stringify(out, null, 2))

  const manifest = { id, name: path.basename(source), textures: textures.length, importedAt: Date.now() }
  fs.writeFileSync(path.join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const targets = [
    path.join(repoRoot, 'apps', 'electron', 'resources', 'live2d'),
    path.join(repoRoot, 'apps', 'tauri', 'src-tauri', 'resources', 'live2d')
  ]
  for (const target of targets) {
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(target, { recursive: true })
    fs.cpSync(outRoot, target, { recursive: true })
  }

  const payload = {
    id,
    textures: textures.length,
    motions: motionFiles.length,
    expressions: expressions.length,
    resized,
    sizeMB: (walk(outDir).reduce((sum, file) => sum + fs.statSync(file).size, 0) / 1024 / 1024).toFixed(1),
    targets
  }
  fs.writeFileSync(path.join(outRoot, 'prepare-result.json'), JSON.stringify(payload, null, 2))
  console.log(JSON.stringify(payload))
  app.exit(0)
}

app.whenReady().then(() => {
  main().catch((error) => {
    console.error('FAIL', error.message)
    app.exit(1)
  })
})
