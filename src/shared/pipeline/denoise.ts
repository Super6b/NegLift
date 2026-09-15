/**
 * 降噪后处理（显示域）。
 *
 * 与 GPU 预览的实现共用同一套思路，保证两条路径观感一致：
 *
 * 1. **色彩噪点**：去马赛克后的彩色噪点表现为低频色斑，因此在 1/4 分辨率上
 *    建立 Y / Cb / Cr 平面，用亮度作为引导做边缘保持滤波，再上采样只替换色度，
 *    亮度通道原样保留 —— 这样能大幅去掉色斑而不损失任何亮度细节。
 * 2. **亮度噪点**：在全分辨率上对亮度做小半径（3×3）亮度引导滤波，
 *    只改亮度、保留原有色度，相当于轻度颗粒平滑。
 *
 * 引导权重采用紧支撑的二次核 w = max(W_MIN, 1 - (ΔY/σ)²)：跨过亮度边缘的
 * 邻居权重被压到下限，不会把边缘两侧的颜色混在一起（避免出现色晕）。
 */
import type { DenoiseParams } from '../types'
import { clamp } from './color'

/** 色度降噪的工作分辨率分母 */
const CHROMA_DIV = 8
/** 低分辨率上的滤波半径（2 → 5×5 窗口，等效全分辨率约 ±16px） */
const CHROMA_RADIUS = 2
/** 色度引导的亮度相似度阈值（显示域 0..1） */
const CHROMA_SIGMA = 0.075
/** 亮度引导的亮度相似度阈值 */
const LUMA_SIGMA = 0.05
/** 权重下限：保证平坦区始终有平均效果，同时把跨边缘混合限制在 10% 以内 */
const W_MIN = 0.1
/** 逐像素热循环里用乘法代替除法 */
const CHROMA_INV_SIGMA = 1 / CHROMA_SIGMA
const LUMA_INV_SIGMA = 1 / LUMA_SIGMA

/** Y / Cb / Cr 分解系数（与 Rec.709 亮度一致，Cb/Cr 为色差） */
const Y_R = 0.2126
const Y_G = 0.7152
const Y_B = 0.0722
/**
 * 由 Y / Cb / Cr 还原 G：
 *   G = (Y - Y_R·R - Y_B·B) / Y_G = Y - 0.29726·Cr - 0.10095·Cb
 */
const G_CB = -0.10095
const G_CR = -0.29726
const INV_65535 = 1 / 65535

export function isDenoiseActive(d: DenoiseParams | undefined | null): boolean {
  return !!d && d.enabled && (d.color > 0 || d.luminance > 0)
}

/** 引导滤波常数：GPU 预览着色器直接复用，保证两个后端参数一致 */
export const DENOISE_KERNEL = {
  chromaSigma: CHROMA_SIGMA,
  lumaSigma: LUMA_SIGMA,
  wMin: W_MIN
} as const

/** 把 0..10 等级换算为 0..1 的混合量 */
export function denoiseAmounts(d: DenoiseParams): { color: number; luminance: number } {
  return {
    color: clamp(d.color / 10, 0, 1),
    luminance: clamp(d.luminance / 10, 0, 1)
  }
}

function weight(delta: number, invSigma: number): number {
  const t = delta * invSigma
  const w = 1 - t * t
  return w > W_MIN ? w : W_MIN
}

function to16(v: number): number {
  if (v <= 0) return 0
  if (v >= 1) return 65535
  return (v * 65535 + 0.5) | 0
}

