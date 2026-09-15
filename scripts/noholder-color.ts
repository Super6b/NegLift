/**
 * 无片夹 TIFF：解码 → 检测 → 去色罩/校色 → 输出对比图与指标。
 * npx esbuild scripts/noholder-color.ts --bundle --platform=node --format=cjs --target=node20 --alias:@shared=./src/shared --external:sharp --external:lightdrift-libraw --outfile=out/noholder-color.cjs && node out/noholder-color.cjs
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { EditParams } from '../src/shared/types'
import { createDefaultParams, cloneParams } from '../src/shared/defaults'
import { detectHolderRect, detectNegative } from '../src/shared/pipeline/analysis'
import { renderLinear, decimateLinear } from '../src/shared/pipeline'
import { buildToneContext, channelTransfer } from '../src/shared/pipeline/tone'

const ROOT = path.resolve(__dirname, '..')
const DIR = path.join(ROOT, 'raw pic', 'raw pic无片夹')
const OUT = path.join(ROOT, 'out', 'noholder')
const MAX_EDGE = 2400

async function decodeTiff(filePath: string): Promise<{ linear: Uint16Array; width: number; height: number; bits: number }> {
  const pipeline = sharp(filePath, { limitInputPixels: false, unlimited: true, failOn: 'none' })
  const meta = await pipeline.metadata()
  const source16 = meta.depth === 'ushort'
  const { data, info } = await (source16
    ? pipeline.toColourspace('rgb16').raw({ depth: 'ushort' })
    : pipeline.raw()
  ).toBuffer({ resolveWithObject: true })

  const pixels = info.width * info.height
  const channels = info.channels
  const out = new Uint16Array(pixels * 3)
  if (source16 && data.length >= pixels * channels * 2) {
    const src = new Uint16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2))
    if (channels === 3) {
      out.set(src.subarray(0, Math.min(src.length, out.length)))
    } else {
      for (let i = 0, s = 0, d = 0; i < pixels; i++, s += channels, d += 3) {
        out[d] = src[s]
        out[d + 1] = src[s + 1]
        out[d + 2] = src[s + 2]
      }
    }
  } else {
    for (let i = 0, s = 0, d = 0; i < pixels; i++, s += channels, d += 3) {
      out[d] = data[s] * 257
      out[d + 1] = data[s + 1] * 257
      out[d + 2] = data[s + 2] * 257
    }
  }
  return { linear: out, width: info.width, height: info.height, bits: source16 ? 16 : 8 }
}

/** 线性数据 → 显示用 JPEG（gamma 2.2 近似） */
async function saveLinearJpeg(
  linear: Uint16Array,
  width: number,
  height: number,
  outPath: string
): Promise<void> {
  const n = width * height
  const rgb8 = Buffer.allocUnsafe(n * 3)
  for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 3) {
    for (let c = 0; c < 3; c++) {
      const v = Math.pow(Math.min(1, Math.max(0, linear[s + c] / 65535)), 1 / 2.2)
      rgb8[d + c] = Math.round(v * 255)
    }
  }
  await sharp(rgb8, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toFile(outPath)
}

async function saveDisplayJpeg(
  display: Uint16Array,
  width: number,
  height: number,
  outPath: string
): Promise<void> {
  const n = width * height
  const rgb8 = Buffer.allocUnsafe(n * 3)
  for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 3) {
    rgb8[d] = display[s] >> 8
    rgb8[d + 1] = display[s + 1] >> 8
    rgb8[d + 2] = display[s + 2] >> 8
  }
  await sharp(rgb8, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toFile(outPath)
}

