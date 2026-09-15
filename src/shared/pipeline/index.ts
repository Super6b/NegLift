import type { CropRect, EditParams, Histogram, TransformParams } from '../types'
import { LUM_B, LUM_G, LUM_R, clamp } from './color'
import { denoiseDisplay, isDenoiseActive } from './denoise'
import { applyGrading, applyHsl, buildGradeContext, buildHslContext } from './grade'
import { applyRepairStrokes, type CanvasRepairStroke } from './repair'
import { LUT_SIZE, bakeChannelLuts, buildToneContext } from './tone'

const DEG = Math.PI / 180

export interface GeometryInfo {
  /** 几何变换（旋转/翻转）后的完整画布尺寸 */
  transformedWidth: number
  transformedHeight: number
  /** 应用裁切后的最终输出尺寸 */
  outputWidth: number
  outputHeight: number
  cropX: number
  cropY: number
  cropW: number
  cropH: number
}

/** 原图像素坐标下的有效区域 */
export interface SourceArea {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 解析有效区域（排除片夹后的画面）为原图像素矩形。
 * 未设置有效区域时返回整幅图像。
 */
export function resolveValidArea(srcW: number, srcH: number, t: TransformParams): SourceArea {
  const v = t.validArea
  if (!v || v.w <= 1e-4 || v.h <= 1e-4) return { x: 0, y: 0, w: srcW, h: srcH }
  const x0 = clamp(Math.round(clamp(v.x, 0, 0.999) * srcW), 0, srcW - 1)
  const y0 = clamp(Math.round(clamp(v.y, 0, 0.999) * srcH), 0, srcH - 1)
  const x1 = clamp(Math.round((clamp(v.x, 0, 0.999) + clamp(v.w, 0.001, 1)) * srcW), x0 + 1, srcW)
  const y1 = clamp(Math.round((clamp(v.y, 0, 0.999) + clamp(v.h, 0.001, 1)) * srcH), y0 + 1, srcH)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** 计算几何变换后的尺寸与裁切像素范围 */
export function computeGeometry(srcW: number, srcH: number, t: TransformParams): GeometryInfo {
  const area = resolveValidArea(srcW, srcH, t)
  const a = (t.rotate90 * 90 + t.angle) * DEG
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const transformedWidth = Math.max(1, Math.round(Math.abs(area.w * cos) + Math.abs(area.h * sin)))
  const transformedHeight = Math.max(1, Math.round(Math.abs(area.w * sin) + Math.abs(area.h * cos)))

  let cropX = 0
  let cropY = 0
  let cropW = transformedWidth
  let cropH = transformedHeight
  const crop = t.crop
  if (crop && crop.w > 1e-4 && crop.h > 1e-4) {
    cropX = clamp(Math.round(crop.x * transformedWidth), 0, transformedWidth - 1)
    cropY = clamp(Math.round(crop.y * transformedHeight), 0, transformedHeight - 1)
    cropW = clamp(Math.round(crop.w * transformedWidth), 1, transformedWidth - cropX)
    cropH = clamp(Math.round(crop.h * transformedHeight), 1, transformedHeight - cropY)
  }

  return { transformedWidth, transformedHeight, outputWidth: cropW, outputHeight: cropH, cropX, cropY, cropW, cropH }
}

/** 把 (u, v) 反查为原图归一化坐标；area 为有效区域，缺省整幅图像 */
function inverseMap(
  u: number,
  v: number,
  srcW: number,
  srcH: number,
  t: TransformParams,
  regionX: number,
  regionY: number,
  regionW: number,
  regionH: number,
  transformedWidth: number,
  transformedHeight: number,
  area: SourceArea
): [number, number] {
  const tx = regionX + clamp(u, 0, 1) * regionW
  const ty = regionY + clamp(v, 0, 1) * regionH

  const a = (t.rotate90 * 90 + t.angle) * DEG
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const dx = tx - transformedWidth / 2
  const dy = ty - transformedHeight / 2
  let lx = cos * dx + sin * dy + area.w / 2
  let ly = -sin * dx + cos * dy + area.h / 2
  if (t.flipH) lx = area.w - lx
  if (t.flipV) ly = area.h - ly

  return [clamp((area.x + lx) / srcW, 0, 1), clamp((area.y + ly) / srcH, 0, 1)]
}

/**
 * 把「输出区域」内的归一化坐标 (u, v) 反查回原始图像上的归一化坐标。
 * 用于吸管取样：用户点击的是旋转/裁切之后的画面，取色需要回到原图。
 */
export function regionToSource(
  u: number,
  v: number,
  srcW: number,
  srcH: number,
  t: TransformParams,
  applyCrop = true
): [number, number] {
  const geo = computeGeometry(srcW, srcH, t)
  const area = resolveValidArea(srcW, srcH, t)
  return inverseMap(
    u,
    v,
    srcW,
    srcH,
    t,
    applyCrop ? geo.cropX : 0,
    applyCrop ? geo.cropY : 0,
    applyCrop ? geo.cropW : geo.transformedWidth,
    applyCrop ? geo.cropH : geo.transformedHeight,
    geo.transformedWidth,
    geo.transformedHeight,
    area
  )
}

/**
 * `regionToSource` 的正向映射：把原图归一化坐标投影到当前输出区域的归一化坐标。
 *
 * 排除区域以原图坐标存储（这样不会随裁切、旋转漂移），画到预览上时需要这个
 * 正向映射；两个方向共用同一套几何定义，保证标记与画面严格对齐。
 */
export function sourceToRegion(
  su: number,
  sv: number,
  srcW: number,
  srcH: number,
  t: TransformParams,
  applyCrop = true
): [number, number] {
  const geo = computeGeometry(srcW, srcH, t)
  const area = resolveValidArea(srcW, srcH, t)
  const a = (t.rotate90 * 90 + t.angle) * DEG
  const cos = Math.cos(a)
  const sin = Math.sin(a)

  let lx = clamp(su, 0, 1) * srcW - area.x
  let ly = clamp(sv, 0, 1) * srcH - area.y
  if (t.flipH) lx = area.w - lx
  if (t.flipV) ly = area.h - ly

  const u = lx - area.w / 2
  const v = ly - area.h / 2
  const tx = cos * u - sin * v + geo.transformedWidth / 2
  const ty = sin * u + cos * v + geo.transformedHeight / 2

  const regionX = applyCrop ? geo.cropX : 0
  const regionY = applyCrop ? geo.cropY : 0
  const regionW = applyCrop ? geo.cropW : geo.transformedWidth
  const regionH = applyCrop ? geo.cropH : geo.transformedHeight
  return [(tx - regionX) / regionW, (ty - regionY) / regionH]
}

/**
 * 计算自动检测（片基 / 通道对齐）应采样的原图归一化区域：
 * 「有效区域 ∩ 裁切区域」，裁切区域取四角反查后的包围盒。
 * 结果覆盖整幅画面时返回 null。
 */
export function detectionRegion(srcW: number, srcH: number, t: TransformParams): CropRect | null {
  const area = resolveValidArea(srcW, srcH, t)
  let x0 = area.x / srcW
  let y0 = area.y / srcH
  let x1 = (area.x + area.w) / srcW
  let y1 = (area.y + area.h) / srcH

  const crop = t.crop
  if (crop && crop.w > 1e-4 && crop.h > 1e-4) {
    const corners: [number, number][] = [
      [crop.x, crop.y],
      [crop.x + crop.w, crop.y],
      [crop.x, crop.y + crop.h],
      [crop.x + crop.w, crop.y + crop.h]
    ]
    let cx0 = 1
    let cy0 = 1
    let cx1 = 0
    let cy1 = 0
    for (const [u, v] of corners) {
      const [su, sv] = regionToSource(u, v, srcW, srcH, t, false)
      if (su < cx0) cx0 = su
      if (sv < cy0) cy0 = sv
      if (su > cx1) cx1 = su
      if (sv > cy1) cy1 = sv
    }
    x0 = Math.max(x0, cx0)
    y0 = Math.max(y0, cy0)
    x1 = Math.min(x1, cx1)
    y1 = Math.min(y1, cy1)
  }

  if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return null
  if (x0 <= 0.001 && y0 <= 0.001 && x1 >= 0.999 && y1 >= 0.999) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export interface RenderOptions {
  /** 是否应用裁切，裁切编辑时需要看到未裁切的完整画面 */
  applyCrop?: boolean
  /** 输出缩放比例（1 = 完整输出尺寸），用于拖动过程中的快速预览 */
  scale?: number
  /** 是否统计直方图 */
  histogram?: boolean
}

export interface RenderResult {
  /** 显示域 RGB 交错数据，0..65535 */
  data: Uint16Array
  width: number
  height: number
  geometry: GeometryInfo
  histogram?: Histogram
}

function lookup16(lut: Float32Array, v: number): number {
  const p = v * (LUT_SIZE / 65535)
  const i = p | 0
  if (i >= LUT_SIZE) return lut[LUT_SIZE]
  return lut[i] + (lut[i + 1] - lut[i]) * (p - i)
}

/** 缩小渲染用的源图缓存（同一源 + 同一倍率的降采样结果只算一次） */
let shrinkCache: { src: Uint16Array; factor: number; width: number; height: number; data: Uint16Array } | null = null

/**
 * 缩小渲染前把源图做整数倍盒降采样。
 *
 * 每个输出像素在源图上覆盖 `1/scale` 个像素，若只做双线性采样（4 个像素），
 * 噪声几乎不会被平均掉，缩小后的画面会明显偏噪。先按整数倍做一次盒平均，
 * 剩下的不到 2× 的缩量再交给双线性，即可得到接近面积平均的结果。
 *
 * 返回的 `width/height` 是降采样后的尺寸，`scale` 是放大后仍能得到相同输出尺寸的缩放比。
 */
function shrinkSource(
  src: Uint16Array,
  srcW: number,
  srcH: number,
  scale: number
): { data: Uint16Array; width: number; height: number; scale: number } {
  if (scale >= 0.5) return { data: src, width: srcW, height: srcH, scale }
  const factor = Math.min(16, Math.max(2, Math.round(1 / scale)))
  const dw = Math.max(1, Math.round(srcW / factor))
  const dh = Math.max(1, Math.round(srcH / factor))
  if (dw >= srcW || dh >= srcH) return { data: src, width: srcW, height: srcH, scale }

  if (!shrinkCache || shrinkCache.src !== src || shrinkCache.factor !== factor) {
    shrinkCache = {
      src,
      factor,
      width: dw,
      height: dh,
      data: downsampleLinear(src, srcW, srcH, dw, dh)
    }
  }
  return {
    data: shrinkCache.data,
    width: shrinkCache.width,
    height: shrinkCache.height,
    scale: scale * (srcW / shrinkCache.width)
  }
}

/**
 * 对线性 RGB 数据执行完整调色 + 几何变换。
 *
 * 几何采样与调色在同一次遍历中完成：先在**线性光域**做双线性插值，
 * 再对该像素执行一次色调链。这样预览与导出共用完全相同的代码路径，
 * 且只需为输出分配内存。
 */
export function renderLinear(
  src: Uint16Array,
  srcW: number,
  srcH: number,
  params: EditParams,
  opts: RenderOptions = {}
): RenderResult {
  const applyCrop = opts.applyCrop ?? true
  const scale = clamp(opts.scale ?? 1, 0.05, 1)

  // 缩小渲染时先做整数倍盒降采样：否则每个输出像素只取 4 个源像素，
  // 噪声几乎不会被平均掉，缩小后的画面会显得很噪。
  const shrunk = shrinkSource(src, srcW, srcH, scale)
  const buf = shrunk.data
  const bufW = shrunk.width
  const bufH = shrunk.height

  // 输出尺寸始终按「原始分辨率 × 请求缩放」计算，
  // 避免降采样的取整误差让预览与导出的尺寸差 1 像素
  const fullGeo = computeGeometry(srcW, srcH, params.transform)
  const t = params.transform
  const fullRegionW = applyCrop ? fullGeo.cropW : fullGeo.transformedWidth
  const fullRegionH = applyCrop ? fullGeo.cropH : fullGeo.transformedHeight
  const ow = Math.max(1, Math.round(fullRegionW * scale))
  const oh = Math.max(1, Math.round(fullRegionH * scale))

  const geo = computeGeometry(bufW, bufH, t)

  const regionX = applyCrop ? geo.cropX : 0
  const regionY = applyCrop ? geo.cropY : 0
  const regionW = applyCrop ? geo.cropW : geo.transformedWidth
  const regionH = applyCrop ? geo.cropH : geo.transformedHeight

  const ctx = buildToneContext(params)
  const luts = bakeChannelLuts(ctx)
  const lutR = luts[0]
  const lutG = luts[1]
  const lutB = luts[2]

  const satAmount = params.basic.saturation / 100
  const vibAmount = params.basic.vibrance / 100
  const applySat = satAmount !== 0 || vibAmount !== 0

  const hslCtx = buildHslContext(params.hsl)
  const gradeCtx = buildGradeContext(params.grading)
  const applyAdvanced = hslCtx.active || gradeCtx.active
  const scratch = new Float32Array(3)

  const out = new Uint16Array(ow * oh * 3)
  const wantHist = opts.histogram === true

  const a = (t.rotate90 * 90 + t.angle) * DEG
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const area = resolveValidArea(bufW, bufH, t)
  const areaIsFull = area.x === 0 && area.y === 0 && area.w === bufW && area.h === bufH
  const tW = geo.transformedWidth
  const tH = geo.transformedHeight
  const halfW = tW / 2
  const halfH = tH / 2
  const halfAreaW = area.w / 2
  const halfAreaH = area.h / 2
  const stepX = regionW / ow
  const stepY = regionH / oh

  const identityMap =
    t.rotate90 === 0 &&
    t.angle === 0 &&
    !t.flipH &&
    !t.flipV &&
    areaIsFull &&
    tW === bufW &&
    tH === bufH &&
    Math.abs(stepX - 1) < 1e-9 &&
    Math.abs(stepY - 1) < 1e-9

  let o = 0
  for (let oy = 0; oy < oh; oy++) {
    const ty = regionY + (oy + 0.5) * stepY
    for (let ox = 0; ox < ow; ox++) {
      let r = 0
      let g = 0
      let b = 0

      if (identityMap) {
        const sx = (regionX + ox) | 0
        const sy = (ty | 0) < 0 ? 0 : ty | 0
        const si = (sy * bufW + sx) * 3
        r = buf[si]
        g = buf[si + 1]
        b = buf[si + 2]
      } else {
        const tx = regionX + (ox + 0.5) * stepX
        const dx = tx - halfW
        const dy = ty - halfH
        let lx = cos * dx + sin * dy + halfAreaW
        let ly = -sin * dx + cos * dy + halfAreaH
        if (t.flipH) lx = area.w - lx
        if (t.flipV) ly = area.h - ly
        const sx = area.x + lx
        const sy = area.y + ly

        const px = sx - 0.5
        const py = sy - 0.5
        const x0 = Math.floor(px)
        const y0 = Math.floor(py)
        const fx = px - x0
        const fy = py - y0
        const x1 = x0 + 1
        const y1 = y0 + 1
        const w00 = (1 - fx) * (1 - fy)
        const w10 = fx * (1 - fy)
        const w01 = (1 - fx) * fy
        const w11 = fx * fy

        if (x0 >= 0 && x0 < bufW && y0 >= 0 && y0 < bufH) {
          const si = (y0 * bufW + x0) * 3
          r += buf[si] * w00
          g += buf[si + 1] * w00
          b += buf[si + 2] * w00
        }
        if (x1 >= 0 && x1 < bufW && y0 >= 0 && y0 < bufH) {
          const si = (y0 * bufW + x1) * 3
          r += buf[si] * w10
          g += buf[si + 1] * w10
          b += buf[si + 2] * w10
        }
        if (x0 >= 0 && x0 < bufW && y1 >= 0 && y1 < bufH) {
          const si = (y1 * bufW + x0) * 3
          r += buf[si] * w01
          g += buf[si + 1] * w01
          b += buf[si + 2] * w01
        }
        if (x1 >= 0 && x1 < bufW && y1 >= 0 && y1 < bufH) {
          const si = (y1 * bufW + x1) * 3
          r += buf[si] * w11
          g += buf[si + 1] * w11
          b += buf[si + 2] * w11
        }
      }

      let R = lookup16(lutR, r)
      let G = lookup16(lutG, g)
      let B = lookup16(lutB, b)

      if (applySat) {
        const lum = LUM_R * R + LUM_G * G + LUM_B * B
        const mx = R > G ? (R > B ? R : B) : G > B ? G : B
        const mn = R < G ? (R < B ? R : B) : G < B ? G : B
        const sat = mx <= 1e-6 ? 0 : (mx - mn) / mx
        const f = 1 + satAmount + vibAmount * (1 - sat) * 0.8
        R = lum + (R - lum) * f
        G = lum + (G - lum) * f
        B = lum + (B - lum) * f
      }

      if (applyAdvanced) {
        if (hslCtx.active) {
          applyHsl(R, G, B, hslCtx, scratch)
          R = scratch[0]
          G = scratch[1]
          B = scratch[2]
        }
        if (gradeCtx.active) {
          applyGrading(R, G, B, gradeCtx, scratch)
          R = scratch[0]
          G = scratch[1]
          B = scratch[2]
        }
      }

      const R16 = (clamp(R, 0, 1) * 65535 + 0.5) | 0
      const G16 = (clamp(G, 0, 1) * 65535 + 0.5) | 0
      const B16 = (clamp(B, 0, 1) * 65535 + 0.5) | 0
      out[o++] = R16
      out[o++] = G16
      out[o++] = B16
    }
  }

  // 降噪必须作用在最终像素上；直方图也要基于降噪后的结果统计
  if (isDenoiseActive(params.denoise)) denoiseDisplay(out, ow, oh, params.denoise)

  // 除尘：去色罩/调色/降噪之后的显示域，按整段笔触一次修补
  if (params.repairs && params.repairs.length > 0) {
    const canvasStrokes: CanvasRepairStroke[] = []
    const longEdgeSrc = Math.max(srcW, srcH)
    for (const st of params.repairs) {
      if (!st.points?.length || st.r <= 0) continue
      const pts: { x: number; y: number }[] = []
      for (const p of st.points) {
        const [u, v] = sourceToRegion(p.x, p.y, srcW, srcH, t, applyCrop)
        if (u < -0.15 || v < -0.15 || u > 1.15 || v > 1.15) continue
        pts.push({ x: u * ow, y: v * oh })
      }
      if (pts.length === 0) continue
      canvasStrokes.push({
        points: pts,
        r: Math.max(2, st.r * longEdgeSrc * scale),
        strength: st.strength ?? 1
      })
    }
    applyRepairStrokes(out, ow, oh, canvasStrokes)
  }

  return { data: out, width: ow, height: oh, geometry: geo, histogram: wantHist ? buildHistogram(out, ow, oh) : undefined }
}

/** 统计 256 级直方图（在降噪之后调用，保证与画面一致） */
function buildHistogram(data: Uint16Array, width: number, height: number): Histogram {
  const hist: Histogram = {
    r: new Array<number>(256).fill(0),
    g: new Array<number>(256).fill(0),
    b: new Array<number>(256).fill(0),
    l: new Array<number>(256).fill(0)
  }
  const pixels = width * height
  for (let i = 0, o = 0; i < pixels; i++, o += 3) {
    const r = data[o] >> 8
    const g = data[o + 1] >> 8
    const b = data[o + 2] >> 8
    hist.r[r]++
    hist.g[g]++
    hist.b[b]++
    hist.l[(LUM_R * r + LUM_G * g + LUM_B * b) | 0]++
  }
  return hist
}

/** 将显示域结果转换为 RGBA8，供 Canvas ImageData 使用 */
export function toRgba8(result: RenderResult, target?: Uint8ClampedArray): Uint8ClampedArray {
  const n = result.width * result.height
  const dst = target && target.length >= n * 4 ? target : new Uint8ClampedArray(n * 4)
  const src = result.data
  for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
    dst[d] = src[s] >> 8
    dst[d + 1] = src[s + 1] >> 8
    dst[d + 2] = src[s + 2] >> 8
    dst[d + 3] = 255
  }
  return dst
}

/** 将显示域结果转换为 16bit RGB，用于高精度导出 */
export function toRgb16(result: RenderResult): Uint16Array {
  return result.data
}

/** 把线性 Uint16 预览数据转换为 8bit RGBA（不做任何调色，用于「原片」对比） */
export function linearToRgba8(src: Uint16Array, width: number, height: number): Uint8ClampedArray {
  const n = width * height
  const dst = new Uint8ClampedArray(n * 4)
  for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
    dst[d] = src[s] >> 8
    dst[d + 1] = src[s + 1] >> 8
    dst[d + 2] = src[s + 2] >> 8
    dst[d + 3] = 255
  }
  return dst
}

/**
 * 小尺寸抽样副本，仅用于统计类分析（片基 / 通道对齐 / 片夹识别）。
 *
 * 全尺寸预览（数千万像素）逐通道扫描一次就要一秒级，这里按块中心抽样到
 * 指定长边以内：代价只与输出尺寸有关，且对分位数统计不产生偏差。
 */
export function decimateLinear(
  src: Uint16Array,
  srcW: number,
  srcH: number,
  maxEdge: number
): { data: Uint16Array; width: number; height: number } {
  const longEdge = Math.max(srcW, srcH)
  if (longEdge <= maxEdge) return { data: src, width: srcW, height: srcH }
  const ratio = longEdge / maxEdge
  const dw = Math.max(1, Math.round(srcW / ratio))
  const dh = Math.max(1, Math.round(srcH / ratio))
  const out = new Uint16Array(dw * dh * 3)
  const stepX = srcW / dw
  const stepY = srcH / dh
  let d = 0
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y + 0.5) * stepY))
    const row = sy * srcW
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x + 0.5) * stepX))
      const s = (row + sx) * 3
      out[d++] = src[s]
      out[d++] = src[s + 1]
      out[d++] = src[s + 2]
    }
  }
  return { data: out, width: dw, height: dh }
}

