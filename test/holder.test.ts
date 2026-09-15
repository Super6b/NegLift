/**
 * 片夹识别测试用例（运行：npm run test:holder）
 *
 * 关注三件事：
 *   1. 有片夹时必须准确框出画面，且排除量不小于片夹厚度（宁可多裁，不可残留暗边）
 *   2. 没有片夹时不得裁切（避免把正常画面裁掉一圈）
 *   3. 结果不能随源图分辨率漂移（同一构图在两种分辨率下应给出一致比例）
 */
import type { CropRect } from '../src/shared/types'
import { detectHolderRect } from '../src/shared/pipeline/analysis'

const LUM = { r: 0.2126, g: 0.7152, b: 0.0722 }

interface Layout {
  top: number
  bottom: number
  left: number
  right: number
}

function makeRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

const to16 = (v: number): number => Math.max(0, Math.min(65535, Math.round(v * 65535)))

/**
 * 合成一张带片夹的翻拍图：
 * 片夹为深色框（软边：片夹与画面之间有一小段过渡），画面内容为 0.5 灰 + 轻微噪声。
 */
function makeScan(width: number, height: number, layout: Layout | null): Uint16Array {
  const data = new Uint16Array(width * height * 3)
  const rand = makeRandom(8848)
  const HOLDER = 0.02
  const CONTENT = 0.5
  const softPx = Math.max(1, Math.round(Math.min(width, height) * 0.004))
  const t = layout ? Math.round(layout.top * height) : 0
  const b = layout ? Math.round(layout.bottom * height) : 0
  const l = layout ? Math.round(layout.left * width) : 0
  const r = layout ? Math.round(layout.right * width) : 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = CONTENT
      if (layout) {
        // 到各边的距离，取最小值；在软边区间内做线性过渡
        const dTop = y
        const dBottom = height - 1 - y
        const dLeft = x
        const dRight = width - 1 - x
        const thickness = Math.min(
          dTop < t ? (t - dTop) / t : Number.POSITIVE_INFINITY,
          dBottom < b ? (b - dBottom) / b : Number.POSITIVE_INFINITY,
          dLeft < l ? (l - dLeft) / l : Number.POSITIVE_INFINITY,
          dRight < r ? (r - dRight) / r : Number.POSITIVE_INFINITY
        )
        const inTop = dTop < t
        const inBottom = dBottom < b
        const inLeft = dLeft < l
        const inRight = dRight < r
        if (inTop || inBottom || inLeft || inRight) {
          const dist = Math.min(
            inTop ? dTop : Number.POSITIVE_INFINITY,
            inBottom ? dBottom : Number.POSITIVE_INFINITY,
            inLeft ? dLeft : Number.POSITIVE_INFINITY,
            inRight ? dRight : Number.POSITIVE_INFINITY
          )
          const edge = Math.min(
            inTop ? t : Number.POSITIVE_INFINITY,
            inBottom ? b : Number.POSITIVE_INFINITY,
            inLeft ? l : Number.POSITIVE_INFINITY,
            inRight ? r : Number.POSITIVE_INFINITY
          )
          // 从画面侧（edge）向片夹侧（0）过渡
          const f = Math.max(0, Math.min(1, (edge - dist) / softPx))
          v = CONTENT + (HOLDER - CONTENT) * f
          void thickness
        }
      }
      v += (rand() - 0.5) * 0.02
      const o = (y * width + x) * 3
      data[o] = to16(v)
      data[o + 1] = to16(v)
      data[o + 2] = to16(v)
    }
  }
  return data
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

/** 识别出的各边排除比例 */
function insets(rect: CropRect | null): Layout | null {
  if (!rect) return null
  return {
    top: rect.y,
    right: 1 - rect.x - rect.w,
    bottom: 1 - rect.y - rect.h,
    left: rect.x
  }
}

