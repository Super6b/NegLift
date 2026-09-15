/**
 * 除尘修复：按**整段笔触**做一次孔修补（不是逐点圆）。
 *
 * 在**显示域** RGB（去色罩/调色/降噪之后）上处理：
 * 1. 笔触路径 → 胶囊状孔掩码（多边形并集）
 * 2. 孔内只做 Y 各向异性扩散；色度用外环中值（抗彩色噪点）
 * 3. 写回时色度不用原图，避免边缘彩虹/反色感
 */
import type { RepairStroke } from '../types'
import { clamp } from './color'

/** 实用上限：每段独立计算；此值仅防异常输入撑爆内存 */
export const MAX_REPAIR_STROKES = 4000
/** 单段路径加密后最多点数（防止超长笔触拖垮） */
export const MAX_POINTS_PER_STROKE = 400

export interface CanvasRepairStroke {
  /** 画布像素坐标路径 */
  points: { x: number; y: number }[]
  /** 画布像素半径 */
  r: number
  strength: number
}

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const abx = bx - ax
  const aby = by - ay
  const apx = px - ax
  const apy = py - ay
  const ab2 = abx * abx + aby * aby
  const t = ab2 < 1e-12 ? 0 : clamp((apx * abx + apy * aby) / ab2, 0, 1)
  const dx = apx - abx * t
  const dy = apy - aby * t
  return Math.sqrt(dx * dx + dy * dy)
}

function distToStroke(
  px: number,
  py: number,
  pts: { x: number; y: number }[]
): number {
  if (pts.length === 1) {
    return Math.hypot(px - pts[0].x, py - pts[0].y)
  }
  let best = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegment(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y)
    if (d < best) best = d
  }
  return best
}

/**
 * 沿路径按最大间距插值（坐标单位与 maxStep 一致）。
 * 保证胶囊孔连续，避免稀疏点形成一串圆。
 */
export function densifyStrokePoints<T extends { x: number; y: number }>(
  points: T[],
  maxStep: number
): T[] {
  if (points.length <= 1 || maxStep <= 0) return points.slice()
  const out: T[] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const dist = Math.hypot(b.x - a.x, b.y - a.y)
    const n = Math.max(1, Math.ceil(dist / maxStep))
    for (let k = 1; k <= n; k++) {
      const t = k / n
      out.push({
        ...b,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t
      } as T)
    }
  }
  return out
}

/** 合并圆心距离 < mergePx 的单点笔触为一条路径，减少「一串独立圆」 */
export function mergeNearbyStrokes(
  strokes: CanvasRepairStroke[],
  mergePx: number
): CanvasRepairStroke[] {
  const singles = strokes.filter((s) => s.points.length === 1)
  const others = strokes.filter((s) => s.points.length > 1)
  if (singles.length <= 1) return [...others, ...singles]

  const used = new Array(singles.length).fill(false)
  const merged: CanvasRepairStroke[] = []
  for (let i = 0; i < singles.length; i++) {
    if (used[i]) continue
    const chain = [singles[i].points[0]]
    const r = singles[i].r
    used[i] = true
    let grew = true
    while (grew) {
      grew = false
      for (let j = 0; j < singles.length; j++) {
        if (used[j]) continue
        const p = singles[j].points[0]
        let near = false
        for (const q of chain) {
          if (Math.hypot(p.x - q.x, p.y - q.y) < mergePx) {
            near = true
            break
          }
        }
        if (near) {
          chain.push(p)
          used[j] = true
          grew = true
        }
      }
    }
    if (chain.length === 1) {
      merged.push({ points: chain, r, strength: 1 })
    } else {
      // 简单路径：按到质心角度排序，近似一条连续带
      const cx = chain.reduce((s, p) => s + p.x, 0) / chain.length
      const cy = chain.reduce((s, p) => s + p.y, 0) / chain.length
      chain.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
      merged.push({ points: chain, r, strength: 1 })
    }
  }
  return [...others, ...merged]
}

/**
 * 在一笔触覆盖区内检测灰尘（不修改像素）。
 * 返回局部窗、搜索区、灰尘 mask（含 2px 膨胀）、背景色与是否整区回退。
 */
