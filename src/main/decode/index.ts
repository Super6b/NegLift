import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { srgbDecode } from '@shared/pipeline/color'
import { resolveDecodeOutputParams, type CameraProfile } from '@shared/cameraProfile'
import { decodeBmp } from './bmp'

export interface DecodeResult {
  /** 全分辨率线性 RGB，交错，0..65535 */
  linear: Uint16Array
  width: number
  height: number
  isRaw: boolean
  bitsPerSample: number
  degraded: boolean
  degradedReason?: string
  camera?: string
  /** 元数据厂商 / 机型（用于匹配机型配置） */
  cameraMake?: string
  cameraModel?: string
  profileId?: string
  profileName?: string
  /** 生效配置对象，供 session 应用 negative 倾向 */
  profile?: CameraProfile | null
  lens?: string
  iso?: number
  aperture?: number
  shutterSpeed?: number
  focalLength?: number
  capturedAt?: number
}

export const RAW_EXTENSIONS = [
  '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.raf',
  '.rw2', '.orf', '.pef', '.dng', '.rwl', '.srw', '.kdc', '.dcr', '.mos',
  '.srf', '.3fr', '.mef', '.iiq', '.x3f', '.raw'
]

export const RASTER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.gif', '.avif', '.heic', '.heif', '.jfif']
export const BMP_EXTENSIONS = ['.bmp', '.dib']

/** sRGB 编码值(0..65535) -> 线性值(0..65535) 的查找表，避免逐像素 pow */
const SRGB_TO_LINEAR16 = (() => {
  const lut = new Uint16Array(65536)
  for (let i = 0; i < 65536; i++) lut[i] = Math.round(srgbDecode(i / 65535) * 65535)
  return lut
})()

/** 将 8bit 显示编码 RGB 转为线性 16bit */
function linearizeRgb8(rgb: Uint8Array, pixels: number, channels: number): Uint16Array {
  const out = new Uint16Array(pixels * 3)
  for (let i = 0, s = 0, d = 0; i < pixels; i++, s += channels, d += 3) {
    out[d] = SRGB_TO_LINEAR16[rgb[s] * 257]
    out[d + 1] = SRGB_TO_LINEAR16[rgb[s + 1] * 257]
    out[d + 2] = SRGB_TO_LINEAR16[rgb[s + 2] * 257]
  }
  return out
}

/** 将 16bit 显示编码 RGB 转为线性 16bit */
function linearizeRgb16(src: Uint16Array, pixels: number, channels: number): Uint16Array {
  const out = new Uint16Array(pixels * 3)
  for (let i = 0, s = 0, d = 0; i < pixels; i++, s += channels, d += 3) {
    out[d] = SRGB_TO_LINEAR16[src[s]]
    out[d + 1] = SRGB_TO_LINEAR16[src[s + 1]]
    out[d + 2] = SRGB_TO_LINEAR16[src[s + 2]]
  }
  return out
}

/**
 * 使用标准图像库解码 JPEG/PNG/TIFF/WebP/GIF 等格式，并转换为线性光域。
 *
 * 注意：`toColourspace('rgb16')` 必须与 `raw({ depth: 'ushort' })` 成对使用。
 * sharp 0.35 中若只调用 toColourspace('rgb16') 而不指定 raw 输出深度，
 * 会得到全白/全 255 的损坏数据；反之只指定 ushort 深度则会把 8 位值直接搬到
 * 16 位区间（不做 ×257 拉伸），丢失精度。
 */
async function decodeRaster(filePath: string): Promise<DecodeResult> {
  const pipeline = sharp(filePath, { limitInputPixels: false, unlimited: true, failOn: 'none' })
  const meta = await pipeline.metadata()
  const source16 = meta.depth === 'ushort'

  const { data, info } = await (source16
    ? pipeline.toColourspace('rgb16').raw({ depth: 'ushort' })
    : pipeline.raw()
  ).toBuffer({ resolveWithObject: true })

  const pixels = info.width * info.height
  const channels = info.channels
  const is16 = source16 && data.length >= pixels * channels * 2

  return {
    linear: is16
      ? linearizeRgb16(
          new Uint16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2)),
          pixels,
          channels
        )
      : linearizeRgb8(data, pixels, channels),
    width: info.width,
    height: info.height,
    isRaw: false,
    bitsPerSample: is16 ? 16 : 8,
    degraded: false
  }
}

