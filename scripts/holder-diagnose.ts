/**
 * 片夹识别诊断：解码 raw pic 样片 → 跑 detectHolderRect → 输出可视化 PNG。
 * 运行：
 *   npx esbuild scripts/holder-diagnose.ts --bundle --platform=node --format=cjs --target=node20 --alias:@shared=./src/shared --outfile=out/holder-diagnose.cjs && node out/holder-diagnose.cjs
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { detectHolderRect } from '../src/shared/pipeline/analysis'
import { decimateLinear } from '../src/shared/pipeline'

const ROOT = path.resolve(__dirname, '..')
const RAW_DIR = path.join(ROOT, 'raw pic')
const OUT_DIR = path.join(ROOT, 'out', 'holder-debug')
const ANALYSIS_MAX_EDGE = 1600

async function decodeRaw(filePath: string): Promise<{ linear: Uint16Array; width: number; height: number }> {
  const { LibRaw } = await import('lightdrift-libraw')
  const raw = new LibRaw()
  try {
    await raw.loadFile(filePath)
    await raw.setOutputParams({
      output_bps: 16,
      gamma: [1, 1, 0, 0, 0, 0],
      no_auto_bright: true,
      output_color: 1,
      use_camera_wb: true,
      use_camera_matrix: 1,
      user_qual: 3,
      highlight: 0,
      output_tiff: false
    })
    await raw.processImage()
    const img = await raw.dcrawMakeMemImage()
    const pixels = img.width * img.height
    const out = new Uint16Array(pixels * 3)
    if (img.bits === 16) {
      const src = new Uint16Array(img.data.buffer, img.data.byteOffset, Math.floor(img.data.length / 2))
      if (img.colors === 3) {
        out.set(src.subarray(0, Math.min(src.length, out.length)))
      } else {
        for (let i = 0, s = 0, d = 0; i < pixels; i++, s += img.colors, d += 3) {
          out[d] = src[s]
          out[d + 1] = src[s + 1]
          out[d + 2] = src[s + 2]
        }
      }
    } else {
      for (let i = 0; i < out.length; i++) out[i] = img.data[i] * 257
    }
    return { linear: out, width: img.width, height: img.height }
  } finally {
    try {
      await raw.close()
    } catch {
      /* ignore */
    }
  }
}

/** 线性数据 → 可视化用的 sRGB JPEG（简单 gamma，便于肉眼看片夹） */
async function savePreview(
  linear: Uint16Array,
  width: number,
  height: number,
  outPath: string,
  rect: { x: number; y: number; w: number; h: number } | null
): Promise<void> {
  const n = width * height
  const rgb8 = Buffer.allocUnsafe(n * 3)
  for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 3) {
    for (let c = 0; c < 3; c++) {
      const lin = linear[s + c] / 65535
      // 显示用：sqrt 近似 gamma + 稍提亮，方便看清暗部片夹
      const v = Math.pow(Math.min(1, Math.max(0, lin)), 1 / 2.2)
      rgb8[d + c] = Math.round(v * 255)
    }
  }

  const base = sharp(rgb8, { raw: { width, height, channels: 3 } })
  const overlay = rect
    ? await drawRectJpeg(width, height, rect, outPath.replace(/\.jpg$/, '.box.json'))
    : null

  if (!overlay) {
    await base.jpeg({ quality: 90 }).toFile(outPath)
    return
  }
  await base.composite([{ input: overlay, top: 0, left: 0 }]).jpeg({ quality: 90 }).toFile(outPath)
  await fs.writeFile(outPath.replace(/\.jpg$/, '.box.json'), JSON.stringify(rect, null, 2))
}

