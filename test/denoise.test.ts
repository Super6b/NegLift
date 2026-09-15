/**
 * 降噪测试用例（可直接运行：npm run test:denoise）
 *
 * 用合成图像量化验收指标，而不是只做“看起来对”的主观判断：
 *   1. 关闭降噪 / 强度为 0 时必须逐像素恒等（不引入任何副作用）
 *   2. 色彩噪点等级提升时，平坦区的色度噪声必须单调下降
 *   3. 色彩降噪不得改变亮度通道（细节完整保留）
 *   4. 亮度降噪必须保住强边缘，只平滑弱纹理
 *   5. 平均色彩偏移（色度漂移）必须在可接受范围内
 *   6. 单张 2400 万像素图像的降噪耗时必须 ≤ 500ms
 */
import type { DenoiseParams } from '../src/shared/types'
import { denoiseDisplay } from '../src/shared/pipeline/denoise'

const Y_R = 0.2126
const Y_G = 0.7152
const Y_B = 0.0722

interface Rgb {
  r: number
  g: number
  b: number
}

/** 由 Y / Cb / Cr 合成 RGB（与管线内部同一套定义） */
function fromYCbCr(y: number, cb: number, cr: number): Rgb {
  return { r: y + cr, g: y - 0.2973 * cr - 0.1009 * cb, b: y + cb }
}

function to16(v: number): number {
  if (v <= 0) return 0
  if (v >= 1) return 65535
  return (v * 65535 + 0.5) | 0
}

/** 确定性伪随机，保证测试可复现 */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

interface Synthetic {
  data: Uint16Array
  width: number
  height: number
  /** 平坦中性灰区域（用于度量色度噪声） */
  flat: { x: number; y: number; w: number; h: number }
  /** 强边缘区域（用于度量边缘保持） */
  edge: { x: number; y: number; w: number; h: number }
  /** 细密纹理区域（用于度量细节保持） */
  detail: { x: number; y: number; w: number; h: number }
}

/**
 * 合成一张带彩色噪点的测试图：
 * - 左侧：平坦中性灰（真实色度应为 0）
 * - 右上：黑白强边缘
 * - 右下：高频细条纹（亮度细节）
 * 彩色噪点用低频扰动加在 Cb/Cr 上，模拟去马赛克后的色斑。
 */
function makeSynthetic(width: number, height: number, chromaNoise: number, lumaNoise: number): Synthetic {
  const data = new Uint16Array(width * height * 3)
  const rand = makeRandom(20240912)
  const flat = { x: 0, y: 0, w: Math.floor(width * 0.4), h: height }
  const edge = { x: flat.w, y: 0, w: width - flat.w, h: Math.floor(height * 0.5) }
  const detail = { x: flat.w, y: edge.h, w: width - flat.w, h: height - edge.h }

  // 低频噪声场：色斑是低频的，用双线性插值的粗网格模拟
  const gw = Math.ceil(width / 16) + 1
  const gh = Math.ceil(height / 16) + 1
  const cbGrid = new Float32Array(gw * gh)
  const crGrid = new Float32Array(gw * gh)
  const cbGrid2 = new Float32Array(gw * gh)
  const crGrid2 = new Float32Array(gw * gh)
  for (let i = 0; i < gw * gh; i++) {
    cbGrid[i] = (rand() - 0.5) * 2 * chromaNoise
    crGrid[i] = (rand() - 0.5) * 2 * chromaNoise
    cbGrid2[i] = (rand() - 0.5) * 2 * chromaNoise
    crGrid2[i] = (rand() - 0.5) * 2 * chromaNoise
  }
  const sampleGrid = (grid: Float32Array, x: number, y: number): number => {
    const gx = Math.min(gw - 1, x / 16)
    const gy = Math.min(gh - 1, y / 16)
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const x1 = Math.min(gw - 1, x0 + 1)
    const y1 = Math.min(gh - 1, y0 + 1)
    const tx = gx - x0
    const ty = gy - y0
    const v00 = grid[y0 * gw + x0]
    const v10 = grid[y0 * gw + x1]
    const v01 = grid[y1 * gw + x0]
    const v11 = grid[y1 * gw + x1]
    return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let luma: number
      if (x < flat.w) {
        luma = 0.5
      } else if (y < edge.h) {
        luma = x < flat.w + edge.w * 0.5 ? 0.12 : 0.86 // 强边缘
      } else {
        luma = (x + y) % 2 === 0 ? 0.42 : 0.58 // 高频细节
      }
      luma += (rand() - 0.5) * 2 * lumaNoise
      // 低频色度噪声：用两个尺度的叠加，更接近真实色斑
      const cb = sampleGrid(cbGrid, x, y) * 0.7 + sampleGrid(cbGrid2, x, y) * 0.3
      const cr = sampleGrid(crGrid, x, y) * 0.7 + sampleGrid(crGrid2, x, y) * 0.3
      const rgb = fromYCbCr(luma, cb, cr)
      const o = (y * width + x) * 3
      data[o] = to16(rgb.r)
      data[o + 1] = to16(rgb.g)
      data[o + 2] = to16(rgb.b)
    }
  }
  return { data, width, height, flat, edge, detail }
}

