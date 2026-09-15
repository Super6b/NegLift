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
                    onClick={() => {
                      applyWorkflowToLibrary(p.id, 'selected')
                      setPresetOpen(false)
                    }}
                    disabled={selectedCount === 0}
                  >
                    选中
                  </button>
                  <button
                    className="btn is-ghost"
                    onClick={() => {
                      applyWorkflowToLibrary(p.id, 'all')
                      setPresetOpen(false)
                    }}
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
            <div
              key={item.id}
              className={`filmstrip-item${isActive ? ' is-active' : ''}${item.selected ? ' is-selected' : ''}`}
              onClick={() => void setActiveLibraryId(item.id)}
              title={item.meta?.filePath ?? ''}
            >
              <button
                className={`filmstrip-check${item.selected ? ' is-on' : ''}`}
                title={item.selected ? '取消选择（导出）' : '选择（导出）'}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleLibrarySelected(item.id)
                }}
              >
                {item.selected && <Check size={11} />}
              </button>
              {item.thumbUrl ? (
                <img className="filmstrip-thumb" src={item.thumbUrl} alt="" draggable={false} />
              ) : (
                <div className="filmstrip-thumb filmstrip-thumb-empty">
                  <ImageIcon size={16} />
                </div>
              )}
              <span className="filmstrip-name">{item.meta?.fileName ?? ''}</span>
              <button
                className="filmstrip-remove"
                title="从胶片条移除"
                onClick={(e) => {
                  e.stopPropagation()
                  removeFromLibrary(item.id)
                }}
              >
                <Trash2 size={11} />
              </button>
            </div>
          )
        })}
      </div>
    </footer>
  )
}