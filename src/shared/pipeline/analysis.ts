import type { CropRect, DetectResult, HolderScanDirection, NegativeMode, Vec3 } from '../types'
import { LUM_B, LUM_G, LUM_R, clamp } from './color'

const BINS = 4096

/** 归一化区域 -> 像素范围；region 为 null 时覆盖整幅图像 */
interface PixelRange {
  x0: number
  y0: number
  x1: number
  y1: number
}

function pixelRange(region: CropRect | null | undefined, width: number, height: number): PixelRange {
  if (!region || region.w <= 1e-4 || region.h <= 1e-4) {
    return { x0: 0, y0: 0, x1: width, y1: height }
  }
  const x0 = clamp(Math.floor(region.x * width), 0, width - 1)
  const y0 = clamp(Math.floor(region.y * height), 0, height - 1)
  const x1 = clamp(Math.ceil((region.x + region.w) * width), x0 + 1, width)
  const y1 = clamp(Math.ceil((region.y + region.h) * height), y0 + 1, height)
  return { x0, y0, x1, y1 }
}

/** 把归一化的排除区域批量换算成像素范围，便于逐像素快速判断 */
function excludeRanges(areas: CropRect[] | null | undefined, width: number, height: number): PixelRange[] {
  if (!areas || areas.length === 0) return []
  const out: PixelRange[] = []
  for (const a of areas) {
    if (!a || a.w <= 1e-4 || a.h <= 1e-4) continue
    out.push(pixelRange(a, width, height))
  }
  return out
}

/** 该像素是否落在任一排除区域内 */
function isExcluded(ranges: PixelRange[], x: number, y: number): boolean {
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]
    if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) return true
  }
  return false
}

function percentileFromHistogram(hist: Uint32Array, total: number, fraction: number): number {
  const target = total * fraction
  let acc = 0
  for (let i = 0; i < BINS; i++) {
    acc += hist[i]
    if (acc >= target) return (i + 0.5) / BINS
  }
  return 1
}

/**
 * 自动检测片基（色罩）颜色。
 *
 * 负片未曝光处的透射率最高，因此取每通道的高分位数作为片基估计。
 * 使用 99.7% 分位而非最大值，避免灰尘、划痕与高光过曝点干扰。
 * `region` 用于限定统计范围（例如排除翻拍片夹后的有效画面）。
 */
export function detectFilmBase(
  lin: Uint16Array,
  width: number,
  height: number,
  fraction = 0.997,
  region?: CropRect | null,
  exclude?: CropRect[] | null
): Vec3 {
  const hist = [new Uint32Array(BINS), new Uint32Array(BINS), new Uint32Array(BINS)]
  const { x0, y0, x1, y1 } = pixelRange(region, width, height)
  const skip = excludeRanges(exclude, width, height)
  let counted = 0

  for (let y = y0; y < y1; y++) {
    let o = (y * width + x0) * 3
    for (let x = x0; x < x1; x++, o += 3) {
      if (skip.length > 0 && isExcluded(skip, x, y)) continue
      const r = lin[o]
      const g = lin[o + 1]
      const b = lin[o + 2]
      if (r === 0 && g === 0 && b === 0) continue
      hist[0][Math.min(BINS - 1, r >> 4)]++
      hist[1][Math.min(BINS - 1, g >> 4)]++
      hist[2][Math.min(BINS - 1, b >> 4)]++
      counted++
    }
  }

  if (counted === 0) return [0.7, 0.5, 0.3]

  return [
    clamp(percentileFromHistogram(hist[0], counted, fraction), 0.02, 1),
    clamp(percentileFromHistogram(hist[1], counted, fraction), 0.02, 1),
    clamp(percentileFromHistogram(hist[2], counted, fraction), 0.02, 1)
  ]
}