async function decodeBmpFile(filePath: string): Promise<DecodeResult> {
  const buf = await fs.readFile(filePath)
  const { rgb, width, height } = decodeBmp(buf)
  return {
    linear: linearizeRgb8(rgb, width * height, 3),
    width,
    height,
    isRaw: false,
    bitsPerSample: 8,
    degraded: false
  }
}

/** 把 libraw 返回的像素缓冲转换为独立的 Uint16Array */
function extractPixels(
  data: Buffer,
  width: number,
  height: number,
  colors: number,
  bits: number
): Uint16Array {
  if (!width || !height || width < 1 || height < 1) {
    throw new Error(`解码尺寸无效：${width}×${height}`)
  }
  const ch = Math.max(1, Math.min(4, colors | 0) || 3)
  const pixels = width * height
  const out = new Uint16Array(pixels * 3)
  if (!data || data.length === 0) {
    throw new Error('LibRaw 未返回像素数据')
  }

  if (bits === 16) {
    const count = Math.floor(data.length / 2)
    if (count < pixels * 3) {
      // 缓冲不足时不要越界读，宁可抛错走内嵌预览回退
      throw new Error(`RAW 像素缓冲不足（${count} < ${pixels * 3}）`)
    }
    const src = new Uint16Array(data.buffer, data.byteOffset, count)
    if (ch === 3) {
      out.set(src.subarray(0, out.length))
    } else {
      for (let i = 0, s = 0, d = 0; i < pixels; i++, s += ch, d += 3) {
        if (s + 2 >= src.length) break
        out[d] = src[s]
        out[d + 1] = src[s + 1]
        out[d + 2] = src[s + 2]
      }
    }
  } else {
    if (data.length < pixels * 3) {
      throw new Error(`RAW 8bit 像素缓冲不足（${data.length} < ${pixels * 3}）`)
    }
    const src = data
    if (ch === 3) {
      for (let i = 0; i < out.length; i++) out[i] = src[i] * 257
    } else {
      for (let i = 0, s = 0, d = 0; i < pixels; i++, s += ch, d += 3) {
        if (s + 2 >= src.length) break
        out[d] = src[s] * 257
        out[d + 1] = src[s + 1] * 257
        out[d + 2] = src[s + 2] * 257
      }
    }
  }

  return out
}

/**
 * 解码进度回调：`progress` 为本步骤内的 0..1 进度，`label` 为中文描述。
 */
export type DecodeProgress = (progress: number, label: string) => void

/**
 * 单次不可中断的原生调用（去马赛克）无法上报内部进度，
 * 按像素规模估算耗时并做渐近填充，最高只推进到该阶段上限，不虚报完成。
 * 返回停止函数。
 */
function creepProgress(
  from: number,
  to: number,
  estimatedMs: number,
  report: DecodeProgress,
  label: string
): () => void {
  const started = Date.now()
  const timer = setInterval(() => {
    const t = (Date.now() - started) / estimatedMs
    const f = Math.min(1, 1 - Math.exp(-2.2 * t))
    report(from + (to - from) * f, label)
  }, 120)
  return () => clearInterval(timer)
}

/**
 * 使用 LibRaw 无损解码 RAW 文件。
 *
 * 关键输出参数：
 * - output_bps=16      保留 16bit 精度
 * - gamma=[1,1,...]    不施加任何 Gamma 曲线，得到线性光数据
 * - no_auto_bright     关闭自动亮度，避免破坏负片密度关系
 * - output_color=1     相机色彩矩阵转换到 sRGB 原色，但保持线性
 *
 * 生命周期：`loadFile()` 内部已完成 recycle → open → unpack，因此**不能**再调用
 * `unpack()`（会抛 “Out of order call of libraw function”）。正确顺序为
 * loadFile → setOutputParams → processImage → dcrawMakeMemImage。
 */
