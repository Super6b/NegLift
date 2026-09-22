import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import type {
  CropRect,
  DetectResult,
  HolderScanDirection,
  ImageMeta,
  OpenProgress,
  TransformParams,
  Vec3
} from '@shared/types'
import { detectHolderRect, detectNegative, sampleAt } from '@shared/pipeline/analysis'
import { decimateLinear, detectionRegion, downsampleLinear } from '@shared/pipeline'
import { decodeImage, type DecodeResult } from './decode'

/**
 * 预览（交给渲染进程 / GPU 纹理）的上限。
 *
 * 线性 RGB16 交错约 6 字节/像素；GPU 侧 RGB16UI 约 6–8 字节/像素。
 * 6000px 级机身（如 X-T3）整图进 WebGL 容易上下文丢失/进程崩溃，
 * 因此除内存外再按**长边**封顶，保证缩放/框选交互稳定。
 * 完整分辨率仍在 decode.linear，导出仍可用全尺寸。
 */
const PREVIEW_MAX_BYTES = 384 * 1024 * 1024
/** 预览长边上限：4096 足够调色观察，又远低于常见 GPU 纹理压力区 */
const PREVIEW_MAX_EDGE = 4096

/** 统计分析（片基 / 通道对齐 / 片夹）使用的抽样长边 */
const ANALYSIS_MAX_EDGE = 1600

export interface ImageSession {
  sourcePath: string
  decode: DecodeResult
  /** 全尺寸（或超限降采样后）的线性数据，供渲染进程调色 */
  preview: Uint16Array
  previewWidth: number
  previewHeight: number
  /** 抽样副本，仅用于统计类分析，避免在全尺寸数据上反复扫描 */
  analysis: Uint16Array
  analysisWidth: number
  analysisHeight: number
}

let current: ImageSession | null = null

export function getSession(): ImageSession | null {
  return current
}

export function clearSession(): void {
  current = null
}

export interface OpenResult {
  meta: ImageMeta
  preview: Uint16Array
  previewWidth: number
  previewHeight: number
  detected: DetectResult
  /** 预览是否按原分辨率提供（false 表示因超出内存上限被降采样） */
  fullSize: boolean
}

export type ProgressReporter = (progress: OpenProgress) => void

function makePreview(linear: Uint16Array, width: number, height: number): {
  preview: Uint16Array
  previewWidth: number
  previewHeight: number
  fullSize: boolean
} {
  const longEdge = Math.max(width, height)
  const bytes = width * height * 3 * 2
  if (longEdge <= PREVIEW_MAX_EDGE && bytes <= PREVIEW_MAX_BYTES) {
    return { preview: linear, previewWidth: width, previewHeight: height, fullSize: true }
  }
  const byMem = bytes > PREVIEW_MAX_BYTES ? Math.sqrt(PREVIEW_MAX_BYTES / bytes) : 1
  const byEdge = longEdge > PREVIEW_MAX_EDGE ? PREVIEW_MAX_EDGE / longEdge : 1
  const ratio = Math.min(byMem, byEdge)
  const pw = Math.max(1, Math.round(width * ratio))
  const ph = Math.max(1, Math.round(height * ratio))
  return {
    preview: downsampleLinear(linear, width, height, pw, ph),
    previewWidth: pw,
    previewHeight: ph,
    fullSize: false
  }
}