/**
 * tRef（白场参考）的分位点。
 *
 * tRef 必须代表「最密的一片区域」，而不是「最密的那个像素」。原先取 0.05% 分位，
 * 在真实样片上会落进片基近黑的死像素里，实测同一批 9 张中 tRef 在 0.005~0.078
 * 之间乱跳，白场跨度 51~1936（38 倍）——出图要么近全黑要么正常，完全不可预期。
 *
 * 取 2%（分析副本上约 1.7 万像素，是真正的一片区域）后，同一批样片出图中位亮度
 * 由 0.049 提升到 0.187、最暗由 0.002 提升到 0.037、张间极差由 53.8 倍收敛到
 * 10.7 倍；四分位差（对比度）同时由 0.054 升到 0.189，因为原先过低的 tRef 把
 * 整个中间调压进了显示曲线的近黑段。
 */
const TREF_FRACTION = 0.02
/** tRef 下限：兜底防止异常样片把白场推到数千倍、画面压成全黑 */
const TREF_MIN = 0.01

/**
 * 估计参考最小透射率 tRef，即画面中最亮区域（负片上最密的部分）相对片基的比例。
 * 取较低分位（见 TREF_FRACTION）以靠近最密的一端，同时对个别死黑像素保持鲁棒。
 */
export function detectTRef(
  lin: Uint16Array,
  width: number,
  height: number,
  base: Vec3,
  fraction = TREF_FRACTION,
  region?: CropRect | null,
  exclude?: CropRect[] | null
): number {
  const hist = new Uint32Array(BINS)
  const { x0, y0, x1, y1 } = pixelRange(region, width, height)
  const skip = excludeRanges(exclude, width, height)
  let counted = 0

  for (let y = y0; y < y1; y++) {
    let o = (y * width + x0) * 3
    for (let x = x0; x < x1; x++, o += 3) {
      if (skip.length > 0 && isExcluded(skip, x, y)) continue
      const tr = lin[o] / 65535 / base[0]
      const tg = lin[o + 1] / 65535 / base[1]
      const tb = lin[o + 2] / 65535 / base[2]
      const t = Math.min(tr, tg, tb)
      hist[Math.min(BINS - 1, Math.max(0, (t * BINS) | 0))]++
      counted++
    }
  }

  if (counted === 0) return 0.06
  // 近零透射率几乎只来自片框黑边 / 死像素 / 漏光遮挡，不是「最密的一片画面」。
  // 残留一条黑边就可能让 2% 分位落在 t≈0，白场被推到数千倍、整图压黑，
  // 因此先丢掉最暗的 bin，再在剩余像素上取分位。
  const skipBins = Math.max(1, Math.floor(BINS * 0.01))
  let usable = 0
  for (let i = skipBins; i < BINS; i++) usable += hist[i]
  if (usable === 0) return 0.06
  const target = usable * fraction
  let acc = 0
  for (let i = skipBins; i < BINS; i++) {
    acc += hist[i]
    if (acc >= target) return clamp((i + 0.5) / BINS, TREF_MIN, 0.4)
  }
  return 0.06
}

/**
 * 通道对齐：统计有效区域内每通道的黑场（低分位）与白场（高分位）线性值。
 *
 * 用于画面中**没有片基**可参考的场景：把每通道的暗部对齐到 0、亮部对齐到 1，
 * 即可消除色罩带来的整体偏色，之后再按 1-t 反色得到正像。
 */
