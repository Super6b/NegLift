import { useState } from 'react'
import type { CurveChannel, CurvePoint } from '@shared/types'
import { RefreshCw } from 'lucide-react'
import { createLinearCurves } from '@shared/defaults'
import { CurveEditor } from '../components/CurveEditor'
import { useControls } from '../hooks/useControls'

const CHANNELS: { id: CurveChannel; label: string; color: string }[] = [
  { id: 'rgb', label: 'RGB', color: '#e8e8e8' },
  { id: 'r', label: '红', color: '#ef6a63' },
  { id: 'g', label: '绿', color: '#5fc97a' },
  { id: 'b', label: '蓝', color: '#5f8ff0' }
]

const LINEAR = createLinearCurves()

export function CurvesPanel() {
  const { params, update, begin, end } = useControls()
  const [channel, setChannel] = useState<CurveChannel>('rgb')
  const active = CHANNELS.find((c) => c.id === channel) ?? CHANNELS[0]

  return (
    <>
      <div className="section">
        <div className="section-head">
          <span className="section-title">通道</span>
          <span className="spacer" />
          <button
            className="btn is-ghost is-icon"
            title="重置当前通道曲线"
            onClick={() =>
              update((d) => {
                d.curves[channel] = LINEAR[channel].map((p) => ({ ...p }))
              })
            }
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="chips">
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              className={`chip${c.id === channel ? ' is-active' : ''}`}
              onClick={() => setChannel(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <span className="section-title">{active.label} 曲线</span>
        </div>
        <CurveEditor
          points={params.curves[channel]}
          color={active.color}
          onInteractStart={begin}
          onInteractEnd={end}
          onChange={(points: CurvePoint[], commit) =>
            update((d) => {
              d.curves[channel] = points
            }, commit)
          }
        />
        <p className="hint">
          单击空白添加控制点，拖动调整；右键删除中间点。
          <b>两端端点可拖动</b>（改黑场/白场水平与输出高度）。RGB 作用整体亮度，单通道用于校色。
        </p>
      </div>
    </>
  )
}