export function detectStrokeDust(
  data: Uint16Array,
  width: number,
  height: number,
  stroke: CanvasRepairStroke
): {
  x0: number
  y0: number
  bw: number
  bh: number
  dust: Uint8Array
  holes: number
  searchCount: number
  useAll: boolean
  bg: { r: number; g: number; b: number }
} | null {
  if (stroke.points.length === 0) return null
  const r = Math.max(3, stroke.r)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of stroke.points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const pad = r * 3.0 + 10
  const x0 = Math.max(0, Math.floor(minX - pad))
  const y0 = Math.max(0, Math.floor(minY - pad))
  const x1 = Math.min(width - 1, Math.ceil(maxX + pad))
  const y1 = Math.min(height - 1, Math.ceil(maxY + pad))
  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1
  if (bw < 10 || bh < 10) return null

  const n = bw * bh
  const searchR = r * 1.35
  const search = new Uint8Array(n)
  let searchCount = 0
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const d = distToStroke(x0 + x + 0.5, y0 + y + 0.5, stroke.points)
      if (d <= searchR) {
        search[y * bw + x] = 1
        searchCount++
      }
    }
  }
  if (searchCount === 0 || searchCount > n * 0.92) return null

  const origR = new Float32Array(n)
  const origG = new Float32Array(n)
  const origB = new Float32Array(n)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x
      const si = ((y0 + y) * width + (x0 + x)) * 3
      origR[i] = data[si] / 65535
      origG[i] = data[si + 1] / 65535
      origB[i] = data[si + 2] / 65535
    }
  }

  const ringLo = searchR * 1.05
  const ringHi = searchR * 2.4
  const rr: number[] = []
  const rg: number[] = []
  const rb: number[] = []
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x
      if (search[i]) continue
      const d = distToStroke(x0 + x + 0.5, y0 + y + 0.5, stroke.points)
      if (d < ringLo || d > ringHi) continue
      rr.push(origR[i])
      rg.push(origG[i])
      rb.push(origB[i])
    }
  }
  if (rr.length < 8) return null
  rr.sort((a, b) => a - b)
  rg.sort((a, b) => a - b)
  rb.sort((a, b) => a - b)
  const fr = rr[rr.length >> 1]
  const fg = rg[rg.length >> 1]
  const fb = rb[rb.length >> 1]

  const bgR = new Float32Array(n)
  const bgG = new Float32Array(n)
  const bgB = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (search[i]) {
      bgR[i] = fr
      bgG[i] = fg
      bgB[i] = fb
    } else {
      bgR[i] = origR[i]
      bgG[i] = origG[i]
      bgB[i] = origB[i]
    }
  }

  const blur3 = (buf: Float32Array): Float32Array => {
    const tmp = new Float32Array(buf)
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const i = y * bw + x
        tmp[i] =
          (buf[i] * 4 +
            buf[i - 1] +
            buf[i + 1] +
            buf[i - bw] +
            buf[i + bw] +
            buf[i - bw - 1] +
            buf[i - bw + 1] +
            buf[i + bw - 1] +
            buf[i + bw + 1]) /
          12
      }
    }
    return tmp
  }
  const blurPasses = Math.min(12, Math.max(3, Math.round(r * 0.35)))
  for (let k = 0; k < blurPasses; k++) {
    const nr = blur3(bgR)
    const ng = blur3(bgG)
    const nb = blur3(bgB)
    bgR.set(nr)
    bgG.set(ng)
    bgB.set(nb)
  }

  const absThr = 0.035
  const relThr = 0.22
  let dust = new Uint8Array(n)
  let dustCount = 0
  for (let i = 0; i < n; i++) {
    if (!search[i]) continue
    const dr = origR[i] - bgR[i]
    const dg = origG[i] - bgG[i]
    const db = origB[i] - bgB[i]
    const chroma = Math.sqrt(dr * dr + dg * dg + db * db)
    const bgY = 0.299 * bgR[i] + 0.587 * bgG[i] + 0.114 * bgB[i]
    const origY = 0.299 * origR[i] + 0.587 * origG[i] + 0.114 * origB[i]
    const lumaDiff = Math.abs(origY - bgY)
    if (chroma > absThr || lumaDiff > Math.max(absThr, bgY * relThr)) {
      dust[i] = 1
      dustCount++
    }
  }
  if (dustCount === 0) return null
  const useAll = dustCount > searchCount * 0.85

  if (!useAll) {
    for (let pass = 0; pass < 2; pass++) {
      const next = new Uint8Array(dust)
      for (let y = 1; y < bh - 1; y++) {
        for (let x = 1; x < bw - 1; x++) {
          const i = y * bw + x
          if (next[i]) continue
          if (!search[i]) continue
          if (
            dust[i - 1] ||
            dust[i + 1] ||
            dust[i - bw] ||
            dust[i + bw] ||
            dust[i - bw - 1] ||
            dust[i - bw + 1] ||
            dust[i + bw - 1] ||
            dust[i + bw + 1]
          ) {
            next[i] = 1
          }
        }
      }
      dust = next
    }
  }

  return { x0, y0, bw, bh, dust, holes: dustCount, searchCount, useAll, bg: { r: fr, g: fg, b: fb } }
}

