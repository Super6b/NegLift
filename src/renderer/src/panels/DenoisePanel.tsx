import { RefreshCw } from 'lucide-react'
import { Slider } from '../components/Slider'
import { useControls } from '../hooks/useControls'
import { DEFAULT_DENOISE } from './constants'

export function DenoisePanel() {
  const { params, update, begin, end } = useControls()
  const d = params.denoise

  return (
    <div className="section">
      <div className="section-head">
        <span className="section-title">降噪</span>
        <span className="spacer" />
        <button
          className="btn is-ghost is-icon"
          title="重置降噪"
          onClick={() =>
            update((draft) => {
              draft.denoise = { ...DEFAULT_DENOISE }
            })
          }
        >
          <RefreshCw size={13} />
        </button>
        <label className="switch">
          <input
            type="checkbox"
            checked={d.enabled}
            onChange={(e) => update((draft) => void (draft.denoise.enabled = e.target.checked))}
          />
          <span className="switch-track" />
        </label>
      </div>

      <Slider
        label="色彩噪点"
        value={d.color}
        min={0}
        max={10}
        step={1}
        precision={0}
        resetValue={DEFAULT_DENOISE.color}
        onInteractStart={begin}
        onInteractEnd={end}
        onChange={(v, c) =>
          update((draft) => {
            draft.denoise.color = v
          }, c)
        }
      />
      <Slider
        label="亮度噪点"
        value={d.luminance}
        min={0}
        max={10}
        step={1}
        precision={0}
        resetValue={DEFAULT_DENOISE.luminance}
        onInteractStart={begin}
        onInteractEnd={end}
        onChange={(v, c) =>
          update((draft) => {
            draft.denoise.luminance = v
          }, c)
        }
      />

      <p className="hint">
        色彩噪点采用亮度引导的边缘保持滤波，只在 1/4 分辨率的色度通道上处理，
        亮度细节完整保留；亮度噪点在全分辨率上做轻度平滑。等级 0 为关闭。
        预览实时生效（显卡渲染），导出使用同一套参数。
      </p>
    </div>
  )
}