async function decodeRaw(
  filePath: string,
  onProgress?: DecodeProgress,
  profile?: CameraProfile | null
): Promise<DecodeResult> {
  const { LibRaw } = await import('lightdrift-libraw')
  const raw = new LibRaw()
  try {
    onProgress?.(0.02, '读取文件并解包 RAW 数据…')
    await raw.loadFile(filePath)
    onProgress?.(0.12, '读取文件并解包 RAW 数据…')
    const md = await raw.getMetadata()

    // profile === undefined：按元数据自动匹配用户/内置配置
    let active = profile
    let profileName: string | undefined
    let profileId: string | undefined
    if (active === undefined) {
      const { resolveProfileForCamera } = await import('../cameraProfiles')
      const resolved = await resolveProfileForCamera(md.make, md.model)
      active = resolved.profile ?? null
    }
    if (active) {
      profileId = active.id
      profileName = active.name
    }

    const outParams = resolveDecodeOutputParams(active) as Parameters<typeof raw.setOutputParams>[0]
    // Fuji / X-Trans：强制更稳的去马赛克档，避免部分 LibRaw 构建在 RAF 上原生崩溃
    const make = String(md.make || '').toLowerCase()
    if (make.includes('fuji') || make.includes('fujifilm')) {
      const fujiParams = outParams as Record<string, unknown>
      fujiParams.user_qual = 0
      delete fujiParams.four_color_rgb
      delete fujiParams.cam_mul
    }
    await raw.setOutputParams(outParams)

    // 去马赛克是全流程最慢的一步（4200 万像素约 4~5 秒），
    // LibRaw 不提供内部进度，按每百万像素约 105ms 估算做渐近填充。
    const megapixels = Math.max(
      1,
      ((md.rawWidth || md.width) * (md.rawHeight || md.height)) / 1e6
    )
    const stopCreep = creepProgress(
      0.14,
      0.78,
      Math.max(600, megapixels * 105),
      onProgress ?? (() => {}),
      `去马赛克（${md.width}×${md.height}）…`
    )
    try {
      await raw.processImage()
    } finally {
      stopCreep()
    }
    onProgress?.(0.8, '提取 16 位线性像素…')
    const img = await raw.dcrawMakeMemImage()
    if (!img?.data || !img.width || !img.height) {
      throw new Error('LibRaw 去马赛克结果为空')
    }

    const linear = extractPixels(img.data, img.width, img.height, img.colors, img.bits)

    let lens: string | undefined
    try {
      const li = await raw.getLensInfo()
      lens = li.lensName || undefined
    } catch {
      lens = undefined
    }
    onProgress?.(1, '解码完成')

    return {
      linear,
      width: img.width,
      height: img.height,
      isRaw: true,
      bitsPerSample: img.bits,
      degraded: false,
      camera: [md.make, md.model].filter(Boolean).join(' ') || undefined,
      cameraMake: md.make || undefined,
      cameraModel: md.model || undefined,
      profileId,
      profileName,
      profile: active,
      lens,
      iso: md.iso,
      aperture: md.aperture,
      shutterSpeed: md.shutterSpeed,
      focalLength: md.focalLength,
      capturedAt: md.timestamp
    }
  } finally {
    try {
      await raw.close()
    } catch {
      /* 忽略关闭异常 */
    }
  }
}

