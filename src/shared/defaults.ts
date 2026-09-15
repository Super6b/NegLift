import type {
  ColorGradingParams,
  Curves,
  DenoiseParams,
  EditParams,
  HslBandName,
  HslBands
} from './types'

export const DEFAULT_CURVE_POINTS = [
  { x: 0, y: 0 },
  { x: 1, y: 1 }
]

export const HSL_BANDS: HslBandName[] = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']

/** 各色相分区的中心色相（度） */
export const HSL_BAND_HUE: Record<HslBandName, number> = {
  red: 0,
  orange: 30,
  yellow: 60,
  green: 120,
  aqua: 180,
  blue: 240,
  purple: 285,
  magenta: 320
}

export const HSL_BAND_LABEL: Record<HslBandName, string> = {
  red: '红色',
  orange: '橙色',
  yellow: '黄色',
  green: '绿色',
  aqua: '青色',
  blue: '蓝色',
  purple: '紫色',
  magenta: '洋红'
}

export function createLinearCurves(): Curves {
  return {
    rgb: DEFAULT_CURVE_POINTS.map((p) => ({ ...p })),
    r: DEFAULT_CURVE_POINTS.map((p) => ({ ...p })),
    g: DEFAULT_CURVE_POINTS.map((p) => ({ ...p })),
    b: DEFAULT_CURVE_POINTS.map((p) => ({ ...p }))
  }
}

export function createDefaultHsl(): HslBands {
  const out = {} as HslBands
  for (const name of HSL_BANDS) out[name] = { hue: 0, saturation: 0, luminance: 0 }
  return out
}

export function createDefaultGrading(): ColorGradingParams {
  return {
    shadows: [0, 0, 0],
    midtones: [0, 0, 0],
    highlights: [0, 0, 0],
    blending: 50,
    balance: 0
  }
}

export function createDefaultDenoise(): DenoiseParams {
  return {
    enabled: false,
    color: 0,
    luminance: 0
  }
}

export function createDefaultParams(): EditParams {
  return {
    version: 1,
    negative: {
      enabled: true,
      mode: 'align',
      base: [0.72, 0.5, 0.32],
      strength: 0.7,
      balance: [1, 1, 1],
      tRef: 0.06,
      highlightRolloff: 0.3,
      alignBlack: [0, 0, 0],
      alignWhite: [1, 1, 1],
      alignHeadroom: 0.05
    },
    basic: {
      temperature: 0,
      tint: 0,
      exposure: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      saturation: 0,
      vibrance: 0
    },
    curves: createLinearCurves(),
    hsl: createDefaultHsl(),
    grading: createDefaultGrading(),
    denoise: createDefaultDenoise(),
    transform: {
      rotate90: 0,
      angle: 0,
      flipH: false,
      flipV: false,
      crop: null,
      aspect: null,
      validArea: null,
      excludeAreas: [],
      holderScan: 'inward'
    },
    repairs: []
  }
}

export function cloneParams(params: EditParams): EditParams {
  const hsl = {} as HslBands
  for (const name of HSL_BANDS) hsl[name] = { ...params.hsl[name] }
  return {
    version: params.version,
    negative: {
      ...params.negative,
      base: [...params.negative.base],
      balance: [...params.negative.balance],
      alignBlack: [...params.negative.alignBlack],
      alignWhite: [...params.negative.alignWhite],
      alignHeadroom: params.negative.alignHeadroom ?? 0.05
    },
    basic: { ...params.basic },
    curves: {
      rgb: params.curves.rgb.map((p) => ({ ...p })),
      r: params.curves.r.map((p) => ({ ...p })),
      g: params.curves.g.map((p) => ({ ...p })),
      b: params.curves.b.map((p) => ({ ...p }))
    },
    hsl,
    grading: {
      shadows: [...params.grading.shadows],
      midtones: [...params.grading.midtones],
      highlights: [...params.grading.highlights],
      blending: params.grading.blending,
      balance: params.grading.balance
    },
    denoise: { ...params.denoise },
    transform: {
      ...params.transform,
      crop: params.transform.crop ? { ...params.transform.crop } : null,
      excludeAreas: (params.transform.excludeAreas ?? []).map((r) => ({ ...r })),
      holderScan: params.transform.holderScan === 'outward' ? 'outward' : 'inward'
    },
    repairs: (params.repairs ?? []).map((s) => ({
      points: (s.points ?? []).map((p) => ({ x: p.x, y: p.y })),
      r: s.r,
      strength: s.strength ?? 1
    }))
  }
}

/** 将任意来源（预设/文件）的参数补齐为完整结构，避免旧版本缺失字段 */
export function normalizeParams(input: Partial<EditParams> | null | undefined): EditParams {
  const d = createDefaultParams()
  if (!input) return d
  const merged = cloneParams({ ...d, ...input } as EditParams)
  if (input.negative) {
    merged.negative = { ...d.negative, ...input.negative }
    merged.negative.base = [...(merged.negative.base ?? d.negative.base)]
    merged.negative.balance = [...(merged.negative.balance ?? d.negative.balance)]
    merged.negative.alignBlack = [...(merged.negative.alignBlack ?? d.negative.alignBlack)]
    merged.negative.alignWhite = [...(merged.negative.alignWhite ?? d.negative.alignWhite)]
    merged.negative.mode = 'align'
  }
  if (input.basic) merged.basic = { ...d.basic, ...input.basic }
  if (input.curves) merged.curves = { ...d.curves, ...input.curves }
  if (input.hsl) merged.hsl = { ...d.hsl, ...input.hsl }
  if (input.grading) merged.grading = { ...d.grading, ...input.grading }
  if (input.denoise) merged.denoise = { ...d.denoise, ...input.denoise }
  if (input.transform) {
    merged.transform = { ...d.transform, ...input.transform }
    merged.transform.crop = input.transform.crop ? { ...input.transform.crop } : null
    merged.transform.validArea = input.transform.validArea ? { ...input.transform.validArea } : null
    merged.transform.excludeAreas = (input.transform.excludeAreas ?? []).map((r) => ({ ...r }))
    merged.transform.holderScan = input.transform.holderScan === 'outward' ? 'outward' : 'inward'
  }
  merged.repairs = (input.repairs ?? []).map((s) => ({
    points: (s.points ?? []).map((p) => ({ x: p.x, y: p.y })),
    r: s.r,
    strength: s.strength ?? 1
  }))
  return merged
}

export function isDefaultParams(params: EditParams): boolean {
  const d = createDefaultParams()
  const strip = (p: EditParams): string =>
    JSON.stringify({
      ...p,
      // 片基由自动检测决定，比较时忽略
      negative: { ...p.negative, base: [0, 0, 0] }
    })
  return strip(params) === strip(d)
}