/** 通道均值/中位，评估偏色 */
function channelStats(lin: Uint16Array, width: number, height: number): {
  mean: [number, number, number]
  median: [number, number, number]
  p99: [number, number, number]
  p2: [number, number, number]
} {
  const n = width * height
  const r: number[] = new Array(n)
  const g: number[] = new Array(n)
  const b: number[] = new Array(n)
  let sr = 0
  let sg = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    const rr = lin[i * 3] / 65535
    const gg = lin[i * 3 + 1] / 65535
    const bb = lin[i * 3 + 2] / 65535
    r[i] = rr
    g[i] = gg
    b[i] = bb
    sr += rr
    sg += gg
    sb += bb
  }
  const pct = (arr: number[], p: number): number => {
    const a = [...arr].sort((x, y) => x - y)
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)))]
  }
  return {
    mean: [sr / n, sg / n, sb / n],
    median: [pct(r, 0.5), pct(g, 0.5), pct(b, 0.5)],
    p99: [pct(r, 0.99), pct(g, 0.99), pct(b, 0.99)],
    p2: [pct(r, 0.02), pct(g, 0.02), pct(b, 0.02)]
  }
}

/** 渲染后显示域的中性度：理想正片 R≈G≈B */
function displayNeutrality(display: Uint16Array, sampleStep = 3): number[] {
  let sumDr = 0
  let sumDb = 0
  let count = 0
  const n = display.length / 3
  for (let i = 0; i < n; i += sampleStep) {
    const r = display[i * 3]
    const g = display[i * 3 + 1]
    const b = display[i * 3 + 2]
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if (y < 500 || y > 60000) continue
    sumDr += (r - y) / 65535
    sumDb += (b - y) / 65535
    count++
  }
  return count === 0 ? [0, 0] : [sumDr / count, sumDb / count, count]
}

function applyParams(detected: ReturnType<typeof detectNegative>, mode: 'base' | 'align' | 'both'): EditParams {
  const p = createDefaultParams()
  p.negative.enabled = true
  p.negative.mode = mode === 'align' ? 'align' : 'base'
  p.negative.base = [...detected.base]
  p.negative.tRef = detected.tRef
  p.negative.strength = detected.suggestedStrength
  p.negative.alignBlack = [...detected.alignBlack]
  p.negative.alignWhite = [...detected.alignWhite]
  if (mode === 'align') {
    // align 模式也启用便于对比
    p.negative.enabled = true
    p.negative.mode = 'align'
  }
  return p
}

