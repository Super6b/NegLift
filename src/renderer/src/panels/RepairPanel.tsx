import { Brush, Eraser } from 'lucide-react'
import { useControls } from '../hooks/useControls'
import { useEditor } from '../state/store'

/**
 * 阶段② 除尘：手动涂抹灰尘/浮毛。
 * 左键涂路径；按住中键拖动平移画面。
 */
export function RepairPanel() {
  const { params } = useControls()
  const tool = useEditor((s) => s.tool)
  const setTool = useEditor((s) => s.setTool)
  const repairRadius = useEditor((s) => s.repairRadius)
  const setRepairRadius = useEditor((s) => s.setRepairRadius)
  const removeRepairSpot = useEditor((s) => s.removeRepairSpot)
  const clearRepairSpots = useEditor((s) => s.clearRepairSpots)
  const spots = params.repairs
  const heal = tool === 'heal'

  return (
    <>
      <div className="section">
        <div className="section-head">
          <span className="section-title">手动除尘</span>
          <span className="spacer" />
          <span className="meta">{spots.length} 段</span>
        </div>
        <div className="row">
          <button
            className={`btn${heal ? ' is-on' : ''}`}
            onClick={() => setTool(heal ? 'adjust' : 'heal')}
          >
            <Brush size={14} /> {heal ? '退出除尘' : '开始除尘'}
          </button>
          <button
            className="btn is-ghost is-icon"
            title="清空全部笔触"
            disabled={spots.length === 0}
            onClick={clearRepairSpots}
          >
            <Eraser size={14} />
          </button>
        </div>
        <div className="slider" style={{ marginTop: 10 }}>
          <div className="slider-head">
            <span className="slider-label">笔刷半径</span>
            <span className="slider-value">{(repairRadius * 1000).toFixed(1)}‰</span>
          </div>
          <input
            type="range"
            min={0.5}
            max={20}
            step={0.1}
            value={repairRadius * 1000}
            onChange={(e) => setRepairRadius(Number(e.target.value) / 1000)}
          />
        </div>
        <p className="hint">拖动涂抹瑕疵；单击蓝色标记删除笔触。</p>
      </div>

      {spots.length > 0 && (
        <div className="section">
          <div className="section-head">
            <span className="section-title">修复笔触</span>
          </div>
          <div className="batch-file-list">
            {spots.slice(0, 40).map((s, i) => (
              <div key={`${s.points?.[0]?.x}-${s.points?.[0]?.y}-${i}`} className="batch-file-item">
                <span style={{ flex: 1 }}>
                  #{i + 1} · {s.points?.length ?? 0} 点 · r={(s.r * 1000).toFixed(1)}‰
                </span>
                <button className="btn is-ghost is-icon" onClick={() => removeRepairSpot(i)} title="删除">
                  ×
                </button>
              </div>
            ))}
            {spots.length > 40 && <div className="batch-file-item">… 另有 {spots.length - 40} 段</div>}
          </div>
        </div>
      )}
    </>
  )
}
