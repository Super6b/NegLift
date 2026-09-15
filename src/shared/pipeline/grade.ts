/**
 * 高级调色：HSL 色彩分离 与 色彩分级/色彩平衡。
 *
 * 这两步都作用在**显示域**（sRGB 编码后的 0..1），因为它们需要感知色相与明度，
 * 在线性光域做色相判断与人眼观感不一致。代价是必须逐像素计算，无法烘焙为 LUT，
 * 因此当参数全为 0 时会被整段跳过（快速路径）。
 */

import type { ColorGradingParams, HslBands } from '../types'
import { HSL_BANDS, HSL_BAND_HUE } from '../defaults'
import { clamp, luminance } from './color'

const BAND_COUNT = HSL_BANDS.length
const BAND_CENTERS = HSL_BANDS.map((n) => HSL_BAND_HUE[n])
/** 每个分区的三角权重半宽（度），相邻分区相互重叠后再归一化 */
const BAND_HALF_WIDTH = 60

export interface HslContext {
  active: boolean
  /** 每个分区的 (hueShift 度, satFactor, lumFactor) */
  hue: Float32Array
  sat: Float32Array
  lum: Float32Array
}

export function buildHslContext(bands: HslBands): HslContext {
  const hue = new Float32Array(BAND_COUNT)
  const sat = new Float32Array(BAND_COUNT)
  const lum = new Float32Array(BAND_COUNT)
  let active = false
  HSL_BANDS.forEach((name, i) => {
    const b = bands[name]
    if (!b) return
    // ±100 -> ±36 度，避免色调分离出现明显断层
    hue[i] = (b.hue / 100) * 36
    sat[i] = b.saturation / 100
    lum[i] = b.luminance / 100
    if (b.hue !== 0 || b.saturation !== 0 || b.luminance !== 0) active = true
  })
  return { active, hue, sat, lum }
}

/** 角度差（0..180） */
function angleDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % 360
  if (d > 180) d = 360 - d
  return d
}

function rgbToHsl(r: number, g: number, b: number, out: Float32Array): void {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b
  const min = r < g ? (r < b ? r : b) : g < b ? g : b
  const l = (max + min) / 2
  const d = max - min
  if (d < 1e-6) {
    out[0] = 0
    out[1] = 0
    out[2] = l
    return
  }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  out[0] = h
  out[1] = s
  out[2] = l
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t
  if (tt < 0) tt += 1
  if (tt > 1) tt -= 1
  if (tt < 1 / 6) return p + (q - p) * 6 * tt
  if (tt < 1 / 2) return q
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
  return p
}

function hslToRgb(h: number, s: number, l: number, out: Float32Array): void {
  if (s < 1e-6) {
    out[0] = l
    out[1] = l
    out[2] = l
    return
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hn = (((h % 360) + 360) % 360) / 360
  out[0] = hueToRgb(p, q, hn + 1 / 3)
  out[1] = hueToRgb(p, q, hn)
  out[2] = hueToRgb(p, q, hn - 1 / 3)
}

const HSL_SCRATCH = new Float32Array(3)
const RGB_SCRATCH = new Float32Array(3)
const WEIGHTS = new Float32Array(BAND_COUNT)

/** 在显示域对单个像素施加 HSL 色彩分离 */
export function applyHsl(r: number, g: number, b: number, ctx: HslContext, out: Float32Array): void {
  rgbToHsl(r, g, b, HSL_SCRATCH)
  const h = HSL_SCRATCH[0]
  let s = HSL_SCRATCH[1]
  let l = HSL_SCRATCH[2]

  let total = 0
  for (let i = 0; i < BAND_COUNT; i++) {
    const d = angleDelta(h, BAND_CENTERS[i])
    const w = d >= BAND_HALF_WIDTH ? 0 : 1 - d / BAND_HALF_WIDTH
    WEIGHTS[i] = w
    total += w
  }
  if (total < 1e-6) {
    out[0] = r
    out[1] = g
    out[2] = b
    return
  }

  let hueShift = 0
  let satAdj = 0
  let lumAdj = 0
  for (let i = 0; i < BAND_COUNT; i++) {
    const w = WEIGHTS[i]
    if (w === 0) continue
    hueShift += w * ctx.hue[i]
    satAdj += w * ctx.sat[i]
    lumAdj += w * ctx.lum[i]
  }
  hueShift /= total
  satAdj /= total
  lumAdj /= total

  const nh = h + hueShift
  s = clamp(s * (1 + satAdj), 0, 1)
  l = clamp(lumAdj >= 0 ? l + (1 - l) * lumAdj : l * (1 + lumAdj), 0, 1)

  hslToRgb(nh, s, l, RGB_SCRATCH)
  out[0] = RGB_SCRATCH[0]
  out[1] = RGB_SCRATCH[1]
  out[2] = RGB_SCRATCH[2]
}

export interface GradeContext {
  active: boolean
  s: Float32Array
  m: Float32Array
  h: Float32Array
  pivot: number
  gamma: number
}

/** 偏移量映射：±100 -> ±0.22 的显示域加性偏移 */
const GRADE_SCALE = 0.22

export function buildGradeContext(grading: ColorGradingParams): GradeContext {
  const s = new Float32Array(3)
  const m = new Float32Array(3)
  const h = new Float32Array(3)
  let active = false
  for (let c = 0; c < 3; c++) {
    s[c] = (grading.shadows[c] / 100) * GRADE_SCALE
    m[c] = (grading.midtones[c] / 100) * GRADE_SCALE
    h[c] = (grading.highlights[c] / 100) * GRADE_SCALE
    if (s[c] !== 0 || m[c] !== 0 || h[c] !== 0) active = true
  }
  const blend = clamp(grading.blending / 100, 0, 1)
  return {
    active,
    s,
    m,
    h,
    pivot: clamp(0.5 + (grading.balance / 100) * 0.45, 0.05, 0.95),
    gamma: 0.45 + (1 - blend) * 2.2
  }
}

/** 在显示域施加色彩分级（阴影 / 中间调 / 高光） */
export function applyGrading(r: number, g: number, b: number, ctx: GradeContext, out: Float32Array): void {
  const lum = clamp(luminance(r, g, b), 0, 1)
  const p = ctx.pivot
  let ws: number
  let wh: number
  let wm: number
  if (lum < p) {
    ws = 1 - lum / p
    wh = 0
    wm = 1 - ws
  } else {
    wh = (lum - p) / (1 - p)
    ws = 0
    wm = 1 - wh
  }
  ws = Math.pow(ws, ctx.gamma)
  wh = Math.pow(wh, ctx.gamma)
  wm = Math.pow(wm, ctx.gamma)

  out[0] = clamp(r + ctx.s[0] * ws + ctx.m[0] * wm + ctx.h[0] * wh, 0, 1)
  out[1] = clamp(g + ctx.s[1] * ws + ctx.m[1] * wm + ctx.h[1] * wh, 0, 1)
  out[2] = clamp(b + ctx.s[2] * ws + ctx.m[2] * wm + ctx.h[2] * wh, 0, 1)
}