/** 亮度引导的色度降噪，原地修改 RGB（16bit 显示域） */
function chromaDenoise(rgb: Uint16Array, width: number, height: number, amount: number): void {
  const sw = Math.max(1, Math.ceil(width / CHROMA_DIV))
  const sh = Math.max(1, Math.ceil(height / CHROMA_DIV))
  const yLow = new Float32Array(sw * sh)
  const cbLow = new Float32Array(sw * sh)
  const crLow = new Float32Array(sw * sh)

  // 1) 盒式降采样到 1/4：Y/Cb/Cr 都是 RGB 的线性组合，先平均再分解与先分解再平均等价
  for (let by = 0; by < sh; by++) {
    const sy0 = by * CHROMA_DIV
    const sy1 = Math.min(height, sy0 + CHROMA_DIV)
    for (let bx = 0; bx < sw; bx++) {
      const sx0 = bx * CHROMA_DIV
      const sx1 = Math.min(width, sx0 + CHROMA_DIV)
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = sy0; y < sy1; y++) {
        let o = (y * width + sx0) * 3
        for (let x = sx0; x < sx1; x++, o += 3) {
          r += rgb[o]
          g += rgb[o + 1]
          b += rgb[o + 2]
          n++
        }
      }
      const scale = 1 / (n * 65535)
      r *= scale
      g *= scale
      b *= scale
      const yv = Y_R * r + Y_G * g + Y_B * b
      const i = by * sw + bx
      yLow[i] = yv
      cbLow[i] = b - yv
      crLow[i] = r - yv
    }
  }

  // 2) 亮度引导的 5×5 边缘保持滤波（仅色度）
  const cbFiltered = new Float32Array(sw * sh)
  const crFiltered = new Float32Array(sw * sh)
  for (let y = 0; y < sh; y++) {
    const yStart = Math.max(0, y - CHROMA_RADIUS)
    const yEnd = Math.min(sh - 1, y + CHROMA_RADIUS)
    for (let x = 0; x < sw; x++) {
      const xStart = Math.max(0, x - CHROMA_RADIUS)
      const xEnd = Math.min(sw - 1, x + CHROMA_RADIUS)
      const i = y * sw + x
      const yc = yLow[i]
      let wSum = 0
      let cbSum = 0
      let crSum = 0
      for (let yy = yStart; yy <= yEnd; yy++) {
        const row = yy * sw
        for (let xx = xStart; xx <= xEnd; xx++) {
          const j = row + xx
          const w = weight(Math.abs(yLow[j] - yc), CHROMA_INV_SIGMA)
          wSum += w
          cbSum += w * cbLow[j]
          crSum += w * crLow[j]
        }
      }
      const inv = 1 / wSum
      cbFiltered[i] = cbSum * inv
      crFiltered[i] = crSum * inv
    }
  }

  // 3) 全分辨率重建：亮度沿用原值（细节全保留），色度按强度在原值与滤波值之间混合
  const invDiv = 1 / CHROMA_DIV
  for (let y = 0; y < height; y++) {
    const fy = clamp((y + 0.5) * invDiv - 0.5, 0, sh - 1)
    const y0 = fy | 0
    const y1 = y0 + 1 < sh ? y0 + 1 : sh - 1
    const ty = fy - y0
    let o = y * width * 3
    for (let x = 0; x < width; x++, o += 3) {
      const fx = clamp((x + 0.5) * invDiv - 0.5, 0, sw - 1)
      const x0 = fx | 0
      const x1 = x0 + 1 < sw ? x0 + 1 : sw - 1
      const tx = fx - x0
      const w00 = (1 - tx) * (1 - ty)
      const w10 = tx * (1 - ty)
      const w01 = (1 - tx) * ty
      const w11 = tx * ty
      const i00 = y0 * sw + x0
      const i10 = y0 * sw + x1
      const i01 = y1 * sw + x0
      const i11 = y1 * sw + x1
      const cbF = cbFiltered[i00] * w00 + cbFiltered[i10] * w10 + cbFiltered[i01] * w01 + cbFiltered[i11] * w11
      const crF = crFiltered[i00] * w00 + crFiltered[i10] * w10 + crFiltered[i01] * w01 + crFiltered[i11] * w11

      const r = rgb[o] * INV_65535
      const g = rgb[o + 1] * INV_65535
      const b = rgb[o + 2] * INV_65535
      const yv = Y_R * r + Y_G * g + Y_B * b
      const cb0 = b - yv
      const cr0 = r - yv
      const cb = cb0 + (cbF - cb0) * amount
      const cr = cr0 + (crF - cr0) * amount

      rgb[o] = to16(yv + cr)
      rgb[o + 1] = to16(yv + G_CB * cb + G_CR * cr)
      rgb[o + 2] = to16(yv + cb)
    }
  }
}

/** 亮度引导的亮度降噪，原地修改 RGB（16bit 显示域） */
function lumaDenoise(rgb: Uint16Array, width: number, height: number, amount: number): void {
  const pixels = width * height
  const yPlane = new Uint16Array(pixels)
  for (let i = 0, o = 0; i < pixels; i++, o += 3) {
    yPlane[i] = (Y_R * rgb[o] + Y_G * rgb[o + 1] + Y_B * rgb[o + 2] + 0.5) | 0
  }

  for (let y = 0; y < height; y++) {
    const yStart = y > 0 ? y - 1 : 0
    const yEnd = y + 1 < height ? y + 1 : height - 1
    let o = y * width * 3
    for (let x = 0; x < width; x++, o += 3) {
      const xStart = x > 0 ? x - 1 : 0
      const xEnd = x + 1 < width ? x + 1 : width - 1
      const i = y * width + x
      const yc = yPlane[i] * INV_65535
      let wSum = 0
      let sum = 0
      for (let yy = yStart; yy <= yEnd; yy++) {
        const row = yy * width
        for (let xx = xStart; xx <= xEnd; xx++) {
          const j = row + xx
          const yj = yPlane[j] * INV_65535
          const w = weight(Math.abs(yj - yc), LUMA_INV_SIGMA)
          wSum += w
          sum += w * yj
        }
      }
      const yNew = sum / wSum
      const r = rgb[o] * INV_65535
      const b = rgb[o + 2] * INV_65535
      const cb = b - yc
      const cr = r - yc
      const yMix = yc + (yNew - yc) * amount
      rgb[o] = to16(yMix + cr)
      rgb[o + 1] = to16(yMix + G_CB * cb + G_CR * cr)
      rgb[o + 2] = to16(yMix + cb)
    }
  }
}

/**
 * 对显示域渲染结果做降噪（原地修改）。
 *
 * @param rgb    16bit 显示域 RGB 交错数据，0..65535
 * @param width  输出宽度
 * @param height 输出高度
 * @param params 降噪参数，`color` / `luminance` 为 0..10 等级
 */
export function denoiseDisplay(
  rgb: Uint16Array,
  width: number,
  height: number,
  params: DenoiseParams
): void {
  if (!isDenoiseActive(params) || width < 3 || height < 3) return
  const { color, luminance } = denoiseAmounts(params)
  if (color > 0) chromaDenoise(rgb, width, height, color)
  if (luminance > 0) lumaDenoise(rgb, width, height, luminance)
}