export function detectChannelAlign(
  lin: Uint16Array,
  width: number,
  height: number,
  region?: CropRect | null,
  blackFraction = 0.002,
  whiteFraction = 0.002,
  exclude?: CropRect[] | null
): { black: Vec3; white: Vec3 } {
  const hist = [new Uint32Array(BINS), new Uint32Array(BINS), new Uint32Array(BINS)]
  const { x0, y0, x1, y1 } = pixelRange(region, width, height)
  const skip = excludeRanges(exclude, width, height)
  let counted = 0

  for (let y = y0; y < y1; y++) {
    let o = (y * width + x0) * 3
    for (let x = x0; x < x1; x++, o += 3) {
      if (skip.length > 0 && isExcluded(skip, x, y)) continue
      hist[0][Math.min(BINS - 1, lin[o] >> 4)]++
      hist[1][Math.min(BINS - 1, lin[o + 1] >> 4)]++
      hist[2][Math.min(BINS - 1, lin[o + 2] >> 4)]++
      counted++
    }
  }

  if (counted === 0) return { black: [0, 0, 0], white: [1, 1, 1] }

  const black: number[] = []
  const white: number[] = []
  for (let c = 0; c < 3; c++) {
    const lo = percentileFromHistogram(hist[c], counted, blackFraction)
    const hi = percentileFromHistogram(hist[c], counted, 1 - whiteFraction)
    black[c] = clamp(lo, 0, 0.95)
    white[c] = clamp(Math.max(hi, black[c] + 0.01), 0.02, 1)
  }
  return { black: black as Vec3, white: white as Vec3 }
}

/**
 * 片夹识别参数（基于 raw pic 真实翻拍样片标定）。
 *
 * 真实片夹/片框黑边在扫描数据里是**近黑且中性**的（均值约 0.000~0.005），
 * 画面内容则带有负片片基的橙色且明显更亮（均值多在 0.03 以上）。
 * 薄薄一条残留黑边就会把 tRef 的低分位拉到接近 0，导致整图白场崩掉，
 * 因此宁可略微多裁一点过渡带，也不能把黑边留在统计范围内。
 */
/** 近黑像素的亮度门槛：低于此视为片夹/齿孔/片框 */
const HOLDER_NEAR_BLACK = 0.008
/** 片基橙色判据：R 明显高于 B，且 R 不过暗 */
const HOLDER_ORANGE_R_B = 1.45
const HOLDER_ORANGE_R_MIN = 350
/**
 * 片夹厚度的上限（占该边长度比例）。真实翻拍片夹约 1%~6%，
 * 超过说明该边其实是画面内容（或严重倾斜），交给用户手动调。
 */
const HOLDER_MAX_INSET = 0.1
/**
 * 判定边界后额外多裁的保险量（占该边长度比例），用于吃掉软过渡带。
 * 只加在确实识别出片夹的边上，避免无片夹画面被裁一圈。
 */
const HOLDER_SAFETY = 0.01
/** 边界扫描时「连续为画面」的最小长度（占该边比例），抑制单条亮线误判 */
const HOLDER_RUN = 0.006
/** 内部参考亮度取样的中央区间 */
const HOLDER_INTERIOR_LO = 0.2
const HOLDER_INTERIOR_HI = 0.8

/** 取 1D 数组的中位数（不修改入参） */
function medianOf(arr: number[]): number {
  if (arr.length === 0) return 0
  const a = arr.slice().sort((x, y) => x - y)
  return a[a.length >> 1]
}

/**
 * 像素是否像「负片画面内容」：非近黑，且带有片基橙色（或至少非中性偏亮）。
 * 片框黑边三通道同时接近 0，不会满足该判据。
 */
function isFilmContentPixel(r: number, g: number, b: number): boolean {
  const L = LUM_R * r + LUM_G * g + LUM_B * b
  if (L < HOLDER_NEAR_BLACK * 65535) return false
  // 强橙色片基
  if (r > b * HOLDER_ORANGE_R_B && r > HOLDER_ORANGE_R_MIN) return true
  // 仍要求有一定亮度，纯黑边不会进来；中性暗内容不因缺橙色被误判成片夹
  return L > HOLDER_NEAR_BLACK * 65535 * 1.5
}

/**
 * 构建沿某轴的两条剖面：
 * - mean：该行/列平均亮度
 * - content：该行/列中「像画面内容」的像素比例
 */