function lumaAt(data: Uint16Array, width: number, x: number, y: number): number {
  const o = (y * width + x) * 3
  return (Y_R * data[o] + Y_G * data[o + 1] + Y_B * data[o + 2]) / 65535
}

function chromaAt(data: Uint16Array, width: number, x: number, y: number): [number, number] {
  const o = (y * width + x) * 3
  const r = data[o] / 65535
  const g = data[o + 1] / 65535
  const b = data[o + 2] / 65535
  const yv = Y_R * r + Y_G * g + Y_B * b
  return [b - yv, r - yv]
}

/** 区域内色度噪声强度：Cb/Cr 的标准差 */
function chromaNoiseLevel(s: Synthetic, region: { x: number; y: number; w: number; h: number }): number {
  let scb = 0
  let scr = 0
  let sccb = 0
  let sccr = 0
  let n = 0
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      const [cb, cr] = chromaAt(s.data, s.width, x, y)
      scb += cb
      scr += cr
      sccb += cb * cb
      sccr += cr * cr
      n++
    }
  }
  const mcb = scb / n
  const mcr = scr / n
  return Math.sqrt(Math.max(0, sccb / n - mcb * mcb)) + Math.sqrt(Math.max(0, sccr / n - mcr * mcr))
}

/** 区域内平均色度（用于度量色彩漂移） */
function meanChroma(s: Synthetic, region: { x: number; y: number; w: number; h: number }): [number, number] {
  let scb = 0
  let scr = 0
  let n = 0
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      const [cb, cr] = chromaAt(s.data, s.width, x, y)
      scb += cb
      scr += cr
      n++
    }
  }
  return [scb / n, scr / n]
}

/** 区域平均亮度梯度能量（主要反映噪声与纹理强度） */
function meanGradient(s: Synthetic, region: { x: number; y: number; w: number; h: number }): number {
  let sum = 0
  let n = 0
  for (let y = region.y; y < region.y + region.h - 1; y++) {
    for (let x = region.x; x < region.x + region.w - 1; x++) {
      const c = lumaAt(s.data, s.width, x, y)
      const dx = lumaAt(s.data, s.width, x + 1, y) - c
      const dy = lumaAt(s.data, s.width, x, y + 1) - c
      sum += Math.abs(dx) + Math.abs(dy)
      n++
    }
  }
  return sum / n
}

/** 区域最大亮度梯度：用于衡量强边缘是否被抹平（陡度） */
function maxGradient(s: Synthetic, region: { x: number; y: number; w: number; h: number }): number {
  let max = 0
  for (let y = region.y; y < region.y + region.h - 1; y++) {
    for (let x = region.x; x < region.x + region.w - 1; x++) {
      const d = Math.abs(lumaAt(s.data, s.width, x + 1, y) - lumaAt(s.data, s.width, x, y))
      if (d > max) max = d
    }
  }
  return max
}

/** 亮度通道与参考的最大逐像素偏差（16bit 级） */
function maxLumaDiff(a: Uint16Array, b: Uint16Array, width: number, height: number): number {
  let max = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(lumaAt(a, width, x, y) - lumaAt(b, width, x, y)) * 65535
      if (d > max) max = d
    }
  }
  return max
}

interface CaseResult {
  name: string
  ok: boolean
  detail: string
}

const results: CaseResult[] = []
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
}

function params(color: number, luminance: number): DenoiseParams {
  return { enabled: true, color, luminance }
}

