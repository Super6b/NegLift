import { useEffect, useRef, useState } from 'react'
import {
  Contrast,
  Columns2,
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
  const restorationPath = useEditor((s) => s.restorationPath)
  const [restoration, setRestoration] = useState<{ parent: string; child: string } | null>(null)
  const [showRestoration, setShowRestoration] = useState(false)
  const openComparisonRef = useRef<HTMLButtonElement>(null)
  const closeComparisonRef = useRef<HTMLButtonElement>(null)
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

  const openRestorationComparison = async (): Promise<void> => {
    const path = restorationPath ?? image?.meta.filePath
    if (!path) return
    const current = await window.negLift.restorationComparison(path)
    if (path !== (useEditor.getState().restorationPath ?? useEditor.getState().image?.meta.filePath)) return
    setRestoration(current)
    if (current) setShowRestoration(true)
    else useEditor.getState().notify('父版或修复文件已变化，无法核对谱系', 'error')
  }

  useEffect(() => {
    let current = true
    setRestoration(null)
    setShowRestoration(false)
    if (image) void window.negLift.restorationComparison(restorationPath ?? image.meta.filePath).then((result) => {
      if (current) setRestoration(result)
    })
    return () => { current = false }
  }, [image, restorationPath])

  useEffect(() => {
    if (!showRestoration) {
      if (restoration) openComparisonRef.current?.focus()
      return
    }
    closeComparisonRef.current?.focus()
    const close = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape') setShowRestoration(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [showRestoration])

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

      {restoration && (
        <button ref={openComparisonRef} className="btn" title="比较已保存的修复派生文件与已验证父文件" onClick={() => void openRestorationComparison()}>
          <Columns2 size={14} /> 比较父版
        </button>
      )}

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
      {showRestoration && restoration && (
        <div className="modal-backdrop" onPointerDown={() => setShowRestoration(false)}>
          <div className="modal restoration-compare" role="dialog" aria-modal="true" aria-label="父版与修复派生文件对比" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Tab') event.preventDefault() }}>
            <div className="modal-head">
              <span>父版与修复派生文件</span>
              <span className="spacer" />
              <button ref={closeComparisonRef} className="btn is-ghost is-icon" title="关闭对比" aria-label="关闭对比" onClick={() => setShowRestoration(false)}><X size={15} /></button>
            </div>
            <div className="restoration-pair">
              <figure><img src={restoration.parent} alt="已验证父版" /><figcaption>已验证父版</figcaption></figure>
              <figure><img src={restoration.child} alt="修复派生文件" /><figcaption>修复派生文件</figcaption></figure>
            </div>
          </div>
        </div>
      )}
    </header>
  )
}