function run(): void {
  const layout: Layout = { top: 0.012, bottom: 0.035, left: 0.01, right: 0.028 }
  const W = 1600
  const H = 1067
  const scanned = makeScan(W, H, layout)
  const rect = detectHolderRect(scanned, W, H)
  const got = insets(rect)

  // ---- 用例 1：有片夹时，每条边的排除量必须 ≥ 片夹厚度 ----
  {
    const edges: (keyof Layout)[] = ['top', 'bottom', 'left', 'right']
    const detail: string[] = []
    let ok = got !== null
    if (got) {
      for (const e of edges) {
        const extra = got[e] - layout[e]
        detail.push(`${e} 实际=${(layout[e] * 100).toFixed(2)}% 排除=${(got[e] * 100).toFixed(2)}%（多 ${(extra * 100).toFixed(2)}%）`)
        // 必须至少裁掉片夹本身，且不要过度裁切（保险量上限 1.6%）
        if (extra < 0 || extra > 0.016) ok = false
      }
    }
    check('有片夹时排除量覆盖片夹且不过度裁切', ok, detail.join('；'))
  }

  // ---- 用例 2：结果不随分辨率漂移 ----
  {
    const small = makeScan(800, 533, layout)
    const gotSmall = insets(detectHolderRect(small, 800, 533))
    let ok = gotSmall !== null && got !== null
    const detail: string[] = []
    if (gotSmall && got) {
      for (const e of ['top', 'bottom', 'left', 'right'] as (keyof Layout)[]) {
        const d = Math.abs(gotSmall[e] - got[e])
        detail.push(`${e} Δ=${(d * 100).toFixed(2)}%`)
        if (d > 0.006) ok = false
      }
    }
    check('两种分辨率下结果一致（Δ ≤ 0.6%）', ok, detail.join('；'))
  }

  // ---- 用例 3：没有片夹的画面不得裁切 ----
  {
    const plain = makeScan(1200, 800, null)
    const gotPlain = detectHolderRect(plain, 1200, 800)
    check('无片夹画面不裁切', gotPlain === null, gotPlain ? `误裁：${JSON.stringify(insets(gotPlain))}` : '返回 null')
  }

  // ---- 用例 4：只有上下有片夹时，只裁上下 ----
  {
    const only: Layout = { top: 0.02, bottom: 0.02, left: 0, right: 0 }
    const img = makeScan(1200, 800, only)
    const gotOnly = insets(detectHolderRect(img, 1200, 800))
    const ok =
      gotOnly !== null &&
      gotOnly.top > 0.02 &&
      gotOnly.bottom > 0.02 &&
      gotOnly.left === 0 &&
      gotOnly.right === 0
    check(
      '单边片夹只裁对应边',
      ok,
      gotOnly
        ? `上=${(gotOnly.top * 100).toFixed(2)}% 下=${(gotOnly.bottom * 100).toFixed(2)}% 左=${(gotOnly.left * 100).toFixed(2)}% 右=${(gotOnly.right * 100).toFixed(2)}%`
        : '返回 null'
    )
  }

  // ---- 用例 5：真实翻拍常见的「薄上边 + 厚下边/右边」不对称片框 ----
  // raw pic 实测：上边常只有 ~1%，下/右 3%~5%；旧算法曾把上边判成 0，
  // 残留黑边会污染 tRef 低分位，导致白场崩掉。
  {
    const thinTop: Layout = { top: 0.012, bottom: 0.045, left: 0.018, right: 0.04 }
    const img = makeScan(1600, 1067, thinTop)
    const gotThin = insets(detectHolderRect(img, 1600, 1067))
    let ok = gotThin !== null
    const detail: string[] = []
    if (gotThin) {
      for (const e of ['top', 'bottom', 'left', 'right'] as (keyof Layout)[]) {
        const extra = gotThin[e] - thinTop[e]
        detail.push(`${e} 排除=${(gotThin[e] * 100).toFixed(2)}%（多 ${(extra * 100).toFixed(2)}%）`)
        if (extra < 0 || extra > 0.016) ok = false
      }
      // 薄上边必须被识别出来，不能判成 0
      if (gotThin.top <= 0.012) ok = false
    }
    check('不对称薄上边仍被完整排除', ok, detail.join('；') || '返回 null')
  }

  // ---- 用例 6：画面整体偏暗（负片密部）时不得把内容当片夹推深 ----
  {
    const dark: Layout = { top: 0.02, bottom: 0.02, left: 0.015, right: 0.015 }
    const scanned = makeScan(1200, 800, dark)
    // 把内容压到 ~0.08，模拟欠曝/密部；片夹仍是 ~0.02
    for (let i = 0; i < scanned.length; i++) {
      // makeScan 内容约 0.5，片夹约 0.02；统一按位置难以区分，改为整体缩放后片夹也变亮，
      // 因此这里只缩放「偏亮」的像素，保留片夹近黑。
      if (scanned[i] > 0.05 * 65535) scanned[i] = Math.round(scanned[i] * 0.16)
    }
    const gotDark = insets(detectHolderRect(scanned, 1200, 800))
    let ok = gotDark !== null
    const detail: string[] = []
    if (gotDark) {
      for (const e of ['top', 'bottom', 'left', 'right'] as (keyof Layout)[]) {
        detail.push(`${e} 排除=${(gotDark[e] * 100).toFixed(2)}%（片夹=${(dark[e] * 100).toFixed(2)}%）`)
        // 暗画面下允许略多裁，但不能把 2% 片夹扩成 8% 大误裁
        if (gotDark[e] < dark[e] - 1e-6 || gotDark[e] > dark[e] + 0.03) ok = false
      }
    }
    check('偏暗画面不会把片夹外扩过头', ok, detail.join('；') || '返回 null')
  }

  // ---- 用例 7：从中心向边缘扫描与从外向内结果一致（合成片夹） ----
  {
    const layout: Layout = { top: 0.012, bottom: 0.035, left: 0.01, right: 0.028 }
    const img = makeScan(1600, 1067, layout)
    const inward = insets(detectHolderRect(img, 1600, 1067, 'inward'))
    const outward = insets(detectHolderRect(img, 1600, 1067, 'outward'))
    let ok = inward !== null && outward !== null
    const detail: string[] = []
    if (inward && outward) {
      for (const e of ['top', 'bottom', 'left', 'right'] as (keyof Layout)[]) {
        const d = Math.abs(inward[e] - outward[e])
        detail.push(`${e} Δ=${(d * 100).toFixed(2)}%（in=${(inward[e] * 100).toFixed(2)} out=${(outward[e] * 100).toFixed(2)}）`)
        // 两种方向都应覆盖片夹，且彼此接近
        if (outward[e] < layout[e] || d > 0.012) ok = false
      }
    }
    check('中心→边缘与边缘→中心方向均可识别片夹', ok, detail.join('；') || '返回 null')
  }

  let failed = 0
  console.log('\n片夹识别测试报告')
  console.log('─'.repeat(76))
  for (const r of results) {
    if (!r.ok) failed++
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}`)
    console.log(`   ${r.detail}`)
  }
  console.log('─'.repeat(76))
  console.log(`${results.length - failed}/${results.length} 通过`)
  void LUM
  if (failed > 0) process.exitCode = 1
}

run()
