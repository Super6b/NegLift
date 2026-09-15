/** 色彩空间与传递函数工具 */

export const LUM_R = 0.2126
export const LUM_G = 0.7152
export const LUM_B = 0.0722

/**
 * sRGB 电光转换函数（线性 -> 显示编码）。
 * 对 v > 1 不截断，继续按幂律外推，使高光在后续「高光/白色阶」滑块中仍可被拉回。
 */
export function srgbEncode(v: number): number {
  if (v <= 0) return 0
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/** sRGB 光电转换函数（显示编码 -> 线性），输入 0..1 */
export function srgbDecode(v: number): number {
  if (v <= 0) return 0
  if (v >= 1) return 1
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

export function luminance(r: number, g: number, b: number): number {
  return LUM_R * r + LUM_G * g + LUM_B * b
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/**
 * 色温/色调滑块 -> RGB 增益。
 * 以色温 6500K 中性，滑块 -100..100 映射到 4500K..11000K 的相对偏移，
 * 使用 Tanner Helland 近似式的简化版，只求方向与观感正确。
 */
export function whiteBalanceGain(temperature: number, tint: number): [number, number, number] {
  const t = temperature / 100
  const g = tint / 100
  // 暖：红升蓝降；冷：红降蓝升
  const rGain = Math.pow(2, t * 0.45)
  const bGain = Math.pow(2, -t * 0.45)
  // 色调：正=洋红（红蓝升绿降），负=绿（绿升红蓝降）
  const gGain = Math.pow(2, -g * 0.35)
  const rbAdj = Math.pow(2, g * 0.17)
  return [rGain * rbAdj, gGain, bGain * rbAdj]
}

/** 感知亮度（显示域）的饱和度估算，用于 vibrance */
export function saturationOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max <= 1e-6 ? 0 : (max - min) / max
}