/** 画检测框（SVG overlay） */
async function drawRectJpeg(
  width: number,
  height: number,
  rect: { x: number; y: number; w: number; h: number },
  _unused: string
): Promise<Buffer> {
  const x = Math.round(rect.x * width)
  const y = Math.round(rect.y * height)
  const w = Math.round(rect.w * width)
  const h = Math.round(rect.h * height)
  const sw = Math.max(2, Math.round(Math.min(width, height) / 400))
  const labelY = Math.max(sw * 2, y + Math.round(h * 0.02) + 18)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="none" stroke="#ff3355" stroke-width="${sw * 2}" opacity="0.35"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#00ff88" stroke-width="${sw}"/>
  <text x="${x + sw * 2}" y="${labelY}" fill="#00ff88" font-size="${Math.round(Math.min(width, height) / 40)}" font-family="monospace">validArea</text>
</svg>`
  return Buffer.from(svg)
}

/** 行/列亮度剖面，辅助判断片夹边界 */
function profileEdges(
  lin: Uint16Array,
  width: number,
  height: number
): { top: number[]; bottom: number[]; left: number[]; right: number[] } {
  const lumaAt = (x: number, y: number): number => {
    const o = (y * width + x) * 3
    return (0.2126 * lin[o] + 0.7152 * lin[o + 1] + 0.0722 * lin[o + 2]) / 65535
  }
  const sampleLines = Math.min(80, Math.floor(Math.min(width, height) * 0.05))
  const top: number[] = []
  const bottom: number[] = []
  for (let i = 0; i < sampleLines; i++) {
    const x = Math.floor(((i + 0.5) / sampleLines) * width)
    let t = 0
    let b = 0
    let tn = 0
    let bn = 0
    // 只看最外 12% 条带，统计该条带平均亮度
    const band = Math.max(2, Math.round(height * 0.02))
    for (let y = 0; y < band; y++) {
      t += lumaAt(x, y)
      tn++
    }
    for (let y = height - band; y < height; y++) {
      b += lumaAt(x, y)
      bn++
    }
    top.push(t / Math.max(1, tn))
    bottom.push(b / Math.max(1, bn))
  }
  const left: number[] = []
  const right: number[] = []
  for (let i = 0; i < sampleLines; i++) {
    const y = Math.floor(((i + 0.5) / sampleLines) * height)
    let l = 0
    let r = 0
    let ln = 0
    let rn = 0
    const band = Math.max(2, Math.round(width * 0.02))
    for (let x = 0; x < band; x++) {
      l += lumaAt(x, y)
      ln++
    }
    for (let x = width - band; x < width; x++) {
      r += lumaAt(x, y)
      rn++
    }
    left.push(l / Math.max(1, ln))
    right.push(r / Math.max(1, rn))
  }
  return { top, bottom, left, right }
}

function median(arr: number[]): number {
  const a = [...arr].sort((x, y) => x - y)
  return a.length === 0 ? 0 : a[a.length >> 1]
}

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true })
  const files = (await fs.readdir(RAW_DIR)).filter((f) => f.toLowerCase().endsWith('.arw')).sort()
  const report: unknown[] = []

  for (const name of files) {
    const filePath = path.join(RAW_DIR, name)
    process.stdout.write(`\n=== ${name} ===\n`)
    const t0 = Date.now()
    const dec = await decodeRaw(filePath)
    const tDecode = Date.now() - t0
    process.stdout.write(`decode ${dec.width}×${dec.height} in ${tDecode}ms\n`)

    const analysis = decimateLinear(dec.linear, dec.width, dec.height, ANALYSIS_MAX_EDGE)
    const t1 = Date.now()
    const rect = detectHolderRect(analysis.data, analysis.width, analysis.height)
    const tDetect = Date.now() - t1

    const inset = rect
      ? {
          top: +(rect.y * 100).toFixed(2),
          right: +((1 - rect.x - rect.w) * 100).toFixed(2),
          bottom: +((1 - rect.y - rect.h) * 100).toFixed(2),
          left: +(rect.x * 100).toFixed(2)
        }
      : null
    process.stdout.write(`detect ${tDetect}ms → ${JSON.stringify(rect)}\n`)
    if (inset) {
      process.stdout.write(
        `insets% top=${inset.top} right=${inset.right} bottom=${inset.bottom} left=${inset.left}\n`
      )
    }

    // 边缘亮度剖面（中位数）
    const prof = profileEdges(analysis.data, analysis.width, analysis.height)
    const edgeMed = {
      top: +median(prof.top).toFixed(5),
      bottom: +median(prof.bottom).toFixed(5),
      left: +median(prof.left).toFixed(5),
      right: +median(prof.right).toFixed(5)
    }
    process.stdout.write(`edge band median luma: ${JSON.stringify(edgeMed)}\n`)

    // 可视化：抽到长边 960 更快
    const vis = decimateLinear(dec.linear, dec.width, dec.height, 960)
    const stem = name.replace(/\.arw$/i, '')
    await savePreview(vis.data, vis.width, vis.height, path.join(OUT_DIR, `${stem}.jpg`), rect)

    // 也导出未标注的原貌，方便对比
    await savePreview(vis.data, vis.width, vis.height, path.join(OUT_DIR, `${stem}-plain.jpg`), null)

    report.push({ name, width: dec.width, height: dec.height, rect, inset, edgeMed, tDecode, tDetect })
  }

  await fs.writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))
  process.stdout.write(`\n报告与图片已写入 ${OUT_DIR}\n`)
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
