/**
 * 去色罩统计范围测试（运行：npm run test:analysis）
 *
 * 关注三件事：
 *   1. 统计只发生在「裁切 ∩ 有效区域」内，范围一变结果就跟着变
 *   2. 用户标记的排除区域（齿孔、漏光边）不参与统计
 *   3. 排除区域与统计范围不相交时不得产生任何影响；排除过度时自动失效
 */
import type { CropRect } from '../src/shared/types'
import { regionToSource, sourceToRegion } from '../src/shared/pipeline'
import { detectNegative } from '../src/shared/pipeline/analysis'

const W = 800
const H = 600
/** 画面内容（相当于片基/中间调的均匀亮度） */
const CONTENT = 0.3
/** 齿孔：顶部 10% 的一条近黑带 */
const SPROCKET: CropRect = { x: 0, y: 0, w: 1, h: 0.1 }

const to16 = (v: number): number => Math.max(0, Math.min(65535, Math.round(v * 65535)))

function makeImage(): Uint16Array {
  const data = new Uint16Array(W * H * 3)
  data.fill(to16(CONTENT))
  return data
}

/** 把归一化矩形填成指定亮度 */
function fillRect(data: Uint16Array, rect: CropRect, value: number): void {
  const x0 = Math.floor(rect.x * W)
  const x1 = Math.ceil((rect.x + rect.w) * W)
  const y0 = Math.floor(rect.y * H)
  const y1 = Math.ceil((rect.y + rect.h) * H)
  const v = to16(value)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * W + x) * 3
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
    }
  }
}

/** 填成指定 RGB（模拟偏橙片基） */
function fillRectRGB(data: Uint16Array, rect: CropRect, r: number, g: number, b: number): void {
  const x0 = Math.floor(rect.x * W)
  const x1 = Math.ceil((rect.x + rect.w) * W)
  const y0 = Math.floor(rect.y * H)
  const y1 = Math.ceil((rect.y + rect.h) * H)
  const R = to16(r)
  const G = to16(g)
  const B = to16(b)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * W + x) * 3
      data[o] = R
      data[o + 1] = G
      data[o + 2] = B
    }
  }
}

interface CaseResult {
  name: string
  ok: boolean
  detail: string
}

const results: CaseResult[] = []
const check = (name: string, ok: boolean, detail: string): void => {
  results.push({ name, ok, detail })
}

const fmt = (v: number): string => v.toFixed(4)
const close = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol

