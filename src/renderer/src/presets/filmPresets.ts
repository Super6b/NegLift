import type {
  BasicParams,
  ColorGradingParams,
  CurvePoint,
  Curves,
  EditParams,
  HslBands
} from '@shared/types'
import { HSL_BANDS, cloneParams } from '@shared/defaults'

/**
 * 预设只描述「风格化调色」（阶段③）：基础 / 曲线 / HSL / 分级。
 * **不包含**去色罩、降噪与几何——这些属于阶段①②，必须保持当前自动检测结果。
 */
export interface PresetParams {
  basic?: Partial<BasicParams>
  curves?: Partial<Curves>
  hsl?: Partial<HslBands>
  grading?: Partial<ColorGradingParams>
}

export interface FilmPreset {
  id: string
  name: string
  group: string
  description: string
  params: PresetParams
}

function rgbCurve(strength: number): CurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 0.25, y: Math.max(0, 0.25 - strength) },
    { x: 0.5, y: 0.5 },
    { x: 0.75, y: Math.min(1, 0.75 + strength) },
    { x: 1, y: 1 }
  ]
}

/** 分色调曲线：在阴影/高光分别提亮对应通道 */
function toneCurve(liftLow: number, liftHigh: number): CurvePoint[] {
  return [
    { x: 0, y: Math.max(0, liftLow) },
    { x: 0.35, y: 0.35 + (liftLow + liftHigh) / 6 },
    { x: 1, y: Math.min(1, 1 + liftHigh) }
  ]
}

export const FILM_PRESETS: FilmPreset[] = [
  {
    id: 'none',
    name: '原片（无调整）',
    group: '基础',
    description: '仅保留去色罩与自动检测结果',
    params: {}
  },
  {
    id: 'portra-400',
    name: 'Kodak Portra 400',
    group: '彩色负片',
    description: '柔和暖调，肤色通透，宽容度高',
    params: {
      basic: {
        temperature: 6,
        tint: 2,
        contrast: -8,
        highlights: -12,
        shadows: 12,
        whites: 4,
        blacks: -6,
        saturation: -8,
        vibrance: 12
      },
      curves: { rgb: rgbCurve(0.02) },
      hsl: {
        orange: { hue: -2, saturation: 6, luminance: 5 },
        yellow: { hue: 0, saturation: 2, luminance: 3 }
      },
      grading: { shadows: [4, 3, 8], highlights: [8, 4, -4], blending: 58, balance: -6 }
    }
  },
  {
    id: 'ektar-100',
    name: 'Kodak Ektar 100',
    group: '彩色负片',
    description: '极高饱和与锐利反差，风景利器',
    params: {
      basic: {
        temperature: -4,
        tint: 0,
        contrast: 12,
        highlights: -6,
        shadows: 6,
        whites: 6,
        blacks: -10,
        saturation: 14,
        vibrance: 8
      },
      curves: { rgb: rgbCurve(0.04) },
      hsl: { blue: { hue: 0, saturation: 10, luminance: -4 }, green: { hue: 0, saturation: 8, luminance: 0 } },
      grading: { shadows: [0, 0, 6], highlights: [6, 0, -6], blending: 45 }
    }
  },
  {
    id: 'gold-200',
    name: 'Kodak Gold 200',
    group: '彩色负片',
    description: '浓郁暖黄，复古日常感',
    params: {
      basic: {
        temperature: 11,
        tint: 3,
        contrast: 4,
        highlights: -6,
        shadows: 8,
        saturation: 6,
        vibrance: 6
      },
      curves: { rgb: rgbCurve(0.03) },
      grading: { shadows: [7, 4, 0], midtones: [4, 2, -4], highlights: [4, 2, -2], blending: 50 }
    }
  },
  {
    id: 'pro-400h',
    name: 'Fujifilm Pro 400H',
    group: '彩色负片',
    description: '青绿通透，日系空气感',
    params: {
      basic: {
        temperature: -6,
        tint: -3,
        contrast: -6,
        highlights: -10,
        shadows: 12,
        blacks: 4,
        saturation: -6,
        vibrance: 10
      },
      curves: { g: toneCurve(0.02, 0.01), b: toneCurve(0.03, 0) },
      grading: { shadows: [-4, 2, 7], highlights: [-4, 0, 4], blending: 58 }
    }
  },
  {
    id: 'provia-100f',
    name: 'Fujifilm Provia 100F',
    group: '反转片',
    description: '中性还原，反差适中，标准反转片',
    params: {
      basic: {
        temperature: -2,
        contrast: 10,
        highlights: -6,
        shadows: 4,
        whites: 5,
        blacks: -7,
        saturation: 8,
        vibrance: 4
      },
      curves: { rgb: rgbCurve(0.04) },
      grading: { shadows: [-2, 0, 3], highlights: [3, 0, -2], blending: 50 }
    }
  },
  {
    id: 'velvia-50',
    name: 'Fujifilm Velvia 50',
    group: '反转片',
    description: '极高饱和度与深色阴影，风光经典',
    params: {
      basic: {
        temperature: -5,
        contrast: 16,
        highlights: -8,
        shadows: 2,
        whites: 6,
        blacks: -12,
        saturation: 22,
        vibrance: 6
      },
      curves: { rgb: rgbCurve(0.05) },
      hsl: {
        green: { hue: 0, saturation: 12, luminance: -4 },
        blue: { hue: 0, saturation: 10, luminance: -5 },
        aqua: { hue: 0, saturation: 8, luminance: -3 }
      },
      grading: { shadows: [-3, 0, 8], highlights: [5, 0, -4], blending: 42 }
    }
  },
  {
    id: 'cinestill-800t',
    name: 'CineStill 800T',
    group: '影院胶片',
    description: '钨丝灯平衡，青蓝阴影与暖高光',
    params: {
      basic: {
        temperature: -14,
        tint: -4,
        contrast: 6,
        highlights: -8,
        shadows: 8,
        whites: 4,
        blacks: -6,
        saturation: 4,
        vibrance: 6
      },
      curves: { b: toneCurve(0.03, 0.01) },
      grading: { shadows: [-11, -2, 11], midtones: [-2, 0, 4], highlights: [5, 1, 2], blending: 52 }
    }
  },
  {
    id: 'delta-100',
    name: 'Ilford Delta 100',
    group: '黑白',
    description: '细腻黑白，通透中反差',
    params: {
      basic: { contrast: 14, highlights: -6, shadows: 6, whites: 6, blacks: -9, saturation: -100 },
      curves: { rgb: rgbCurve(0.05) }
    }
  },
  {
    id: 'hp5-400',
    name: 'Ilford HP5 400',
    group: '黑白',
    description: '柔和黑白，宽容的中间调',
    params: {
      basic: { contrast: 6, highlights: -8, shadows: 10, blacks: 2, saturation: -100 },
      curves: { rgb: rgbCurve(0.02) }
    }
  },
  {
    id: 'trix-400',
    name: 'Kodak Tri-X 400',
    group: '黑白',
    description: '高反差纪实黑白，深黑厚实',
    params: {
      basic: { contrast: 20, highlights: -4, shadows: 2, whites: 8, blacks: -14, saturation: -100 },
      curves: { rgb: rgbCurve(0.07) }
    }
  }
]