function buildEdgeProfiles(
  lin: Uint16Array,
  width: number,
  height: number,
  axis: 'row' | 'col'
): { mean: Float64Array; content: Float64Array } {
  const outer = axis === 'row' ? height : width
  const inner = axis === 'row' ? width : height
  const mean = new Float64Array(outer)
  const content = new Float64Array(outer)
  for (let i = 0; i < outer; i++) {
    let sum = 0
    let hit = 0
    for (let j = 0; j < inner; j++) {
      const o = axis === 'row' ? (i * width + j) * 3 : (j * width + i) * 3
      const r = lin[o]
      const g = lin[o + 1]
      const b = lin[o + 2]
      sum += (LUM_R * r + LUM_G * g + LUM_B * b) / 65535
      if (isFilmContentPixel(r, g, b)) hit++
    }
    mean[i] = sum / inner
    content[i] = hit / inner
  }
  return { mean, content }
}

/** 3 点滑动平均，柔化单像素毛刺 */
function smoothProfile(p: Float64Array): Float64Array {
  const n = p.length
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = p[Math.max(0, i - 1)]
    const b = p[i]
    const c = p[Math.min(n - 1, i + 1)]
    out[i] = (a + b + c) / 3
  }
  return out
}

/** 估计划面内部参考水平与内容/亮度门槛，供内外两种扫描共用 */
interface BorderThresholds {
  interior: number
  interiorContent: number
  contentThr: number
  lumaThr: number
  /** 该边看起来没有片夹（外缘不暗于内部） */
  looksOpen: boolean
}

function measureThresholds(
  mean: Float64Array,
  content: Float64Array,
  fromStart: boolean
): BorderThresholds {
  const n = mean.length
  const lo = Math.floor(n * HOLDER_INTERIOR_LO)
  const hi = Math.floor(n * HOLDER_INTERIOR_HI)
  const interiorSamples: number[] = []
  const contentSamples: number[] = []
  for (let i = lo; i < hi; i++) {
    interiorSamples.push(mean[i])
    contentSamples.push(content[i])
  }
  const interior = medianOf(interiorSamples)
  const interiorContent = medianOf(contentSamples)
  if (interior <= 1e-6) {
    return { interior: 0, interiorContent: 0, contentThr: 0.7, lumaThr: HOLDER_NEAR_BLACK, looksOpen: true }
  }

  // 外缘水平：取最外约 1% 的 25 分位，更贴着真正的黑边底色
  const outerN = Math.max(3, Math.floor(n * 0.012))
  const outerMean: number[] = []
  const outerContent: number[] = []
  for (let k = 0; k < outerN; k++) {
    const i = fromStart ? k : n - 1 - k
    outerMean.push(mean[i])
    outerContent.push(content[i])
  }
  outerMean.sort((a, b) => a - b)
  outerContent.sort((a, b) => a - b)
  const edgeMean = outerMean[Math.floor((outerMean.length - 1) * 0.25)]
  const edgeContent = outerContent[Math.floor((outerContent.length - 1) * 0.25)]
  const darkestMean = outerMean[0]

  const looksOpen =
    edgeMean > interior * 0.5 && edgeContent > interiorContent * 0.75 && darkestMean > HOLDER_NEAR_BLACK * 1.5

  const contentThr = Math.min(0.7, Math.max(0.4, edgeContent + (interiorContent - edgeContent) * 0.4))
  const lumaThr = Math.max(HOLDER_NEAR_BLACK * 0.75, edgeMean + (interior - edgeMean) * 0.3)
  return { interior, interiorContent, contentThr, lumaThr, looksOpen }
}

/**
 * 从外向内：从该边外缘走向中心，找到第一段持续为「画面内容」的位置。
 */
function findBorderInsetInward(
  mean: Float64Array,
  content: Float64Array,
  fromStart: boolean,
  maxInset: number
): number {
  const n = mean.length
  const run = Math.max(3, Math.floor(n * HOLDER_RUN))
  const th = measureThresholds(mean, content, fromStart)
  if (th.looksOpen) return 0

  for (let i = 0; i <= maxInset; i++) {
    let ok = 0
    for (let k = 0; k < run; k++) {
      const idx = fromStart ? i + k : n - 1 - i - k
      if (idx < 0 || idx >= n) break
      if (content[idx] >= th.contentThr && mean[idx] >= th.lumaThr) ok++
    }
    if (ok >= run) return i
  }
  return maxInset
}

