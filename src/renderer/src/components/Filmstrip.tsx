import { useMemo, useState } from 'react'
import { Check, Image as ImageIcon, Trash2, Wand2 } from 'lucide-react'
import { useEditor } from '../state/store'

/**
 * 底部胶片条：依次排列已导入照片（处理后缩略图），点击切换编辑；
 * 勾选用于批量导出；可批量应用工作流预设。
 */
export function Filmstrip() {
  const library = useEditor((s) => s.library)
  const activeId = useEditor((s) => s.activeId)
  const customPresets = useEditor((s) => s.customPresets)
  const setActiveLibraryId = useEditor((s) => s.setActiveLibraryId)
  const toggleLibrarySelected = useEditor((s) => s.toggleLibrarySelected)
  const setAllLibrarySelected = useEditor((s) => s.setAllLibrarySelected)
  const removeFromLibrary = useEditor((s) => s.removeFromLibrary)
  const applyWorkflowToLibrary = useEditor((s) => s.applyWorkflowToLibrary)
  const immersive = useEditor((s) => s.immersive)
  const [presetOpen, setPresetOpen] = useState(false)

  const selectedCount = useMemo(() => library.filter((i) => i.selected).length, [library])

  const applyPreset = (presetId: string, presetName: string, scope: 'selected' | 'all'): void => {
    const count = scope === 'all' ? library.length : selectedCount
    if (count === 0) return
    const target = scope === 'all' ? `全部 ${count} 张` : `选中的 ${count} 张`
    if (!window.confirm(`将工作流预设「${presetName}」应用到${target}？\n每张图片会保留自己的裁切与修补记录。`)) return
    applyWorkflowToLibrary(presetId, scope)
    setPresetOpen(false)
  }

  const removeFrame = (id: string, fileName: string): void => {
    if (!window.confirm(`从胶片条移除「${fileName}」？\n这不会删除磁盘中的原始文件。`)) return
    removeFromLibrary(id)
  }

  if (library.length === 0 || immersive) return null

  return (
    <footer className="filmstrip">
      <div className="filmstrip-bar">
        <span className="filmstrip-title">
          胶片条 · {library.length} 张
          {selectedCount > 0 && <span className="filmstrip-sel">已选 {selectedCount}</span>}
        </span>
        <button
          className="btn is-ghost"
          onClick={() => setAllLibrarySelected(selectedCount !== library.length)}
        >
          {selectedCount === library.length ? '取消全选' : '全选'}
        </button>
        <div style={{ position: 'relative' }}>
          <button
            className="btn"
            disabled={customPresets.length === 0}
            title="将预设应用到勾选的照片"
            onClick={() => setPresetOpen((v) => !v)}
          >
            <Wand2 size={13} /> 应用预设
          </button>
          {presetOpen && customPresets.length > 0 && (
            <div className="filmstrip-preset-menu">
              {customPresets.map((p) => (
                <div key={p.id} className="filmstrip-preset-item">
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                  <button
                    className="btn is-ghost"
                    onClick={() => applyPreset(p.id, p.name, 'selected')}
                    disabled={selectedCount === 0}
                  >
                    选中
                  </button>
                  <button
                    className="btn is-ghost"
                    onClick={() => applyPreset(p.id, p.name, 'all')}
                    title={`应用到全部 ${library.length} 张`}
                  >
                    全部
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="filmstrip-track">
        {library.map((item) => {
          const isActive = item.id === activeId
          return (
            <article
              key={item.id}
              className={`filmstrip-item${isActive ? ' is-active' : ''}${item.selected ? ' is-selected' : ''}`}
            >
              <button
                className="filmstrip-activate"
                aria-current={isActive ? 'true' : undefined}
                aria-label={`编辑 ${item.meta?.fileName ?? '未命名图片'}`}
                onClick={() => void setActiveLibraryId(item.id)}
                title={item.meta?.filePath ?? ''}
              >
                {item.thumbUrl ? (
                  <img className="filmstrip-thumb" src={item.thumbUrl} alt="" draggable={false} />
                ) : (
                  <span className="filmstrip-thumb filmstrip-thumb-empty" aria-hidden>
                    <ImageIcon size={16} />
                  </span>
                )}
                <span className="filmstrip-name">{item.meta?.fileName ?? ''}</span>
              </button>
              <button
                className={`filmstrip-check${item.selected ? ' is-on' : ''}`}
                aria-label={`用于导出 ${item.meta?.fileName ?? '未命名图片'}`}
                aria-pressed={item.selected}
                title={item.selected ? '取消选择（导出）' : '选择（导出）'}
                onClick={() => toggleLibrarySelected(item.id)}
              >
                {item.selected && <Check size={16} strokeWidth={2.5} />}
              </button>
              <button
                className="filmstrip-remove"
                aria-label={`从胶片条移除 ${item.meta?.fileName ?? '当前图片'}`}
                title="从胶片条移除"
                onClick={() => removeFrame(item.id, item.meta?.fileName ?? '当前图片')}
              >
                <Trash2 size={11} />
              </button>
            </article>
          )
        })}
      </div>
    </footer>
  )
}
