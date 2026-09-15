import type { Curves, EditParams, NegativeMode } from '../types'
import { clamp, srgbEncode, whiteBalanceGain } from './color'
import { buildCurveLut, isIdentityCurve, sampleLut } from './curve'

/** 单通道色调链的预计算上下文 */
export interface ToneContext {
  negativeEnabled: boolean
  /** 校正模式：base = 按片基密度反相；align = 通道对齐后反色 */
  mode: NegativeMode
  base: [number, number, number]
  /** 每通道反相指数 k = balance / strength */
  k: [number, number, number]
  /** 白场归一化系数（由 tRef 与平均 k 推导，保证中性不偏色） */
  whitePoint: number
  highlightRolloff: number
  /** 通道对齐的每通道黑场 / 白场（align 模式；base 模式也用于色罩预对齐） */
  alignBlack: [number, number, number]
  alignWhite: [number, number, number]
  /** 最密处（画面最亮处）对应的归一化透射率，两种模式共用的密度下限 */
  alignTRef: number
  /** 显示编码域两端保留比例（0..0.35）：编码值映射到 [h, 1−h]，直方图两端均匀回缩 */
  alignHeadroom: number
  /**
   * base 模式是否做通道预对齐。
   * 彩色负片黑场三通道差 > ~0.1 时，单纯 t=lin/base 反相会残留青蓝罩，
   * 需要先把各通道拉到同一透射率尺度再反相。
   */
  baseChromaAlign: boolean
  wb: [number, number, number]
  exposureGain: number
  shadows: number
  highlights: number
  blacks: number
  whites: number
  contrast: number
  /** 合并了 RGB 曲线与单通道曲线的查找表 */
  curveLut: [Float32Array, Float32Array, Float32Array] | null
}

const EPS_T = 1e-5
/** 通道对齐时黑/白场之间的最小跨度，避免除零放大噪点 */
const MIN_ALIGN_SPAN = 1e-3
export const LUT_SIZE = 4096

export function buildToneContext(params: EditParams): ToneContext {
  const { negative, basic, curves } = params

  const k: [number, number, number] = [
    negative.balance[0] / Math.max(negative.strength, 0.05),
    negative.balance[1] / Math.max(negative.strength, 0.05),
    negative.balance[2] / Math.max(negative.strength, 0.05)
  ]
  const kMean = (k[0] + k[1] + k[2]) / 3
  const tRef = clamp(negative.tRef, 1e-4, 0.995)
  let whitePoint = Math.pow(tRef, -kMean) - 1
  if (!Number.isFinite(whitePoint) || whitePoint < 0.25) whitePoint = 0.25

  const alignBlack = [
    clamp(negative.alignBlack[0], 0, 0.95),
    clamp(negative.alignBlack[1], 0, 0.95),
    clamp(negative.alignBlack[2], 0, 0.95)
  ] as [number, number, number]
  const alignWhite = [
    clamp(negative.alignWhite[0], 0.02, 1),
    clamp(negative.alignWhite[1], 0.02, 1),
    clamp(negative.alignWhite[2], 0.02, 1)
  ] as [number, number, number]
  const blackSpread =
    Math.max(alignBlack[0], alignBlack[1], alignBlack[2]) -
    Math.min(alignBlack[0], alignBlack[1], alignBlack[2])

  return {
    negativeEnabled: negative.enabled,
    mode: negative.mode,
    base: [Math.max(negative.base[0], 1e-4), Math.max(negative.base[1], 1e-4), Math.max(negative.base[2], 1e-4)],
    k,
    whitePoint,
    highlightRolloff: negative.highlightRolloff,
    alignBlack,
    alignWhite,
    alignTRef: tRef,
    alignHeadroom: clamp(negative.alignHeadroom ?? 0, 0, 0.25),
    baseChromaAlign: blackSpread > 0.1,
    wb: whiteBalanceGain(basic.temperature, basic.tint),
    exposureGain: Math.pow(2, basic.exposure),
    shadows: basic.shadows / 100,
    highlights: basic.highlights / 100,
    blacks: basic.blacks / 100,
    whites: basic.whites / 100,
    contrast: basic.contrast / 100,
    curveLut: buildCombinedCurveLuts(curves)
  }
}

/**
 * 将「RGB 曲线 + 单通道曲线」合并为三条查找表（恒等曲线返回 null 以走快速路径）。
 */