async function processOne(name: string): Promise<unknown> {
  process.stdout.write(`\n======== ${name} ========\n`)
  const filePath = path.join(DIR, name)
  const t0 = Date.now()
  const dec = await decodeTiff(filePath)
  process.stdout.write(`decode ${dec.width}×${dec.height} ${dec.bits}bit in ${Date.now() - t0}ms\n`)

  const an = decimateLinear(dec.linear, dec.width, dec.height, MAX_EDGE)
  const holder = detectHolderRect(an.data, an.width, an.height)
  process.stdout.write(`holder detect: ${holder ? JSON.stringify(holder) : 'null（无片夹，符合预期）'}\n`)

  const detected = detectNegative(an.data, an.width, an.height, null, null, null)
  process.stdout.write(
    `detect mode=${detected.mode} base=[${detected.base.map((v) => v.toFixed(3)).join(', ')}] tRef=${detected.tRef.toFixed(4)}\n`
  )
  process.stdout.write(
    `  alignB=[${detected.alignBlack.map((v) => v.toFixed(3)).join(', ')}] alignW=[${detected.alignWhite.map((v) => v.toFixed(3)).join(', ')}]\n`
  )

  const rawStats = channelStats(an.data, an.width, an.height)
  process.stdout.write(
    `linear mean R/G/B=${rawStats.mean.map((v) => v.toFixed(4)).join('/')} median=${rawStats.median.map((v) => v.toFixed(4)).join('/')}\n`
  )
  process.stdout.write(
    `  R/G=${(rawStats.mean[0] / Math.max(1e-6, rawStats.mean[1])).toFixed(3)} B/G=${(rawStats.mean[2] / Math.max(1e-6, rawStats.mean[1])).toFixed(3)}\n`
  )

  const stem = name.replace(/\.tif$/i, '')
  // 原貌（线性 gamma 预览）
  const visIn = decimateLinear(dec.linear, dec.width, dec.height, 1200)
  await saveLinearJpeg(visIn.data, visIn.width, visIn.height, path.join(OUT, `${stem}-linear.jpg`))

  // base 模式
  const pBase = applyParams(detected, 'base')
  const rBase = renderLinear(visIn.data, visIn.width, visIn.height, pBase, { scale: 1, histogram: true })
  await saveDisplayJpeg(rBase.data, rBase.width, rBase.height, path.join(OUT, `${stem}-base.jpg`))
  const nBase = displayNeutrality(rBase.data)

  // align 模式
  const pAlign = applyParams(detected, 'align')
  const rAlign = renderLinear(visIn.data, visIn.width, visIn.height, pAlign, { scale: 1, histogram: true })
  await saveDisplayJpeg(rAlign.data, rAlign.width, rAlign.height, path.join(OUT, `${stem}-align.jpg`))
  const nAlign = displayNeutrality(rAlign.data)

  // base + 手动 WB（用线性通道均值拉平）对照
  const pWb = cloneParams(pBase)
  const m = rawStats.mean
  // 在去色罩之前线性域已含色罩；用检测后的 base 归一化通道均值估计 WB
  // 简单：曝光后用 mean 对齐到绿
  const wb = [m[1] / Math.max(1e-6, m[0]), 1, m[1] / Math.max(1e-6, m[2])]
  // 把 WB 折进 temperature 近似：直接改 balance 乘子更稳
  pWb.negative.balance = [wb[0], wb[1], wb[2]]
  // k = balance/strength，会改变密度反相强度；改用 temperature/tint 近似更好
  // 回退：仅展示 base，不做危险的 balance 改动
  void pWb

  // 单通道 transfer 采样：黑/白/灰在 base 与 align 下的输出
  const ctxB = buildToneContext(pBase)
  const ctxA = buildToneContext(pAlign)
  const samples = [0.05, 0.15, 0.35, 0.55, 0.75, 0.9]
  const sampleOut: unknown[] = samples.map((t) => ({
    t,
    base: [0, 1, 2].map((c) => channelTransfer(t, c as 0 | 1 | 2, ctxB).toFixed(3)),
    align: [0, 1, 2].map((c) => channelTransfer(t, c as 0 | 1 | 2, ctxA).toFixed(3))
  }))
  process.stdout.write(`sample transfer:\n`)
  for (const s of sampleOut) {
    const x = s as { t: number; base: string[]; align: string[] }
    process.stdout.write(`  t=${x.t} base=${x.base.join(',')} align=${x.align.join(',')}\n`)
  }

  // 直方图峰值位置（显示域）
  const histPeak = (h: number[] | undefined): number => {
    if (!h) return -1
    let bi = 0
    let bv = -1
    for (let i = 0; i < h.length; i++) {
      if (h[i] > bv) {
        bv = h[i]
        bi = i
      }
    }
    return bi
  }
  process.stdout.write(
    `display neutrality base dR/dB=${nBase[0].toFixed(4)}/${nBase[1].toFixed(4)}  align dR/dB=${nAlign[0].toFixed(4)}/${nAlign[1].toFixed(4)}\n`
  )
  process.stdout.write(
    `hist peak L base=${histPeak(rBase.histogram?.l)} align=${histPeak(rAlign.histogram?.l)}\n`
  )

  return {
    name,
    width: dec.width,
    height: dec.height,
    holder,
    detected: {
      mode: detected.mode,
      base: detected.base,
      tRef: detected.tRef,
      alignBlack: detected.alignBlack,
      alignWhite: detected.alignWhite
    },
    rawMean: rawStats.mean,
    rawRG: rawStats.mean[0] / Math.max(1e-6, rawStats.mean[1]),
    rawBG: rawStats.mean[2] / Math.max(1e-6, rawStats.mean[1]),
    neutrality: { base: nBase, align: nAlign },
    histPeakL: { base: histPeak(rBase.histogram?.l), align: histPeak(rAlign.histogram?.l) }
  }
}

async function main(): Promise<void> {
  await fs.mkdir(OUT, { recursive: true })
  const files = (await fs.readdir(DIR)).filter((f) => /\.tif$/i.test(f)).sort()
  const report: unknown[] = []
  for (const f of files) {
    report.push(await processOne(f))
  }
  await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  process.stdout.write(`\n输出目录 ${OUT}\n`)
}

void main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
