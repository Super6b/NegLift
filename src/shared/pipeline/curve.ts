import type { CurvePoint } from '../types'
import { clamp } from './color'

/** 单调三次插值（Fritsch–Carlson），保证曲线不会出现反向拐点 */
export function buildCurveLut(points: CurvePoint[], size = 1024): Float32Array {
  const pts = [...points].sort((a, b) => a.x - b.x)
  const lut = new Float32Array(size + 1)

  // 退化情况：少于 2 个点或所有点 x 相同 -> 恒等
  if (pts.length < 2) {
    for (let i = 0; i <= size; i++) lut[i] = i / size
    return lut
  }

  const n = pts.length
  const xs = pts.map((p) => clamp(p.x, 0, 1))
  const ys = pts.map((p) => clamp(p.y, 0, 1))
  const dxs: number[] = []
  const ms: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const dx = Math.max(xs[i + 1] - xs[i], 1e-6)
    dxs.push(dx)
    ms.push((ys[i + 1] - ys[i]) / dx)
  }

  const c1: number[] = new Array(n).fill(0)
  // 端点斜率使用单侧差分
  c1[0] = ms[0]
  c1[n - 1] = ms[n - 2]
  for (let i = 1; i < n - 1; i++) {
    if (ms[i - 1] * ms[i] <= 0) {
      c1[i] = 0
    } else {
      const w1 = 2 * dxs[i] + dxs[i - 1]
      const w2 = dxs[i] + 2 * dxs[i - 1]
      c1[i] = (w1 + w2) / (w1 / ms[i - 1] + w2 / ms[i])
    }
  }

  let seg = 0
  for (let i = 0; i <= size; i++) {
    const x = i / size
    if (x <= xs[0]) {
      lut[i] = clamp(ys[0], 0, 1)
      continue
    }
    if (x >= xs[n - 1]) {
      lut[i] = clamp(ys[n - 1], 0, 1)
      continue
    }
    while (seg < n - 2 && x > xs[seg + 1]) seg++
    while (seg > 0 && x < xs[seg]) seg--
    const h = dxs[seg]
    const t = (x - xs[seg]) / h
    const t2 = t * t
    const t3 = t2 * t
    const h00 = 2 * t3 - 3 * t2 + 1
    const h10 = t3 - 2 * t2 + t
    const h01 = -2 * t3 + 3 * t2
    const h11 = t3 - t2
    lut[i] = clamp(h00 * ys[seg] + h10 * h * c1[seg] + h01 * ys[seg + 1] + h11 * h * c1[seg + 1], 0, 1)
  }

  return lut
}

/** 线性插值采样一个 LUT */
export function sampleLut(lut: Float32Array, x: number): number {
  const size = lut.length - 1
  if (x <= 0) return lut[0]
  if (x >= 1) return lut[size]
  const p = x * size
  const i = p | 0
  const f = p - i
  return lut[i] + (lut[i + 1] - lut[i]) * f
}

/** 判断一组曲线点是否为恒等变换 */
export function isIdentityCurve(points: CurvePoint[]): boolean {
  if (points.length !== 2) return false
  const [a, b] = [...points].sort((p, q) => p.x - q.x)
  return Math.abs(a.x) < 1e-6 && Math.abs(a.y) < 1e-6 && Math.abs(b.x - 1) < 1e-6 && Math.abs(b.y - 1) < 1e-6
}