function buildCombinedCurveLuts(curves: Curves): [Float32Array, Float32Array, Float32Array] | null {
  const identityRgb = isIdentityCurve(curves.rgb)
  const identityR = isIdentityCurve(curves.r)
  const identityG = isIdentityCurve(curves.g)
  const identityB = isIdentityCurve(curves.b)
  if (identityRgb && identityR && identityG && identityB) return null

  const rgbLut = identityRgb ? null : buildCurveLut(curves.rgb, LUT_SIZE)
  const chLuts = [
    identityR ? null : buildCurveLut(curves.r, LUT_SIZE),
    identityG ? null : buildCurveLut(curves.g, LUT_SIZE),
    identityB ? null : buildCurveLut(curves.b, LUT_SIZE)
  ]
  const out = [new Float32Array(LUT_SIZE + 1), new Float32Array(LUT_SIZE + 1), new Float32Array(LUT_SIZE + 1)]
  for (let c = 0; c < 3; c++) {
    const ch = chLuts[c]
    for (let i = 0; i <= LUT_SIZE; i++) {
      let v = i / LUT_SIZE
      if (rgbLut) v = sampleLut(rgbLut, v)
      if (ch) v = sampleLut(ch, v)
      out[c][i] = v
    }
  }
  return [out[0], out[1], out[2]]
}

/**
 * 将线性值映射到通道对齐的 0..1（不在此处做 headroom）。
 * headroom 改在反相后的显示线性域施加，保证直方图两端收缩更均匀。
 */
function alignNormalize(lin: number, black: number, white: number): number {
  const span = Math.max(white - black, MIN_ALIGN_SPAN)
  return clamp((lin - black) / span, 0, 1)
}

/** 单通道完整色调链：线性输入 0..1 -> 显示域输出 0..1 */
export function channelTransfer(lin: number, ci: 0 | 1 | 2, ctx: ToneContext): number {
  let L: number
  if (ctx.negativeEnabled) {
    let t: number
    if (ctx.mode === 'align') {
      const n = alignNormalize(lin, ctx.alignBlack[ci], ctx.alignWhite[ci])
      t = ctx.alignTRef + (1 - ctx.alignTRef) * n
    } else if (ctx.baseChromaAlign) {
      const n = alignNormalize(lin, ctx.alignBlack[ci], ctx.alignWhite[ci])
      const baseNorm = ctx.base[ci] / Math.max(ctx.base[0], ctx.base[1], ctx.base[2], 1e-4)
      const aligned = 0.85 * n + 0.15 * clamp(lin / ctx.base[ci], 0, 1) / Math.max(baseNorm, 0.35)
      t = clamp(ctx.alignTRef + (1 - ctx.alignTRef) * clamp(aligned, 0, 1), EPS_T, 1)
    } else {
      t = clamp(lin / ctx.base[ci], EPS_T, 1)
    }
    // 反色：按胶片密度模型反相（非线性，符合负片对数响应）
    L = Math.pow(t, -ctx.k[ci]) - 1
    L /= ctx.whitePoint
    if (L < 0) L = 0
    if (L > 1 && ctx.highlightRolloff > 0) {
      const over = L - 1
      L = 1 + over / (1 + over * ctx.highlightRolloff * 4)
    }
  } else {
    L = lin
  }

  L *= ctx.wb[ci] * ctx.exposureGain

  let v = srgbEncode(L)

  // 两端保留：在**显示编码域**对称映射到 [h, 1−h]。
  // 直方图通常按编码值统计；若在显示线性域 L 上压，因 sRGB 近似幂函数，
  // 暗部 h 会被放大成明显提黑、亮部几乎不动。
  if (ctx.negativeEnabled && ctx.alignHeadroom > 0) {
    const h = Math.min(0.35, Math.max(0, ctx.alignHeadroom))
    v = clamp(v, 0, 1) * (1 - 2 * h) + h
  }

  if (ctx.shadows !== 0 || ctx.highlights !== 0) {
    const vc = clamp(v, 0, 1)
    const mS = (1 - vc) * (1 - vc) * (1 - vc)
    const mH = vc * vc * vc
    v *= Math.pow(2, ctx.shadows * 1.2 * mS + ctx.highlights * 1.2 * mH)
  }

  if (ctx.blacks !== 0 || ctx.whites !== 0) {
    const b = -ctx.blacks * 0.15
    const w = 1 + ctx.whites * 0.15
    const span = w - b
    if (Math.abs(span) > 1e-6) v = (v - b) / span
  }

  if (ctx.contrast !== 0) {
    const kk = Math.pow(2, ctx.contrast)
    v = 0.5 + (v - 0.5) * kk
  }

  if (ctx.curveLut) v = sampleLut(ctx.curveLut[ci], clamp(v, 0, 1))

  return clamp(v, 0, 1)
}

/** 按 0..1 线性输入烘焙三条通道 LUT，供逐像素快速查表 */
export function bakeChannelLuts(ctx: ToneContext): [Float32Array, Float32Array, Float32Array] {
  const luts: Float32Array[] = [new Float32Array(LUT_SIZE + 1), new Float32Array(LUT_SIZE + 1), new Float32Array(LUT_SIZE + 1)]
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i <= LUT_SIZE; i++) {
      luts[c][i] = channelTransfer(i / LUT_SIZE, c as 0 | 1 | 2, ctx)
    }
  }
  return [luts[0], luts[1], luts[2]]
}
