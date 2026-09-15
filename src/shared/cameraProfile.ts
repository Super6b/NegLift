/**
 * 机型优化配置（Camera Profile）。
 *
 * 不同厂商 RAW 在 CFA、色彩矩阵、双增益、位深上并不相同；LibRaw 会读相机
 * 矩阵做线性 RGB，但去马赛克算法档、白平衡来源、高光处理等仍可按机型微调。
 * 负片翻拍场景下，扫描机身 + 镜头组合也会影响去色罩的默认倾向。
 */
import type { NegativeMode } from './types'

/** LibRaw setOutputParams 可覆盖的子集（缺省项走全局默认） */
export interface CameraDecodeHints {
  /** 去马赛克算法档：0=VNG 2=PPG 3=AHD，更高档视 LibRaw 版本（AMaZE/RCD 等） */
  user_qual?: number
  use_camera_wb?: boolean
  use_camera_matrix?: boolean
  /** 0=raw 1=camera RGB 2=linear sRGB（负片扫描通常保持 1 + 线性 gamma） */
  output_color?: number
  highlight?: number
  /** 四色滤镜机型（部分 Foveon/老 Kodak） */
  four_color_rgb?: boolean
  /** 关闭自动亮度（扫描负片应保持 true） */
  no_auto_bright?: boolean
  /** 手动白平衡色温（use_camera_wb=false 时有意义） */
  cam_mul?: [number, number, number] | null
}

export interface NegativeHints {
  /** 倾向的校正模式；null/缺省 = 完全自动判定 */
  preferredMode?: NegativeMode | null
  /** 建议 strength（0.05..1.5），自动检测后可覆盖 */
  strength?: number
}

export interface CameraProfile {
  id: string
  name: string
  /** 匹配相机元数据：make/model 任填，子串、不区分大小写 */
  match: { make?: string; model?: string }
  decode?: CameraDecodeHints
  negative?: NegativeHints
  notes?: string
  /** 内置还是用户导入 */
  builtin?: boolean
}

/** 全局默认解码参数（无机型匹配时） */
export const DEFAULT_DECODE_HINTS: Required<Omit<CameraDecodeHints, 'cam_mul'>> = {
  user_qual: 3,
  use_camera_wb: true,
  use_camera_matrix: 1 as unknown as boolean,
  output_color: 1,
  highlight: 0,
  four_color_rgb: false,
  no_auto_bright: true
}

/**
 * 内置：针对「负片翻拍」常见的机身倾向。
 * LibRaw 已处理 CFA/矩阵；这里主要是去马赛克质量与去色罩默认倾向。
 */
export const BUILTIN_CAMERA_PROFILES: CameraProfile[] = [
  {
    id: 'generic-sony',
    name: 'Sony（通用翻拍）',
    match: { make: 'sony' },
    decode: { user_qual: 3, use_camera_wb: true, use_camera_matrix: true, output_color: 1 },
    negative: { preferredMode: 'align' },
    notes: 'ARW 常见于翻拍；默认通道对齐去色罩，强橙罩下更稳。'
  },
  {
    id: 'sony-a7iv',
    name: 'Sony ILCE-7M4',
    match: { make: 'sony', model: 'ILCE-7M4' },
    decode: { user_qual: 3, use_camera_wb: true, use_camera_matrix: true },
    negative: { preferredMode: 'align' }
  },
  {
    id: 'sony-a7iii',
    name: 'Sony ILCE-7M3',
    match: { make: 'sony', model: 'ILCE-7M3' },
    decode: { user_qual: 3, use_camera_wb: true, use_camera_matrix: true },
    negative: { preferredMode: 'align' }
  },
  {
    id: 'generic-canon',
    name: 'Canon（通用翻拍）',
    match: { make: 'canon' },
    decode: { user_qual: 3, use_camera_wb: true, use_camera_matrix: true },
    negative: { preferredMode: 'align' }
  },
  {
    id: 'generic-nikon',
    name: 'Nikon（通用翻拍）',
    match: { make: 'nikon' },
    decode: { user_qual: 3, use_camera_wb: true, use_camera_matrix: true },
    negative: { preferredMode: 'align' }
  },
  {
    id: 'generic-fuji',
    name: 'Fujifilm（通用）',
    match: { make: 'fuji' },
    // X-Trans 勿用 Bayer 专用高档算法；VNG(0) 对 X-Trans 更稳，避免部分 LibRaw 版本崩溃
    decode: { user_qual: 0, use_camera_wb: true, use_camera_matrix: true },
    negative: { preferredMode: 'align' },
    notes: 'X-Trans 使用 VNG 去马赛克，避免 AHD/高档算法在部分 LibRaw 构建上崩溃。'
  },
  {
    id: 'generic-pentax',
    name: 'Pentax / Ricoh',
    match: { make: 'pentax' },
    decode: { user_qual: 3, use_camera_wb: true, use_camera_matrix: true },
    negative: { preferredMode: 'align' }
  }
]