/** 对线性预览图做盒式降采样（保持线性光域，避免出现灰边/暗边） */
export function downsampleLinear(
  src: Uint16Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Uint16Array {
  if (dstW === srcW && dstH === srcH) return src
  const out = new Uint16Array(dstW * dstH * 3)
  const xRatio = srcW / dstW
  const yRatio = srcH / dstH
  const maxX = srcW - 1
  const maxY = srcH - 1

  for (let y = 0; y < dstH; y++) {
    const sy0 = Math.min(maxY, Math.floor(y * yRatio))
    const sy1 = Math.max(sy0 + 1, Math.min(srcH, Math.ceil((y + 1) * yRatio)))
    for (let x = 0; x < dstW; x++) {
      const sx0 = Math.min(maxX, Math.floor(x * xRatio))
      const sx1 = Math.max(sx0 + 1, Math.min(srcW, Math.ceil((x + 1) * xRatio)))
      let r = 0
      let g = 0
      let b = 0
      let count = 0
      for (let sy = sy0; sy < sy1; sy++) {
        let si = (sy * srcW + sx0) * 3
        for (let sx = sx0; sx < sx1; sx++) {
          r += src[si]
          g += src[si + 1]
          b += src[si + 2]
          si += 3
          count++
        }
      }
      const di = (y * dstW + x) * 3
      out[di] = (r / count + 0.5) | 0
      out[di + 1] = (g / count + 0.5) | 0
      out[di + 2] = (b / count + 0.5) | 0
    }
  }
  return out
}
