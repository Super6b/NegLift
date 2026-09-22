import { Ban, FileJson, FolderOpen, Frame, RefreshCw, Scan } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createFidelityConfigurationDraft, type FidelityConfiguration } from '@shared/fidelityConfiguration'
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
  const [fidelityConfigurations, setFidelityConfigurations] = useState<FidelityConfiguration[]>([])
  const [selectedFidelityId, setSelectedFidelityId] = useState('')
  const [fidelityJson, setFidelityJson] = useState('')
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
  const selectedFidelity = fidelityConfigurations.find((item) => item.id === selectedFidelityId) ?? null

  const refreshFidelityConfigurations = (): void => {
    void window.negLift.listFidelityConfigurations().then((items) => {
      setFidelityConfigurations(items)
      const selected = items.find((item) => item.id === selectedFidelityId) ?? items[items.length - 1]
      if (selected) {
        setSelectedFidelityId(selected.id)
        setFidelityJson(JSON.stringify(selected, null, 2))
      }
    })
  }
  useEffect(refreshFidelityConfigurations, [])

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
      {image && <>
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
        <p className="hint">只影响去色罩统计，不裁切画面。</p>
      </div>

      <div className="section">
        <div className="section-head">
          <span className="section-title">边缘裁除</span>
        </div>
        <div className="inset-grid">
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
        </div>
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
        <p className="hint">仅从统计中排除；单击标记可删除。</p>
      </div>

      </>}
      <details className="panel-details">
        <summary>采集配置</summary>
        <div className="section">
          <div className="section-head"><span className="section-title">保真采集配置（预览）</span></div>
          <div className="row">
            <button className="btn" onClick={() => {
              const id = `fidelity-${Date.now().toString(36)}`
              void window.negLift.saveFidelityConfigurationDraft(createFidelityConfigurationDraft(id, new Date().toISOString())).then(() => {
                setSelectedFidelityId(id); refreshFidelityConfigurations(); notify('已创建保真配置草稿；补全下方记录后保存。')
              })
            }}>新建草稿</button>
            <button className="btn is-ghost" onClick={() => void window.negLift.importFidelityConfigurations().then(refreshFidelityConfigurations)}>导入 JSON…</button>
            <button className="btn is-ghost" onClick={() => void window.negLift.exportFidelityConfigurations()}>导出 JSON…</button>
          </div>
          {fidelityConfigurations.length > 0 && <>
            <select className="field" value={selectedFidelityId} onChange={(event) => {
              const selected = fidelityConfigurations.find((item) => item.id === event.target.value)
              setSelectedFidelityId(event.target.value); setFidelityJson(selected ? JSON.stringify(selected, null, 2) : '')
            }}>
              {fidelityConfigurations.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.status === 'active' ? '已激活' : item.status === 'superseded' ? '已被取代' : '草稿'}）</option>)}
            </select>
            <textarea className="field" rows={10} value={fidelityJson} onChange={(event) => setFidelityJson(event.target.value)} aria-label="保真采集配置记录" />
            <div className="row">
              <button className="btn" disabled={selectedFidelity?.status !== 'draft'} onClick={() => {
                try {
                  const configuration = JSON.parse(fidelityJson) as FidelityConfiguration
                  void window.negLift.saveFidelityConfigurationDraft(configuration).then(() => { refreshFidelityConfigurations(); notify('已保存保真配置草稿。') })
                } catch { notify('配置记录不是有效的 JSON。', 'error') }
              }}>保存草稿</button>
              <button className="btn is-primary" disabled={selectedFidelity?.status !== 'draft'} onClick={() => void window.negLift.activateFidelityConfiguration(selectedFidelityId).then(() => { refreshFidelityConfigurations(); notify('采集配置已激活，可用于保真导出。') }).catch((error) => notify(error instanceof Error ? error.message : String(error), 'error'))}>激活</button>
            </div>
          </>}
          <p className="hint">缺少测量证据或质检条件时只能保存草稿。</p>
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
          {image?.meta.profileName && <span className="meta">当前：{image.meta.profileName}</span>}
        </div>
      </details>
    </>
  )
}