function run(): void {
  const W = 768
  const H = 512
  const base = makeSynthetic(W, H, 0.05, 0.02)

  // ---- 用例 1：关闭降噪必须是恒等变换 ----
  {
    const data = base.data.slice()
    denoiseDisplay(data, W, H, { enabled: false, color: 10, luminance: 10 })
    const identicalOff = data.every((v, i) => v === base.data[i])

    const data2 = base.data.slice()
    denoiseDisplay(data2, W, H, params(0, 0))
    const identicalZero = data2.every((v, i) => v === base.data[i])
    check(
      '关闭 / 等级 0 时为恒等变换',
      identicalOff && identicalZero,
      `关闭=${identicalOff ? '一致' : '被修改'}，等级0=${identicalZero ? '一致' : '被修改'}`
    )
  }

  // ---- 用例 2：色度噪声随等级单调下降 ----
  const noiseLevels: number[] = []
  for (const level of [0, 2, 4, 6, 8, 10]) {
    const data = base.data.slice()
    denoiseDisplay(data, W, H, params(level, 0))
    const s: Synthetic = { ...base, data }
    noiseLevels.push(chromaNoiseLevel(s, base.flat))
  }
  const mono = noiseLevels.every((v, i) => i === 0 || v <= noiseLevels[i - 1] + 1e-6)
  const reduction = 1 - noiseLevels[noiseLevels.length - 1] / noiseLevels[0]
  check(
    '色彩噪点随等级单调下降',
    mono && reduction > 0.5,
    `色度噪声 ${noiseLevels.map((v) => v.toFixed(4)).join(' → ')}（等级10 下降 ${(reduction * 100).toFixed(1)}%）`
  )

  // ---- 用例 3：色彩降噪不改变亮度通道（细节完整保留） ----
  {
    const data = base.data.slice()
    denoiseDisplay(data, W, H, params(10, 0))
    const diff = maxLumaDiff(base.data, data, W, H)
    const gradBefore = meanGradient(base, base.detail)
    const s: Synthetic = { ...base, data }
    const gradAfter = meanGradient(s, base.detail)
    check(
      '色彩降噪不改变亮度通道',
      diff <= 1.5,
      `亮度最大偏差 ${diff.toFixed(2)}/65535，细节梯度 ${gradBefore.toFixed(5)} → ${gradAfter.toFixed(5)}`
    )
  }

  // ---- 用例 4：亮度降噪必须保住强边缘、同时压低颗粒 ----
  {
    const data = base.data.slice()
    denoiseDisplay(data, W, H, params(0, 8))
    const s: Synthetic = { ...base, data }
    const edgePeakBefore = maxGradient(base, base.edge)
    const edgePeakAfter = maxGradient(s, base.edge)
    const noiseBefore = meanGradient(base, base.flat)
    const noiseAfter = meanGradient(s, base.flat)
    const edgeKeep = edgePeakAfter / edgePeakBefore
    const noiseKeep = noiseAfter / noiseBefore
    check(
      '亮度降噪保住强边缘、压低颗粒',
      edgeKeep > 0.6 && noiseKeep < 0.8,
      `边缘陡度保留 ${(edgeKeep * 100).toFixed(1)}%，平坦区颗粒降至 ${(noiseKeep * 100).toFixed(1)}%`
    )
  }

  // ---- 用例 5：色彩漂移在可接受范围内 ----
  {
    const before = meanChroma(base, base.flat)
    const data = base.data.slice()
    denoiseDisplay(data, W, H, params(10, 0))
    const s: Synthetic = { ...base, data }
    const after = meanChroma(s, base.flat)
    const dcb = Math.abs(after[0] - before[0])
    const dcr = Math.abs(after[1] - before[1])
    const dcb2 = Math.abs(meanChroma(s, base.edge)[0] - meanChroma(base, base.edge)[0])
    const dcr2 = Math.abs(meanChroma(s, base.edge)[1] - meanChroma(base, base.edge)[1])
    // 阈值 0.002（约 0.5/255），远小于可见色差
    check(
      '平均色彩漂移 < 0.002',
      dcb < 0.002 && dcr < 0.002 && dcb2 < 0.002 && dcr2 < 0.002,
      `平坦区 ΔCb=${dcb.toFixed(5)} ΔCr=${dcr.toFixed(5)}；边缘区 ΔCb=${dcb2.toFixed(5)} ΔCr=${dcr2.toFixed(5)}`
    )
  }

  // ---- 用例 6：2400 万像素单张耗时 ≤ 500ms ----
  {
    const bigW = 6000
    const bigH = 4000
    const big = new Uint16Array(bigW * bigH * 3)
    for (let i = 0; i < big.length; i++) big[i] = ((i * 2654435761) % 65536) | 0
    const t0 = performance.now()
    denoiseDisplay(big, bigW, bigH, params(6, 0))
    const msColor = performance.now() - t0
    const t1 = performance.now()
    denoiseDisplay(big, bigW, bigH, params(0, 6))
    const msLuma = performance.now() - t1
    check(
      '2400 万像素单张降噪 ≤ 500ms',
      msColor <= 500,
      `色彩降噪 ${msColor.toFixed(0)}ms，亮度降噪 ${msLuma.toFixed(0)}ms（含两者时约 ${(msColor + msLuma).toFixed(0)}ms）`
    )
  }

  // ---- 输出报告 ----
  let failed = 0
  console.log('\n降噪测试报告')
  console.log('─'.repeat(76))
  for (const r of results) {
    if (!r.ok) failed++
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}`)
    console.log(`   ${r.detail}`)
  }
  console.log('─'.repeat(76))
  console.log(`${results.length - failed}/${results.length} 通过`)
  if (failed > 0) process.exitCode = 1
}

run()