/**
 * 把预设套用到当前参数：只替换风格化字段。
 * 去色罩、降噪、几何全部原样保留，避免预设干扰标准色彩还原。
 */
export function applyPreset(current: EditParams, preset: FilmPreset): EditParams {
  const next = cloneParams(current)
  const p = preset.params

  if (p.basic) next.basic = { ...next.basic, ...p.basic }
  if (p.curves) {
    next.curves = {
      rgb: (p.curves.rgb ?? next.curves.rgb).map((q) => ({ ...q })),
      r: (p.curves.r ?? next.curves.r).map((q) => ({ ...q })),
      g: (p.curves.g ?? next.curves.g).map((q) => ({ ...q })),
      b: (p.curves.b ?? next.curves.b).map((q) => ({ ...q }))
    }
  }
  if (p.hsl) {
    for (const name of HSL_BANDS) {
      next.hsl[name] = { ...next.hsl[name], ...(p.hsl[name] ?? {}) }
    }
  }
  if (p.grading) {
    next.grading = {
      ...next.grading,
      ...p.grading,
      shadows: [...(p.grading.shadows ?? next.grading.shadows)] as [number, number, number],
      midtones: [...(p.grading.midtones ?? next.grading.midtones)] as [number, number, number],
      highlights: [...(p.grading.highlights ?? next.grading.highlights)] as [number, number, number]
    }
  }
  return next
}

/**
 * 自定义预设：只写回风格化字段，去色罩 / 降噪 / 几何保持当前状态。
 */
export function applyCustomPresetParams(current: EditParams, saved: EditParams): EditParams {
  const next = cloneParams(current)
  next.basic = cloneParams(saved).basic
  next.curves = cloneParams(saved).curves
  next.hsl = cloneParams(saved).hsl
  next.grading = cloneParams(saved).grading
  return next
}

/**
 * 工作流预设：风格化字段 + 降噪 + 去色罩中的强度/平衡（不含自动检测的
 * mode/base/tRef/align 与几何）。用于批量套用到整卷胶片。
 */
export function applyWorkflowParams(current: EditParams, saved: EditParams): EditParams {
  const next = applyCustomPresetParams(current, saved)
  next.denoise = { ...saved.denoise }
  next.negative.enabled = saved.negative.enabled
  next.negative.strength = saved.negative.strength
  next.negative.balance = [...saved.negative.balance] as [number, number, number]
  next.negative.highlightRolloff = saved.negative.highlightRolloff
  return next
}

/* ---------- 用户自定义预设（本地持久化） ---------- */

const STORAGE_KEY = 'neglift.custom-presets.v1'

export interface CustomPreset {
  id: string
  name: string
  createdAt: number
  params: EditParams
}

export function loadCustomPresets(): CustomPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as CustomPreset[]
  } catch {
    return []
  }
}

export function saveCustomPresets(list: CustomPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* 存储不可用时静默失败 */
  }
}