/** RAW 解码失败时回退到内嵌预览图，保证仍可继续编辑 */
async function decodeRawFallback(filePath: string, onProgress?: DecodeProgress): Promise<DecodeResult> {
  const { LibRaw } = await import('lightdrift-libraw')
  const raw = new LibRaw()
  try {
    onProgress?.(0.05, '读取 RAW 元数据…')
    await raw.loadFile(filePath)
    const md = await raw.getMetadata()
    onProgress?.(0.5, '提取内嵌预览图…')
    const thumb = await raw.createThumbnailJPEGBuffer({ width: 4096, quality: 95 })
    // 内嵌预览是 8 位 JPEG，必须用普通 raw() 读取；
    // toColourspace('rgb16') 与 raw({depth:'ushort'}) 不配对会得到全白数据。
    const decoded = await sharp(thumb.data, { limitInputPixels: false })
      .raw()
      .toBuffer({ resolveWithObject: true })
    const pixels = decoded.info.width * decoded.info.height
    return {
      linear: linearizeRgb8(decoded.data, pixels, decoded.info.channels),
      width: decoded.info.width,
      height: decoded.info.height,
      isRaw: true,
      bitsPerSample: 8,
      degraded: true,
      degradedReason: '该 RAW 文件无法完整解码，已改用内嵌预览图（分辨率与位深受限）',
      camera: [md.make, md.model].filter(Boolean).join(' ') || undefined,
      iso: md.iso,
      aperture: md.aperture,
      shutterSpeed: md.shutterSpeed,
      focalLength: md.focalLength,
      capturedAt: md.timestamp
    }
  } finally {
    try {
      await raw.close()
    } catch {
      /* 忽略关闭异常 */
    }
  }
}

export async function decodeImage(
  filePath: string,
  onProgress?: DecodeProgress,
  profile?: CameraProfile | null
): Promise<DecodeResult> {
  const ext = path.extname(filePath).toLowerCase()

  if (RAW_EXTENSIONS.includes(ext)) {
    try {
      return await decodeRaw(filePath, onProgress, profile)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      try {
        const fallback = await decodeRawFallback(filePath, onProgress)
        fallback.degradedReason = `${fallback.degradedReason}（原始错误：${reason}）`
        return fallback
      } catch {
        throw new Error(`无法解码 RAW 文件：${reason}`)
      }
    }
  }

  if (BMP_EXTENSIONS.includes(ext)) {
    onProgress?.(0.3, '解析 BMP 位图…')
    const r = await decodeBmpFile(filePath)
    onProgress?.(1, '解码完成')
    return r
  }
  onProgress?.(0.3, '解码图像…')
  const r = await decodeRaster(filePath)
  onProgress?.(1, '解码完成')
  return r
}

export async function decodeImageBuffer(
  name: string,
  data: Buffer
): Promise<DecodeResult> {
  const ext = path.extname(name).toLowerCase()
  if (BMP_EXTENSIONS.includes(ext)) {
    const { rgb, width, height } = decodeBmp(data)
    return {
      linear: linearizeRgb8(rgb, width * height, 3),
      width,
      height,
      isRaw: false,
      bitsPerSample: 8,
      degraded: false
    }
  }
  if (RAW_EXTENSIONS.includes(ext)) {
    throw new Error('拖拽导入 RAW 文件时请提供文件路径')
  }
  const pipeline = sharp(data, { limitInputPixels: false, unlimited: true, failOn: 'none' })
  const meta = await pipeline.metadata()
  const source16 = meta.depth === 'ushort'

  // 与 decodeRaster 保持一致：16 位源必须 toColourspace('rgb16') + raw({ depth: 'ushort' })
  const { data: pixels, info } = await (source16
    ? pipeline.toColourspace('rgb16').raw({ depth: 'ushort' })
    : pipeline.raw()
  ).toBuffer({ resolveWithObject: true })

  const count = info.width * info.height
  const channels = info.channels
  const is16 = source16 && pixels.length >= count * channels * 2
  const linear = is16
    ? linearizeRgb16(
        new Uint16Array(pixels.buffer, pixels.byteOffset, Math.floor(pixels.length / 2)),
        count,
        channels
      )
    : linearizeRgb8(pixels, count, channels)
  return {
    linear,
    width: info.width,
    height: info.height,
    isRaw: false,
    bitsPerSample: is16 ? 16 : 8,
    degraded: false
  }
}
