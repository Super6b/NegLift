import { useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Contrast, Frame, Minimize2, SlidersHorizontal, type LucideIcon } from 'lucide-react'
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
 * ② 自动校正 —— 去色罩只是视觉起点，不代表实测色彩准确
 * ③ 风格调色 —— 在自动校正基础上做创作
 */
type StageId = 'area' | 'correct' | 'grade'

interface StageDef {
  id: StageId
  label: string
  icon: LucideIcon
  tabs: { id: PanelTab; label: string }[]
}

const STAGES: StageDef[] = [
  {
    id: 'area',
    label: '有效区域',
    icon: Frame,
    tabs: [
      { id: 'holder', label: '片夹' },
      { id: 'transform', label: '几何' }
    ]
  },
  {
    id: 'correct',
    label: '自动校正',
    icon: Contrast,
    tabs: [
      { id: 'negative', label: '去色罩' },
      { id: 'repair', label: '除尘' },
      { id: 'denoise', label: '降噪' }
    ]
  },
  {
    id: 'grade',
    label: '风格调色',
    icon: SlidersHorizontal,
    tabs: [
      { id: 'basic', label: '基础' },
      { id: 'curves', label: '曲线' },
      { id: 'hsl', label: 'HSL' },
      { id: 'grading', label: '分级' },
      { id: 'presets', label: '预设' }
    ]
  }
]

const ALL_TABS: { id: PanelTab; label: string }[] = STAGES.flatMap((s) => s.tabs)

function stageOf(tab: PanelTab): StageDef {
  return STAGES.find((s) => s.tabs.some((t) => t.id === tab)) ?? STAGES[0]
}

function PanelContent({ tab, hasImage }: { tab: PanelTab; hasImage: boolean }) {
  if (!hasImage && tab !== 'holder') {
    return <p className="panel-empty">导入底片后可调整</p>
  }
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

  const onStageKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? STAGES.length - 1 :
      (index + (event.key === 'ArrowRight' ? 1 : STAGES.length - 1)) % STAGES.length
    selectStage(STAGES[next].id)
    document.getElementById(`workflow-stage-${STAGES[next].id}`)?.focus()
  }

  const onSubtabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? stage.tabs.length - 1 :
      (index + (event.key === 'ArrowRight' ? 1 : stage.tabs.length - 1)) % stage.tabs.length
    const target = stage.tabs[next].id
    useEditor.getState().setTab(target)
    document.getElementById(`workflow-subtab-${target}`)?.focus()
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
              <button key={s.id}
                id={`workflow-stage-${s.id}`}
                role="tab"
                aria-controls="workflow-panel"
                aria-selected={s.id === stage.id}
                tabIndex={s.id === stage.id ? 0 : -1}
                className={`workflow-stage${s.id === stage.id ? ' is-active' : ''}`}
                onClick={() => selectStage(s.id)}
                onKeyDown={(event) => onStageKeyDown(event, i)}
              >
                <s.icon size={14} strokeWidth={1.8} aria-hidden="true" />
                <span className="workflow-label">{s.label}</span>
              </button>
            ))}
          </div>

          {/* 阶段内子页签 */}
          <div className="tabs" role="tablist" aria-label={`${stage.label}工具`}>
            {stage.tabs.map((t, i) => (
              <button
                key={t.id}
                id={`workflow-subtab-${t.id}`}
                role="tab"
                aria-controls="workflow-panel"
                aria-selected={t.id === tab}
                tabIndex={t.id === tab ? 0 : -1}
                className={`tab${t.id === tab ? ' is-active' : ''}`}
                onClick={() => useEditor.getState().setTab(t.id)}
                onKeyDown={(event) => onSubtabKeyDown(event, i)}
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
          <div id="workflow-panel" role="tabpanel" aria-labelledby={`workflow-stage-${stage.id} workflow-subtab-${tab}`} className="panel-body">
            <PanelContent tab={tab} hasImage={hasImage} />
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