function norm(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

/** 按 make/model 查找最具体的内置配置（model 精确优先于 make 通配） */
export function findBuiltinProfile(make?: string, model?: string): CameraProfile | null {
  const m = norm(make)
  const mo = norm(model)
  let best: CameraProfile | null = null
  let bestScore = -1
  for (const p of BUILTIN_CAMERA_PROFILES) {
    const pm = norm(p.match.make)
    const pmo = norm(p.match.model)
    if (!pm && !pmo) continue
    let score = 0
    if (pm && m.includes(pm)) score += 10
    else if (pm) continue
    if (pmo) {
      if (mo && mo.includes(pmo)) score += 50
      else continue
    }
    if (score > bestScore) {
      bestScore = score
      best = p
    }
  }
  return bestScore >= 0 ? best : null
}

/** 合并：用户配置覆盖内置，字段级合并 decode/negative */
export function mergeProfiles(base: CameraProfile | null, override: CameraProfile | null): CameraProfile | null {
  if (!base && !override) return null
  if (!base) return override
  if (!override) return base
  return {
    ...base,
    ...override,
    match: { ...base.match, ...override.match },
    decode: { ...base.decode, ...override.decode },
    negative: { ...base.negative, ...override.negative },
    builtin: false
  }
}

export function matchesProfile(p: CameraProfile, make?: string, model?: string): boolean {
  const m = norm(make)
  const mo = norm(model)
  const pm = norm(p.match.make)
  const pmo = norm(p.match.model)
  if (pm && !m.includes(pm)) return false
  if (pmo && !(mo && mo.includes(pmo))) return false
  return Boolean(pm || pmo)
}

/** 解析用户导入的 JSON（单个 profile 或 profile 数组） */
export function parseCameraProfiles(json: string): CameraProfile[] {
  const data: unknown = JSON.parse(json)
  const list = Array.isArray(data) ? data : [data]
  const out: CameraProfile[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const id = typeof o.id === 'string' && o.id ? o.id : `user-${out.length}-${Date.now().toString(36)}`
    const name = typeof o.name === 'string' && o.name ? o.name : id
    const matchRaw = (o.match ?? {}) as Record<string, unknown>
    const match = {
      make: typeof matchRaw.make === 'string' ? matchRaw.make : undefined,
      model: typeof matchRaw.model === 'string' ? matchRaw.model : undefined
    }
    if (!match.make && !match.model) continue
    const decode = (o.decode ?? undefined) as CameraDecodeHints | undefined
    const negative = (o.negative ?? undefined) as NegativeHints | undefined
    out.push({
      id,
      name,
      match,
      decode,
      negative,
      notes: typeof o.notes === 'string' ? o.notes : undefined,
      builtin: false
    })
  }
  return out
}

/** 组装最终生效的解码参数（在默认之上打补丁） */
export function resolveDecodeOutputParams(
  profile: CameraProfile | null
): {
  output_bps: number
  gamma: number[]
  no_auto_bright: boolean
  output_color: number
  use_camera_wb: boolean
  use_camera_matrix: number
  user_qual: number
  highlight: number
  output_tiff: boolean
  four_color_rgb?: boolean
  cam_mul?: number[]
} {
  const d = profile?.decode
  return {
    output_bps: 16,
    gamma: [1, 1, 0, 0, 0, 0],
    no_auto_bright: d?.no_auto_bright ?? true,
    output_color: d?.output_color ?? 1,
    use_camera_wb: d?.use_camera_wb ?? true,
    use_camera_matrix: d?.use_camera_matrix ? 1 : 0,
    user_qual: d?.user_qual ?? 3,
    highlight: d?.highlight ?? 0,
    output_tiff: false,
    ...(d?.four_color_rgb ? { four_color_rgb: true } : {}),
    ...(d?.cam_mul ? { cam_mul: [...d.cam_mul] } : {})
  }
}