function run(): void {
  // 干净画面（没有齿孔）作为基准
  const clean = detectNegative(makeImage(), W, H)
  // 带齿孔的画面：近黑条带会被当成黑场，把对齐黑场拉低
  const holedImage = makeImage()
  fillRect(holedImage, SPROCKET, 0.02)
  const holed = detectNegative(holedImage, W, H)
  // 标记齿孔后，统计应回到干净画面的值
  const marked = detectNegative(holedImage, W, H, null, null, [SPROCKET])

  // ---- 用例 1：齿孔确实会污染统计（前提成立，后面两条才有意义）----
  {
    const ok = !close(holed.alignBlack[0], clean.alignBlack[0], 0.02)
    check(
      '未标记时齿孔会污染通道对齐黑场',
      ok,
      `干净黑场=${fmt(clean.alignBlack[0])} 带齿孔=${fmt(holed.alignBlack[0])}`
    )
  }

  // ---- 用例 2：标记后排除区域不参与统计 ----
  {
    const ok =
      close(marked.alignBlack[0], clean.alignBlack[0], 0.005) &&
      close(marked.alignWhite[0], clean.alignWhite[0], 0.005) &&
      close(marked.tRef, clean.tRef, 0.005)
    check(
      '标记齿孔后统计回到干净值',
      ok,
      `黑场 ${fmt(marked.alignBlack[0])} vs ${fmt(clean.alignBlack[0])}；` +
        `白场 ${fmt(marked.alignWhite[0])} vs ${fmt(clean.alignWhite[0])}；` +
        `tRef ${fmt(marked.tRef)} vs ${fmt(clean.tRef)}`
    )
  }

  // ---- 用例 3：统计范围随裁切变化（裁切 → 有效区域 → 去色罩）----
  {
    // 裁到下半幅：齿孔被裁掉了，黑场应立即回到画面值
    const bottomHalf: CropRect = { x: 0, y: 0.5, w: 1, h: 0.5 }
    const cropped = detectNegative(holedImage, W, H, bottomHalf)
    // 裁到上半幅（含齿孔）：不带排除时被污染，带排除时干净
    const topHalf: CropRect = { x: 0, y: 0, w: 1, h: 0.5 }
    const topDirty = detectNegative(holedImage, W, H, topHalf)
    const topMarked = detectNegative(holedImage, W, H, topHalf, null, [{ x: 0, y: 0, w: 1, h: 0.1 }])
    const ok =
      close(cropped.alignBlack[0], CONTENT, 0.005) &&
      !close(topDirty.alignBlack[0], CONTENT, 0.02) &&
      close(topMarked.alignBlack[0], CONTENT, 0.005)
    check(
      '统计范围跟随裁切，「裁切 → 有效区域 → 去色罩」生效',
      ok,
      `裁到下半=${fmt(cropped.alignBlack[0])}（期望 ${fmt(CONTENT)}）；` +
        `裁到上半未标记=${fmt(topDirty.alignBlack[0])}；` +
        `裁到上半已标记=${fmt(topMarked.alignBlack[0])}`
    )
  }

  // ---- 用例 4：排除区域落在统计范围之外时不得有影响 ----
  {
    const bottomHalf: CropRect = { x: 0, y: 0.5, w: 1, h: 0.5 }
    const plain = detectNegative(holedImage, W, H, bottomHalf)
    const withOutside = detectNegative(holedImage, W, H, bottomHalf, null, [SPROCKET])
    const ok =
      close(plain.alignBlack[0], withOutside.alignBlack[0], 1e-9) &&
      close(plain.tRef, withOutside.tRef, 1e-9)
    check(
      '统计范围外的排除区域不产生任何影响',
      ok,
      `黑场 ${fmt(plain.alignBlack[0])} / ${fmt(withOutside.alignBlack[0])}；` +
        `tRef ${fmt(plain.tRef)} / ${fmt(withOutside.tRef)}`
    )
  }

  // ---- 用例 5：排除过度（几乎覆盖整幅画面）时自动失效，不得回落到默认值 ----
  {
    const all: CropRect = { x: 0, y: 0, w: 1, h: 1 }
    const over = detectNegative(holedImage, W, H, null, null, [all])
    const ok = close(over.alignBlack[0], holed.alignBlack[0], 1e-9) && close(over.tRef, holed.tRef, 1e-9)
    check(
      '排除区域覆盖整幅时自动失效，避免统计不到像素',
      ok,
      `黑场 ${fmt(over.alignBlack[0])}（期望 ${fmt(holed.alignBlack[0])}）；tRef ${fmt(over.tRef)}`
    )
  }

  // ---- 用例 6：原图坐标 <-> 输出坐标的正反变换必须严格互逆 ----
  {
    // 同时打开旋转、翻转、有效区域与裁切，覆盖边界情况
    const t = {
      rotate90: 1,
      angle: 7,
      flipH: true,
      flipV: false,
      crop: { x: 0.1, y: 0.12, w: 0.7, h: 0.68 },
      aspect: null,
      validArea: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      excludeAreas: []
    }
    let maxErr = 0
    let tested = 0
    let clipped = 0
    for (const su of [0.2, 0.4, 0.5, 0.65, 0.8]) {
      for (const sv of [0.2, 0.4, 0.5, 0.65, 0.8]) {
        for (const applyCrop of [true, false]) {
          const [u, v] = sourceToRegion(su, sv, W, H, t, applyCrop)
          // 反查会把坐标夹到输出区域内，落在区域外的点本就无法互逆（预览也看不到）
          if (u < 0.001 || u > 0.999 || v < 0.001 || v > 0.999) {
            clipped++
            continue
          }
          tested++
          const [bu, bv] = regionToSource(u, v, W, H, t, applyCrop)
          maxErr = Math.max(maxErr, Math.abs(bu - su), Math.abs(bv - sv))
        }
      }
    }
    check(
      '原图坐标与输出坐标正反变换互逆（旋转/翻转/裁切下）',
      tested >= 5 && maxErr < 1e-9,
      `验证 ${tested} 个点（区域外跳过 ${clipped} 个），最大误差 ${maxErr.toExponential(2)}`
    )
  }

  // ---- 用例 7：零星死黑像素不得把白场参考（tRef）拖到下限 ----
  {
    // 0.1% 的纯黑斑点（灰尘 / 片基残留 / 传感器黑位）。以极小分位估计 tRef 时，
    // 这点面积足以让白场参考塌到下限，白场系数因此放大上千倍，整幅画面压成黑。
    const speckled = makeImage()
    const speck = { x: 0.4, y: 0.4, w: 0.032, h: 0.032 }
    fillRect(speckled, speck, 0)
    // 确认斑点面积确实只有 0.1% 量级
    const share = speck.w * speck.h
    const tref = detectNegative(speckled, W, H).tRef
    const cleanRef = detectNegative(makeImage(), W, H).tRef
    check(
      '零星死黑像素不会把白场参考拖到下限',
      tref > 0.3 && close(tref, cleanRef, 0.005),
      `${(share * 100).toFixed(2)}% 的死黑斑点下 tRef=${fmt(tref)}（无斑点=${fmt(cleanRef)}，下限 0.01）`
    )
  }

  // ---- 用例 8：强橙色罩应默认 align，避免 base 反相残留青蓝罩 ----
  {
    // 模拟彩色负片：三通道透射率明显分离（R 高 / B 低），且有大片「片基」高光区
    const mask = new Uint16Array(W * H * 3)
    for (let i = 0; i < W * H; i++) {
      // 场景内容：中等密度，通道仍分离
      const scene = 0.25 + 0.1 * Math.sin(i * 0.01)
      mask[i * 3] = to16(scene * 1.55)
      mask[i * 3 + 1] = to16(scene * 1.0)
      mask[i * 3 + 2] = to16(scene * 0.55)
    }
    // 右上角一块未曝光片基（更亮、仍偏橙）
    fillRectRGB(mask, { x: 0.7, y: 0.05, w: 0.25, h: 0.2 }, 0.78, 0.65, 0.58)
    const d = detectNegative(mask, W, H)
    const spread =
      Math.max(...d.alignBlack) - Math.min(...d.alignBlack)
    check(
      '强色罩自动选 align 模式',
      d.mode === 'align' && spread > 0.1,
      `mode=${d.mode} 黑场跨度=${fmt(spread)} base=[${d.base.map(fmt).join(', ')}]`
    )
  }

  let failed = 0
  console.log('\n去色罩统计范围测试报告')
  console.log('─'.repeat(76))
  for (const r of results) {
    if (!r.ok) failed++
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}`)
    console.log(`   ${r.detail}`)
  }
  console.log('─'.repeat(76))
  console.log(`${results.length - failed}/${results.length} 通过`)
  if (failed > 0) process.exitCode = 1
}

run()