/**
 * 从中心向边缘：沿剖面从中心走向该边，内容终止且随后一路偏向片夹时，
 * 把终止处记为片夹内边界（inset = 该点到外缘的距离）。
 *
 * 适合画面内容一直铺到片框附近、而外圈才是均匀黑边的翻拍。
 */
function findBorderInsetOutward(
  mean: Float64Array,
  content: Float64Array,
  fromStart: boolean,
  maxInset: number
): number {
  const n = mean.length
  const run = Math.max(3, Math.floor(n * HOLDER_RUN))
  const th = measureThresholds(mean, content, fromStart)
  if (th.looksOpen) return 0

  const isContent = (i: number): boolean =>
    content[i] >= th.contentThr && mean[i] >= th.lumaThr

  const center = n >> 1
  const step = fromStart ? -1 : 1
  let lastContent = -1

  for (let i = center; fromStart ? i >= 0 : i < n; i += step) {
    if (isContent(i)) {
      lastContent = i
      continue
    }
    // 连续 run 个非内容，且朝外侧继续偏向片夹 → 认为离开了画面
    let low = 0
    for (let k = 0; k < run; k++) {
      const j = i + step * k
      if (j < 0 || j >= n) {
        low++
        continue
      }
      if (isContent(j)) break
      low++
    }
    if (low >= Math.min(run, fromStart ? i + 1 : n - i)) {
      if (lastContent < 0) return Math.min(maxInset, Math.floor(n * 0.02))
      const inset = fromStart ? lastContent : n - 1 - lastContent
      // 只裁该边允许的片夹厚度内；过深说明可能撞上画面暗部，交给从外向内更稳
      if (inset > maxInset) return 0
      return Math.max(0, inset)
    }
  }
  return 0
}

/** 按方向调用对应扫描 */
function findBorderInset(
  mean: Float64Array,
  content: Float64Array,
  fromStart: boolean,
  maxInset: number,
  direction: HolderScanDirection
): number {
  return direction === 'outward'
    ? findBorderInsetOutward(mean, content, fromStart, maxInset)
    : findBorderInsetInward(mean, content, fromStart, maxInset)
}

/**
 * 自动识别翻拍片夹 / 片框黑边，返回应保留的有效区域。
 *
 * 相对旧实现（逐线取样 + 分位数）的改进：
 * 1. 改为整幅行/列剖面，边界定位不再受采样线疏密影响；
 * 2. 同时使用亮度与「片基橙色内容比例」，软边与薄黑边更稳；
 * 3. 支持从外向内 / 从中心向边缘两种扫描方向；
 * 4. 对无片夹画面：外缘不暗于内部时直接判 0，避免误裁暗角。
 *
 * 未发现明显边框时返回 null（保持整幅画面不变）。
 */