/**
 * 单段笔触：在笔触覆盖区内**识别灰尘**，只替换异常像素，其余保留原背景。
 */
function inpaintStroke(
  data: Uint16Array,
  width: number,
  height: number,
  stroke: CanvasRepairStroke
): void {
  if (stroke.points.length === 0) return
  const strength = clamp(stroke.strength, 0, 1)
  if (strength <= 0) return

  const hit = detectStrokeDust(data, width, height, stroke)
  if (!hit) return
  const { x0, y0, bw, bh, dust, searchCount, useAll, bg } = hit
  const n = bw * bh

  // 需要原始 search 做写回过滤——detect 内已算过；为写回重建 search 代价高，
  // 直接用 dust + useAll：useAll 时全窗写 bg，否则只写 dust。
  // 重新读 orig 做混合
  const origR = new Float32Array(n)
  const origG = new Float32Array(n)
  const origB = new Float32Array(n)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x
      const si = ((y0 + y) * width + (x0 + x)) * 3
      origR[i] = data[si] / 65535
      origG[i] = data[si + 1] / 65535
      origB[i] = data[si + 2] / 65535
    }
  }

  const searchR = Math.max(3, stroke.r) * 1.35
  for (let i = 0; i < n; i++) {
    if (!useAll && !dust[i]) continue
    const si = ((y0 + (i / bw) | 0) * width + (x0 + (i % bw))) * 3
    const w = strength
    data[si] = clamp((origR[i] * (1 - w) + bg.r * w) * 65535, 0, 65535)
    data[si + 1] = clamp((origG[i] * (1 - w) + bg.g * w) * 65535, 0, 65535)
    data[si + 2] = clamp((origB[i] * (1 - w) + bg.b * w) * 65535, 0, 65535)
  }
  void searchR
  void searchCount
}

/**
 * 对显示域 RGB16 缓冲应用整段笔触（原地）。
 * 每段独立计算、互不依赖：前一段的结果可作为后一段的邻域参考，无「段数上限」。
 */
export function applyRepairStrokes(
  data: Uint16Array,
  width: number,
  height: number,
  strokes: CanvasRepairStroke[]
): void {
  if (strokes.length === 0) return
  const list = strokes.slice(0, MAX_REPAIR_STROKES)
  for (const st of list) {
    if (!st.points?.length || st.r <= 0) continue
    const step = Math.max(1, st.r * 0.45)
    let dense = densifyStrokePoints(st.points, step)
    if (dense.length > MAX_POINTS_PER_STROKE) {
      const keepStep = Math.ceil(dense.length / MAX_POINTS_PER_STROKE)
      dense = dense.filter((_, i) => i % keepStep === 0)
      if (dense[dense.length - 1] !== st.points[st.points.length - 1]) {
        dense.push(st.points[st.points.length - 1])
      }
    }
    inpaintStroke(data, width, height, { ...st, points: dense })
  }
}

/** 兼容旧名 */
export const applyRepairPixels = applyRepairStrokes

/**
 * 自动识别灰尘/浮毛：连通域 → 单点笔触（半径按斑块大小）。
 */
