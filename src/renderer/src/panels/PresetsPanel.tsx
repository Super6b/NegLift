import { useMemo, useState } from 'react'
import { BookmarkPlus, Trash2 } from 'lucide-react'
import { FILM_PRESETS } from '../presets/filmPresets'
import { useEditor } from '../state/store'

export function PresetsPanel() {
  const customPresets = useEditor((s) => s.customPresets)
  const activePresetId = useEditor((s) => s.activePresetId)
  const applyFilmPreset = useEditor((s) => s.applyFilmPreset)
  const applyCustomPreset = useEditor((s) => s.applyCustomPreset)
  const saveCustomPreset = useEditor((s) => s.saveCustomPreset)
  const deleteCustomPreset = useEditor((s) => s.deleteCustomPreset)
  const [name, setName] = useState('')

  const groups = useMemo(() => {
    const map = new Map<string, typeof FILM_PRESETS>()
    for (const preset of FILM_PRESETS) {
      const list = map.get(preset.group) ?? []
      list.push(preset)
      map.set(preset.group, list)
    }
    return [...map.entries()]
  }, [])

  const save = (): void => {
    saveCustomPreset(name)
    setName('')
  }

  return (
    <>
      <div className="section">
        <div className="section-head">
          <span className="section-title">保存当前调整</span>
        </div>
        <div className="row">
          <input
            className="field"
            style={{ flex: 1 }}
            placeholder="预设名称，如「夜色街拍」"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
          <button className="btn" onClick={save} disabled={!name.trim()}>
            <BookmarkPlus size={14} /> 保存
          </button>
        </div>
        <p className="hint">不包含片基检测和裁切设置。</p>
      </div>

      {customPresets.length > 0 && (
        <div className="section">
          <div className="section-head">
            <span className="section-title">我的预设</span>
          </div>
          {customPresets.map((preset) => (
            <div
              key={preset.id}
              className={`preset-item${activePresetId === `custom:${preset.id}` ? ' is-active' : ''}`}
              onClick={() => applyCustomPreset(preset.id)}
            >
              <span className="name">
                {preset.name}
                <span className="desc">
                  {new Date(preset.createdAt).toLocaleDateString('zh-CN')} 保存
                </span>
              </span>
              <button
                className="preset-del"
                title="删除预设"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteCustomPreset(preset.id)
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {groups.map(([group, list]) => (
        <div className="section" key={group}>
          <div className="section-head">
            <span className="section-title">{group}</span>
          </div>
          {list.map((preset) => (
            <div
              key={preset.id}
              className={`preset-item${activePresetId === preset.id ? ' is-active' : ''}`}
              onClick={() => applyFilmPreset(preset)}
            >
              <span className="name">
                {preset.name}
                <span className="desc">{preset.description}</span>
              </span>
            </div>
          ))}
        </div>
      ))}
    </>
  )
}
