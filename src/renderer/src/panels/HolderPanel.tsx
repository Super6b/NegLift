import { Ban, FileJson, FolderOpen, Frame, RefreshCw, Scan } from 'lucide-react'
import { Slider } from '../components/Slider'
import { useControls } from '../hooks/useControls'
import { useEditor } from '../state/store'
import type { HolderScanDirection } from '@shared/types'

/** 由有效区域反推四边内缩（非对称时也各自有意义） */
function areaInsets(v: { x: number; y: number; w: number; h: number } | null): {
  top: number
  right: number
  bottom: number
  left: number
} {
  if (!v) return { top: 0, right: 0, bottom: 0, left: 0 }
  return {
    top: v.y,
    right: Math.max(0, 1 - v.x - v.w),
    bottom: Math.max(0, 1 - v.y - v.h),
    left: v.x
  }
}

/**
 * 阶段① 有效区域：片夹排除。
 * 自动识别（可选扫描方向）+ 手动框选 + 四边裁除 + 特殊区域排除。
 * 目的：定出干净的底片有效范围，供阶段②去色罩统计使用。
 */
export function HolderPanel() {
  const { params, update, begin, end } = useControls()
  const detectHolder = useEditor((s) => s.detectHolder)
  const setValidArea = useEditor((s) => s.setValidArea)
  const setValidInsets = useEditor((s) => s.setValidInsets)
  const tool = useEditor((s) => s.tool)
  const setTool = useEditor((s) => s.setTool)
  const clearExcludeAreas = useEditor((s) => s.clearExcludeAreas)
  const notify = useEditor((s) => s.notify)
  const image = useEditor((s) => s.image)
  const t = params.transform
  const insets = areaInsets(t.validArea)
  const scan: HolderScanDirection = t.holderScan === 'outward' ? 'outward' : 'inward'
  const holderMode = tool === 'holder'
  const excludeMode = tool === 'exclude'

  const setScan = (dir: HolderScanDirection): void => {
    update((d) => {
      d.transform.holderScan = dir
    })
  }

  const setOneInset = (
    edge: 'top' | 'right' | 'bottom' | 'left',
    value: number,
    commit: boolean
  ): void => {
    const next = { ...insets, [edge]: Math.max(0, Math.min(0.45, value)) }
    setValidInsets(next, commit)
  }

  return (
    <>
      <div className="section">
        <div className="section-head">
          <span className="section-title">自动识别</span>
          <span className="spacer" />
          <button
            className="btn is-ghost is-icon"
            title="清除有效区域限制"
            onClick={() => setValidArea(null)}
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="chips" style={{ marginBottom: 10 }}>
          <button
            className={`chip${scan === 'inward' ? ' is-active' : ''}`}
            onClick={() => setScan('inward')}
            title="从图像边缘向中心寻找画面起点"
          >
            边缘 → 中心
          </button>
          <button
            className={`chip${scan === 'outward' ? ' is-active' : ''}`}
            onClick={() => setScan('outward')}
            title="从画面中心向边缘寻找片框内边界"
          >
            中心 → 边缘
          </button>
        </div>
        <div className="row">
          <button className="btn is-primary" onClick={() => void detectHolder()}>
            <Scan size={14} /> 识别片夹
          </button>
        </div>
        <p className="hint">
          【步骤 1 / 3】先定有效底片范围：片夹与片框黑边不参与去色罩统计。
          识别后可再进「几何」做旋转裁切；完成后点上方「下一步：标准色彩」。
          {t.validArea
            ? ` 当前有效区域：${(t.validArea.w * 100).toFixed(1)}% × ${(t.validArea.h * 100).toFixed(1)}%。`
            : ' 当前使用整幅画面。'}
        </p>
      </div>

      <div className="section">
        <div className="section-head">
          <span className="section-title">机型优化配置</span>
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={() => {
              void window.negLift.importCameraProfile().then((r) => {
                if (!r) return
                notify(`已导入 ${r.count} 条机型配置，重新打开图片后生效`)
              })
            }}
          >
            <FileJson size={14} /> 导入 JSON…
          </button>
          <button className="btn is-ghost" onClick={() => void window.negLift.openCameraProfileDir()}>
            <FolderOpen size={14} /> 配置目录
          </button>
        </div>
        <p className="hint">
          按机身 make/model 匹配解码与去色罩倾向。当前：
          {image?.meta.profileName
            ? `「${image.meta.profileName}」（${image.meta.profileSource === 'user' ? '用户' : '内置'}）`
            : '未匹配，使用全局默认。'}
          {' '}不同厂商 RAW 的 CFA/矩阵由 LibRaw 处理；此配置覆盖 demosaic 档与去色罩默认等。
        </p>
      </div>

      <div className="section">
        <div className="section-head">
          <span className="section-title">手动排除</span>
          <span className="spacer" />
        </div>
        <div className="row">
          <button
            className={`btn${holderMode ? ' is-on' : ''}`}
            onClick={() => {
              setTool(holderMode ? 'adjust' : 'holder')
            }}
          >
            <Frame size={14} /> {holderMode ? '退出手动框选' : '手动框选片夹'}
          </button>
        </div>
        <p className="hint">
          进入后在预览上拖动八向手柄框出「有效画面」；该区域只影响片基/对齐统计范围，
          不改变裁切构图。与「裁切」工具不同。
        </p>
      </div>

      <div className="section">
        <div className="section-head">
          <span className="section-title">边缘裁除</span>
        </div>
        <Slider
          label="上"
          value={insets.top * 100}
          min={0}
          max={20}
          step={0.1}
          precision={1}
          suffix="%"
          resetValue={0}
          onInteractStart={begin}
          onInteractEnd={end}
          onChange={(v, c) => setOneInset('top', v / 100, c)}
        />
        <Slider
          label="下"
          value={insets.bottom * 100}
          min={0}
          max={20}
          step={0.1}
          precision={1}
          suffix="%"
          resetValue={0}
          onInteractStart={begin}
          onInteractEnd={end}
          onChange={(v, c) => setOneInset('bottom', v / 100, c)}
        />
        <Slider
          label="左"
          value={insets.left * 100}
          min={0}
          max={20}
          step={0.1}
          precision={1}
          suffix="%"
          resetValue={0}
          onInteractStart={begin}
          onInteractEnd={end}
          onChange={(v, c) => setOneInset('left', v / 100, c)}
        />
        <Slider
          label="右"
          value={insets.right * 100}
          min={0}
          max={20}
          step={0.1}
          precision={1}
          suffix="%"
          resetValue={0}
          onInteractStart={begin}
          onInteractEnd={end}
          onChange={(v, c) => setOneInset('right', v / 100, c)}
        />
        <p className="hint">按边内缩有效区域；自动识别或手动框选后可在这里微调。</p>
      </div>

      <div className="section">
        <div className="section-head">
          <span className="section-title">特殊区域排除</span>
          <span className="spacer" />
          <button
            className="btn is-ghost is-icon"
            title="清空排除区域"
            disabled={t.excludeAreas.length === 0}
            onClick={clearExcludeAreas}
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="row">
          <button
            className={`btn${excludeMode ? ' is-on' : ''}`}
            onClick={() => {
              setTool(excludeMode ? 'adjust' : 'exclude')
            }}
          >
            <Ban size={14} /> {excludeMode ? '退出框选' : '框选排除区域'}
          </button>
          {t.excludeAreas.length > 0 && <span className="meta">已标记 {t.excludeAreas.length} 处</span>}
        </div>
        <p className="hint">
          齿孔、漏光边等接近纯黑的区域会污染统计。拖拽标记后只从去色罩统计中剔除，画面不受影响；
          单击已标记区域可删除。
        </p>
      </div>
    </>
  )
}