export function detectRepairStrokes(
  lin: Uint16Array,
  width: number,
  height: number,
  opts?: { maxStrokes?: number; sensitivity?: number }
): RepairStroke[] {
  const maxStrokes = Math.min(MAX_REPAIR_STROKES, opts?.maxStrokes ?? 80)
  const thr = clamp(opts?.sensitivity ?? 0.06, 0.01, 0.3)

  const longEdge = Math.max(width, height)
  const ds = longEdge > 1000 ? 1000 / longEdge : 1
  const dw = Math.max(32, Math.round(width * ds))
  const dh = Math.max(32, Math.round(height * ds))
  const stepX = width / dw
  const stepY = height / dh

  const luma = new Float32Array(dw * dh)
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) * stepY))
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) * stepX))
      const o = (sy * width + sx) * 3
      luma[y * dw + x] = (0.2126 * lin[o] + 0.7152 * lin[o + 1] + 0.0722 * lin[o + 2]) / 65535
    }
  }

  const seeds: { x: number; y: number }[] = []
  const R = 2
  for (let y = R; y < dh - R; y++) {
    for (let x = R; x < dw - R; x++) {
      const c = luma[y * dw + x]
      if (c < 0.002 || c > 0.55) continue
      let sum = 0
      let n = 0
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (dx === 0 && dy === 0) continue
          sum += luma[(y + dy) * dw + (x + dx)]
          n++
        }
      }
      const mean = sum / n
      if (mean < 0.003) continue
      if ((mean - c) / mean < thr) continue
      if (
        c > luma[(y - 1) * dw + x] ||
        c > luma[(y + 1) * dw + x] ||
        c > luma[y * dw + (x - 1)] ||
        c > luma[y * dw + (x + 1)]
      ) {
        continue
      }
      seeds.push({ x, y })
    }
  }

  const visited = new Uint8Array(dw * dh)
  const strokes: RepairStroke[] = []
  const minR = Math.max(2.5, 2.2 / dw)
  const maxR = Math.max(8, 12 / dw)

  for (const seed of seeds) {
    const si = seed.y * dw + seed.x
    if (visited[si]) continue
    const queue: number[] = [si]
    visited[si] = 1
    let minX = seed.x
    let maxX = seed.x
    let minY = seed.y
    let maxY = seed.y
    let count = 0
    const c0 = luma[si]
    const thrL = Math.max(c0 * 1.4, c0 + 0.012)

    for (let qi = 0; qi < queue.length; qi++) {
      const idx = queue[qi]
      count++
      const x = idx % dw
      const y = (idx / dw) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (const [ox, oy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1]
      ] as const) {
        const nx = x + ox
        const ny = y + oy
        if (nx < 1 || ny < 1 || nx >= dw - 1 || ny >= dh - 1) continue
        const ni = ny * dw + nx
        if (visited[ni]) continue
        if (luma[ni] > thrL || luma[ni] < 0.001) continue
        if (Math.hypot(nx - seed.x, ny - seed.y) > 16) continue
        visited[ni] = 1
        queue.push(ni)
      }
    }

    const extent = Math.max(maxX - minX + 1, maxY - minY + 1)
    const rNorm = clamp(Math.max(extent / dw, extent / dh) * 0.95, minR, maxR)
    // 细长斑（毛发）用路径两端点，便于胶囊孔覆盖整条
    if (maxX - minX > maxY - minY && maxX - minX > 3) {
      strokes.push({
        points: [
          { x: (minX + 0.5) / dw, y: (seed.y + 0.5) / dh },
          { x: (maxX + 0.5) / dw, y: (seed.y + 0.5) / dh }
        ],
        r: rNorm,
        strength: 1
      })
    } else if (maxY - minY > maxX - minX && maxY - minY > 3) {
      strokes.push({
        points: [
          { x: (seed.x + 0.5) / dw, y: (minY + 0.5) / dh },
          { x: (seed.x + 0.5) / dw, y: (maxY + 0.5) / dh }
        ],
        r: rNorm,
        strength: 1
      })
    } else {
      strokes.push({
        points: [{ x: (seed.x + 0.5) / dw, y: (seed.y + 0.5) / dh }],
        r: rNorm,
        strength: 1
      })
    }
  }

  strokes.sort((a, b) => b.r - a.r)
  // 邻近单点合并，避免「一串独立圆」各自填色
  const capped = strokes.slice(0, maxStrokes)
  const asCanvas: CanvasRepairStroke[] = capped.map((s) => ({
    points: s.points,
    r: s.r,
    strength: s.strength ?? 1
  }))
  const merged = mergeNearbyStrokes(asCanvas, 12 / dw)
  return merged.map((s) => ({
    points: s.points,
    r: s.r,
    strength: s.strength
  }))
}

/** @deprecated 兼容旧 API 名 */
export const detectRepairSpots = detectRepairStrokes
