import { useEffect } from 'react'
import { ArrowRight, Minimize2 } from 'lucide-react'
import { ExportDialog } from './components/ExportDialog'
import { BatchDialog } from './components/BatchDialog'
import { Filmstrip } from './components/Filmstrip'
import { HistogramView } from './components/HistogramView'
import { PreviewArea } from './components/PreviewArea'
import { StatusBar } from './components/StatusBar'
import { ToolRail } from './components/ToolRail'
import { TopBar } from './components/TopBar'
import { BasicPanel } from './panels/BasicPanel'
import { CurvesPanel } from './panels/CurvesPanel'
import { DenoisePanel } from './panels/DenoisePanel'
import { GradingPanel } from './panels/GradingPanel'
import { HolderPanel } from './panels/HolderPanel'
import { HslPanel } from './panels/HslPanel'
import { NegativePanel } from './panels/NegativePanel'
import { PresetsPanel } from './panels/PresetsPanel'
import { RepairPanel } from './panels/RepairPanel'
import { TransformPanel } from './panels/TransformPanel'
import { useEditor, type PanelTab } from './state/store'

/**
 * 三段式工作流：
 * ① 有效区域 —— 定框（片夹/几何）
 * ② 标准色彩 —— 去色罩还原真实颜色
 * ③ 风格调色 —— 在标准色上做创作
 */
type StageId = 'area' | 'correct' | 'grade'

interface StageDef {
  id: StageId
  num: string
  label: string
  desc: string
  tabs: { id: PanelTab; label: string }[]
  next: StageId | null
}

const STAGES: StageDef[] = [
  {
    id: 'area',
    num: '1',
    label: '有效区域',
    desc: '自动识别或手动划定底片有效范围，排除片夹与黑边，为后续校色提供干净统计区。',
    tabs: [
      { id: 'holder', label: '片夹' },
      { id: 'transform', label: '几何' }
    ],
    next: 'correct'
  },
  {
    id: 'correct',
    num: '2',
    label: '标准色彩',
    desc: '去色罩与降噪：还原接近实拍的标准正片颜色。完成后再进入风格调色，避免在错误底色上调风格。',
    tabs: [
      { id: 'negative', label: '去色罩' },
      { id: 'repair', label: '除尘' },
      { id: 'denoise', label: '降噪' }
    ],
    next: 'grade'
  },
  {
    id: 'grade',
    num: '3',
    label: '风格调色',
    desc: '在已校正的标准色上做基础、曲线、HSL、分级与预设，进行风格化创作。',
    tabs: [
      { id: 'basic', label: '基础' },
      { id: 'curves', label: '曲线' },
      { id: 'hsl', label: 'HSL' },
      { id: 'grading', label: '分级' },
      { id: 'presets', label: '预设' }
    ],
    next: null
  }
]

const ALL_TABS: { id: PanelTab; label: string }[] = STAGES.flatMap((s) => s.tabs)

function stageOf(tab: PanelTab): StageDef {
  return STAGES.find((s) => s.tabs.some((t) => t.id === tab)) ?? STAGES[0]
}

function PanelContent({ tab }: { tab: PanelTab }) {
  switch (tab) {
    case 'holder':
      return <HolderPanel />
    case 'negative':
      return <NegativePanel />
    case 'repair':
      return <RepairPanel />
    case 'curves':
      return <CurvesPanel />
    case 'hsl':
      return <HslPanel />
    case 'grading':
      return <GradingPanel />
    case 'denoise':
      return <DenoisePanel />
    case 'transform':
      return <TransformPanel />
    case 'presets':
      return <PresetsPanel />
    default:
      return <BasicPanel />
  }
}