export async function openSession(filePath: string, onProgress?: ProgressReporter): Promise<OpenResult> {
  // 时间轴：解码 0~78%，生成预览 78~84%，分析 84~96%，交给渲染进程 96~100%
  const report = (progress: number, label: string, stage = 'decode'): void =>
    onProgress?.({ stage, progress: Math.max(0, Math.min(0.96, progress)), label })

  // profile=undefined：解码内按机身自动匹配机型配置
  const decode = await decodeImage(filePath, (p, label) => report(p * 0.78, label))
  const profile = decode.profile ?? null
  const profileSource: 'user' | 'builtin' | 'none' = profile
    ? profile.builtin
      ? 'builtin'
      : 'user'
    : 'none'

  report(0.79, '构建全尺寸预览…', 'preview')
  const { preview, previewWidth, previewHeight, fullSize } = makePreview(
    decode.linear,
    decode.width,
    decode.height
  )

  report(0.85, '构建分析副本…', 'analyze')
  const analysis = decimateLinear(preview, previewWidth, previewHeight, ANALYSIS_MAX_EDGE)

  report(0.88, '识别片夹边框…', 'analyze')
  // 片夹必须排除：它不属于画面，绝不能参与去色罩 / 通道对齐的参考统计。
  // 在固定长边的抽样副本上识别，保证结果不随源图分辨率变化而漂移。
  const holder = detectHolderRect(analysis.data, analysis.width, analysis.height)

  report(0.9, '检测色罩与通道…', 'analyze')
  const detected = detectNegative(analysis.data, analysis.width, analysis.height, holder, holder)
  // 机型配置可覆盖校正模式倾向（仍保留自动检测的 base/align 数据）
  // 片基反相已停用；机型配置中的 preferredMode 一律视为 align
  if (profile?.negative?.preferredMode) {
    detected.mode = 'align'
  }
  if (profile?.negative?.strength != null) {
    detected.suggestedStrength = profile.negative.strength
  }

  current = {
    sourcePath: filePath,
    decode,
    preview,
    previewWidth,
    previewHeight,
    analysis: analysis.data,
    analysisWidth: analysis.width,
    analysisHeight: analysis.height
  }

  let fileSize = 0
  try {
    fileSize = (await fs.stat(filePath)).size
  } catch {
    fileSize = 0
  }

  const meta: ImageMeta = {
    fileName: basename(filePath),
    filePath,
    fileSize,
    width: decode.width,
    height: decode.height,
    isRaw: decode.isRaw,
    degraded: decode.degraded,
    degradedReason: decode.degradedReason,
    camera: decode.camera,
    lens: decode.lens,
    iso: decode.iso,
    aperture: decode.aperture,
    shutterSpeed: decode.shutterSpeed,
    focalLength: decode.focalLength,
    capturedAt: decode.capturedAt,
    bitsPerSample: decode.bitsPerSample,
    profileId: profile?.id,
    profileName: profile?.name,
    profileSource
  }

  report(0.96, fullSize ? '载入预览引擎…' : '预览已降采样，载入引擎…', 'transfer')

  return { meta, preview, previewWidth, previewHeight, detected, fullSize }
}

/**
 * 从已打开结果生成胶片条缩略图（JPEG dataURL）。
 * 仅用降采样副本，不在 IPC 里传全尺寸像素。
 */
export async function makeLibraryThumb(result: {
  meta: ImageMeta
  preview: Uint16Array
  previewWidth: number
  previewHeight: number
  detected: DetectResult
  fullSize: boolean
}): Promise<{
  meta: ImageMeta
  detected: DetectResult
  thumbUrl: string
  fullSize: boolean
  linearThumb: Uint16Array
  linearThumbWidth: number
  linearThumbHeight: number
}> {
  const long = 160
  const s = long / Math.max(result.previewWidth, result.previewHeight, 1)
  const w = Math.max(1, Math.round(result.previewWidth * s))
  const h = Math.max(1, Math.round(result.previewHeight * s))
  const small = downsampleLinear(result.preview, result.previewWidth, result.previewHeight, w, h)
  const rgb8 = Buffer.allocUnsafe(w * h * 3)
  for (let i = 0, o = 0; i < w * h; i++, o += 3) {
    rgb8[o] = small[i * 3] >> 8
    rgb8[o + 1] = small[i * 3 + 1] >> 8
    rgb8[o + 2] = small[i * 3 + 2] >> 8
  }
  const sharp = (await import('sharp')).default
  const buf = await sharp(rgb8, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 72 })
    .toBuffer()
  return {
    meta: result.meta,
    detected: result.detected,
    thumbUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
    fullSize: result.fullSize,
    linearThumb: small,
    linearThumbWidth: w,
    linearThumbHeight: h
  }
}

/**
 * 重新自动检测。`transform` 用于限定检测区域：仅在
 * 「有效区域 ∩ 裁切区域」内统计，并再剔除用户标记的排除区域，
 * 确保片夹、齿孔等非画面内容不影响片基 / 通道对齐的参考值。
 */
export function detectOnFull(transform?: TransformParams): DetectResult | null {
  if (!current) return null
  const { analysis, analysisWidth, analysisHeight, decode } = current
  const region = transform ? detectionRegion(decode.width, decode.height, transform) : null
  const validArea = transform?.validArea ?? null
  return detectNegative(analysis, analysisWidth, analysisHeight, region, validArea, transform?.excludeAreas ?? null)
}

/** 自动识别片夹，返回有效区域（未发现时返回 null）。direction：从外向内 / 从中心向边缘。 */
export function detectHolder(direction: HolderScanDirection = 'inward'): CropRect | null {
  if (!current) return null
  const { analysis, analysisWidth, analysisHeight } = current
  return detectHolderRect(analysis, analysisWidth, analysisHeight, direction)
}

/** 在全分辨率原图上取色，u/v 为原图归一化坐标 */
export function sampleBase(u: number, v: number): Vec3 | null {
  if (!current) return null
  const { decode } = current
  return sampleAt(decode.linear, decode.width, decode.height, u, v)
}