export function detectHolderRect(
  lin: Uint16Array,
  width: number,
  height: number,
  direction: HolderScanDirection = 'inward'
): CropRect | null {
  if (width < 16 || height < 16) return null

  const rows = buildEdgeProfiles(lin, width, height, 'row')
  const cols = buildEdgeProfiles(lin, width, height, 'col')
  const rowMean = smoothProfile(rows.mean)
  const rowContent = smoothProfile(rows.content)
  const colMean = smoothProfile(cols.mean)
  const colContent = smoothProfile(cols.content)

  const maxTop = Math.floor(height * HOLDER_MAX_INSET)
  const maxBottom = Math.floor(height * HOLDER_MAX_INSET)
  const maxLeft = Math.floor(width * HOLDER_MAX_INSET)
  const maxRight = Math.floor(width * HOLDER_MAX_INSET)

  const top = findBorderInset(rowMean, rowContent, true, maxTop, direction)
  const bottom = findBorderInset(rowMean, rowContent, false, maxBottom, direction)
  const left = findBorderInset(colMean, colContent, true, maxLeft, direction)
  const right = findBorderInset(colMean, colContent, false, maxRight, direction)

  if (top === 0 && bottom === 0 && left === 0 && right === 0) return null

  const withMargin = (px: number, dim: number): number =>
    px > 0 ? Math.min(dim - 1, px + Math.max(1, Math.round(dim * HOLDER_SAFETY))) : 0

  const insetTop = withMargin(top, height) / height
  const insetBottom = withMargin(bottom, height) / height
  const insetLeft = withMargin(left, width) / width
  const insetRight = withMargin(right, width) / width

  const w = 1 - insetLeft - insetRight
  const h = 1 - insetTop - insetBottom
  if (w < 0.3 || h < 0.3) return null

  return { x: insetLeft, y: insetTop, w, h }
}

/**
 * 采样估计排除区域在统计范围内的覆盖率。
 *
 * 覆盖率过高（用户几乎把整幅画面都框住了）时应当忽略排除：否则统计不到任何
 * 像素，片基 / 对齐会静默回落到默认值，画面会莫名其妙地整体偏色。
 */
function exclusionCoverage(
  region: CropRect | null | undefined,
  exclude: CropRect[] | null | undefined,
  width: number,
  height: number
): number {
  const skip = excludeRanges(exclude, width, height)
  if (skip.length === 0) return 0
  const { x0, y0, x1, y1 } = pixelRange(region, width, height)
  const N = 48
  let hit = 0
  for (let i = 0; i < N; i++) {
    const y = y0 + Math.floor(((i + 0.5) / N) * (y1 - y0))
    for (let j = 0; j < N; j++) {
      const x = x0 + Math.floor(((j + 0.5) / N) * (x1 - x0))
      if (isExcluded(skip, x, y)) hit++
    }
  }
  return hit / (N * N)
}

/** 在指定区域内自动检测负片参数（含校正模式判定） */
export function detectNegative(
  lin: Uint16Array,
  width: number,
  height: number,
  region?: CropRect | null,
  validArea?: CropRect | null,
  exclude?: CropRect[] | null
): DetectResult {
  // 排除区域覆盖了几乎整个统计范围时不做排除，避免统计不到任何像素
  const skip = exclusionCoverage(region, exclude, width, height) >= 0.98 ? null : exclude
  const base = detectFilmBase(lin, width, height, 0.997, region, skip)
  const tRef = detectTRef(lin, width, height, base, TREF_FRACTION, region, skip)
  const align = detectChannelAlign(lin, width, height, region, 0.002, 0.002, skip)

  // 统一使用通道对齐：片基反相（base）在多数翻拍样片上偏色更重，已停用。
  const mode: NegativeMode = 'align'

  return {
    mode,
    base,
    tRef: mode === 'align' ? Math.max(tRef, 0.02) : tRef,
    suggestedStrength: 0.7,
    alignBlack: align.black,
    alignWhite: align.white,
    validArea: validArea ?? null
  }
}

/** 在指定归一化坐标处取色（用于吸管手动取样），窗口平均以降低噪点影响 */
export function sampleAt(
  lin: Uint16Array,
  width: number,
  height: number,
  u: number,
  v: number,
  radius = 4
): Vec3 {
  const cx = clamp(Math.round(u * (width - 1)), 0, width - 1)
  const cy = clamp(Math.round(v * (height - 1)), 0, height - 1)
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
      const o = (y * width + x) * 3
      r += lin[o]
      g += lin[o + 1]
      b += lin[o + 2]
      count++
    }
  }
  if (count === 0) return [0.7, 0.5, 0.3]
  return [clamp(r / count / 65535, 0.01, 1), clamp(g / count / 65535, 0.01, 1), clamp(b / count / 65535, 0.01, 1)]
}