/** 应用外壳：负责主题注入、菜单命令与全局快捷键 */
export function App() {
  const theme = useEditor((s) => s.theme)
  const tab = useEditor((s) => s.tab)
  const immersive = useEditor((s) => s.immersive)
  const frameInfo = useEditor((s) => s.frameInfo)
  const toast = useEditor((s) => s.toast)
  const openProgress = useEditor((s) => s.openProgress)
  const hasImage = useEditor((s) => s.image !== null)
  const stage = stageOf(tab)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.negLift.setTitleTheme(theme)
  }, [theme])

  // 沉浸模式：隐藏应用菜单栏
  useEffect(() => {
    window.negLift.setImmersiveChrome(immersive)
  }, [immersive])

  // 主进程上报的打开进度
  useEffect(
    () => window.negLift.onOpenProgress((p) => useEditor.getState().setOpenProgress(p)),
    []
  )

  // 主进程菜单命令
  useEffect(() => {
    const handle = (command: string): void => {
      const s = useEditor.getState()
      switch (command) {
        case 'open':
          void s.openDialog()
          break
        case 'batch':
          s.setBatchOpen(true)
          break
        case 'export':
          if (s.image) s.setExportOpen(true)
          break
        case 'close-image':
          void s.closeImage()
          break
        case 'undo':
          s.undo()
          break
        case 'redo':
          s.redo()
          break
        case 'reset':
          s.resetAll()
          break
        case 'zoom-fit':
          s.setZoom(1)
          break
        case 'zoom-in':
          s.setZoom(s.zoom * 1.25)
          break
        case 'zoom-out':
          s.setZoom(s.zoom / 1.25)
          break
        case 'immersive':
          s.toggleImmersive()
          break
        case 'compare':
          s.setCompare(!s.compare)
          break
        case 'toggle-theme':
          s.toggleTheme()
          break
        default:
          break
      }
    }
    return window.negLift.onMenuCommand(handle)
  }, [])

  // 渲染进程内的快捷键
  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null
      if (!el) return false
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTyping(e.target)) return
      const s = useEditor.getState()

      // 按住空格临时对比原片
      if (e.code === 'Space' && !e.repeat) {
        if (!s.image) return
        e.preventDefault()
        s.setCompare(true)
        return
      }

      if (e.key === 'Escape') {
        if (s.exportOpen) s.setExportOpen(false)
        else if (s.eyedropper) s.setEyedropper(false)
        else if (s.immersive) s.toggleImmersive()
        else if (s.tool === 'crop' || s.tool === 'exclude' || s.tool === 'holder' || s.tool === 'heal') s.setTool('adjust')
        return
      }

      if (e.key === '[' || e.key === ']') {
        const index = ALL_TABS.findIndex((t) => t.id === s.tab)
        const next = (index + (e.key === ']' ? 1 : ALL_TABS.length - 1)) % ALL_TABS.length
        s.setTab(ALL_TABS[next].id)
        return
      }

      if (e.key === 'f' || e.key === 'F') s.toggleImmersive()
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') useEditor.getState().setCompare(false)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const selectStage = (id: StageId): void => {
    const s = STAGES.find((x) => x.id === id)
    if (!s) return
    const cur = useEditor.getState().tab
    // 已在该阶段则保持当前子页，否则切到该阶段第一个子页
    const still = s.tabs.some((t) => t.id === cur)
    if (!still) useEditor.getState().setTab(s.tabs[0].id)
  }

  const goNextStage = (): void => {
    if (!stage.next) return
    const s = STAGES.find((x) => x.id === stage.next)
    if (s) useEditor.getState().setTab(s.tabs[0].id)
  }

  return (
    <div className={`app${immersive ? ' is-immersive' : ''}`}>
      <TopBar />

      <div className="workspace">
        <ToolRail />

        <PreviewArea />

        <aside className="sidepanel">
          {/* 三段工作流主切换 */}
          <div className="workflow-stages" role="tablist" aria-label="调色工作流">
            {STAGES.map((s, i) => (
              <div key={s.id} className="workflow-stage-wrap">
                {i > 0 && <span className="workflow-arrow" aria-hidden>›</span>}
                <button
                  role="tab"
                  aria-selected={s.id === stage.id}
                  className={`workflow-stage${s.id === stage.id ? ' is-active' : ''}`}
                  onClick={() => selectStage(s.id)}
                  title={s.desc}
                >
                  <span className="workflow-num">{s.num}</span>
                  <span className="workflow-label">{s.label}</span>
                </button>
              </div>
            ))}
          </div>

          {/* 当前阶段说明 + 下一步 */}
          <div className="workflow-hint">
            <p className="workflow-desc">{stage.desc}</p>
            {stage.next && (
              <button className="btn is-primary workflow-next" onClick={goNextStage}>
                下一步：{STAGES.find((x) => x.id === stage.next)?.label}
                <ArrowRight size={13} />
              </button>
            )}
          </div>

          {/* 阶段内子页签 */}
          <div className="tabs">
            {stage.tabs.map((t) => (
              <button
                key={t.id}
                className={`tab${t.id === tab ? ' is-active' : ''}`}
                onClick={() => useEditor.getState().setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {hasImage && (
            <div className="histogram-wrap">
              <HistogramView data={frameInfo?.histogram ?? null} />
            </div>
          )}
          <div className="panel-body">
            <PanelContent tab={tab} />
          </div>
        </aside>
      </div>

      <Filmstrip />
      <StatusBar />

      {openProgress && (
        <div className="open-progress">
          <div className="open-progress-card">
            <div className="open-progress-label">{openProgress.label}</div>
            <div className="open-progress-track">
              <div
                className="open-progress-fill"
                style={{ width: `${Math.max(2, Math.round(openProgress.progress * 100))}%` }}
              />
            </div>
            <div className="open-progress-pct">{Math.round(openProgress.progress * 100)}%</div>
          </div>
        </div>
      )}

      {immersive && (
        <button className="immersive-exit" onClick={() => useEditor.getState().toggleImmersive()}>
          <Minimize2 size={14} /> 退出沉浸预览 (Esc)
        </button>
      )}

      <ExportDialog />
      <BatchDialog />

      {toast && (
        <div
          className={`toast${toast.kind === 'error' ? ' is-error' : ''}`}
          onClick={() => useEditor.getState().clearToast()}
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}