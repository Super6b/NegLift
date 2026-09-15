import {
  Contrast,
  FolderOpen,
  Layers,
  Maximize2,
  Moon,
  Redo2,
  Save,
  Sun,
  Undo2,
  Wand2,
  X
} from 'lucide-react'
import { useEditor } from '../state/store'

export function TopBar() {
  const image = useEditor((s) => s.image)
  const theme = useEditor((s) => s.theme)
  const compare = useEditor((s) => s.compare)
  const past = useEditor((s) => s.past.length)
  const future = useEditor((s) => s.future.length)
  const openDialog = useEditor((s) => s.openDialog)
  const closeImage = useEditor((s) => s.closeImage)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const resetAll = useEditor((s) => s.resetAll)
  const toggleTheme = useEditor((s) => s.toggleTheme)
  const toggleImmersive = useEditor((s) => s.toggleImmersive)
  const setCompare = useEditor((s) => s.setCompare)
  const setExportOpen = useEditor((s) => s.setExportOpen)
  const setBatchOpen = useEditor((s) => s.setBatchOpen)

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">NegLift</span>
        <span className="brand-sub">负片去色罩</span>
      </div>

      <button
        className="btn"
        onClick={() => void openDialog()}
        title="打开图片（支持多选，一次导入胶片条）"
      >
        <FolderOpen size={14} /> 打开图片
      </button>
      <button
        className="btn"
        onClick={() => setBatchOpen(true)}
        title="简易批处理：按模板批量处理多张底片 (Ctrl+Shift+B)"
      >
        <Layers size={14} /> 简易批处理
      </button>
      <button className="btn is-primary" onClick={() => setExportOpen(true)} disabled={!image}>
        <Save size={14} /> 导出
      </button>

      <span className="divider-v" />

      <button className="btn is-ghost is-icon" title="撤销 (Ctrl+Z)" onClick={undo} disabled={past === 0}>
        <Undo2 size={15} />
      </button>
      <button
        className="btn is-ghost is-icon"
        title="重做 (Ctrl+Shift+Z)"
        onClick={redo}
        disabled={future === 0}
      >
        <Redo2 size={15} />
      </button>
      <button
        className="btn is-ghost is-icon"
        title="重置全部调整 (Ctrl+Shift+R)"
        onClick={resetAll}
        disabled={!image}
      >
        <Wand2 size={15} />
      </button>
      <button className="btn is-ghost is-icon" title="关闭当前图片 (Ctrl+W)" onClick={() => void closeImage()} disabled={!image}>
        <X size={15} />
      </button>

      <span className="topbar-spacer" />

      <button
        className={`btn${compare ? ' is-on' : ''}`}
        title="对比原片 (Ctrl+P)"
        onClick={() => setCompare(!compare)}
        disabled={!image}
      >
        <Contrast size={14} /> 对比原片
      </button>
      <button
        className="btn is-ghost is-icon"
        title="沉浸预览 (Ctrl+B)"
        onClick={toggleImmersive}
        disabled={!image}
      >
        <Maximize2 size={15} />
      </button>
      <button
        className="btn is-ghost is-icon"
        title="切换深浅主题 (Ctrl+D)"
        onClick={toggleTheme}
      >
        {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    </header>
  )
}
