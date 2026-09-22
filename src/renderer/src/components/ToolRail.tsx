import { Ban, Brush, Crop, Frame, Pipette, SlidersHorizontal } from 'lucide-react'
import { useEditor } from '../state/store'

export function ToolRail() {
  const tool = useEditor((s) => s.tool)
  const setTool = useEditor((s) => s.setTool)
  const tab = useEditor((s) => s.tab)
  const setTab = useEditor((s) => s.setTab)
  const eyedropper = useEditor((s) => s.eyedropper)
  const setEyedropper = useEditor((s) => s.setEyedropper)
  const hasImage = useEditor((s) => s.image !== null)

  return (
    <nav className="toolrail">
      <button
        className={`tool${tool === 'adjust' && !['transform', 'holder', 'negative', 'denoise', 'repair'].includes(tab) ? ' is-active' : ''}`}
        title="调整"
        disabled={!hasImage}
        onClick={() => {
          setTool('adjust')
          if (['transform', 'holder', 'negative', 'denoise', 'repair'].includes(tab)) {
            setTab('basic')
          }
        }}
      >
        <SlidersHorizontal size={19} strokeWidth={1.6} />
        调整
      </button>
      <button
        className={`tool${tool === 'holder' ? ' is-active' : ''}`}
        title="手动框选片夹有效区域"
        disabled={!hasImage}
        onClick={() => {
          setEyedropper(false)
          setTool(tool === 'holder' ? 'adjust' : 'holder')
          setTab('holder')
        }}
      >
        <Frame size={19} strokeWidth={1.6} />
        片夹
      </button>
      <button
        className={`tool${tool === 'crop' ? ' is-active' : ''}`}
        title="旋转与裁切"
        disabled={!hasImage}
        onClick={() => {
          setTool('crop')
          setTab('transform')
        }}
      >
        <Crop size={19} strokeWidth={1.6} />
        裁切
      </button>
      <button
        className={`tool${tool === 'exclude' ? ' is-active' : ''}`}
        title="排除区域：框出齿孔等不应参与去色罩统计的区域"
        disabled={!hasImage}
        onClick={() => {
          setEyedropper(false)
          setTool(tool === 'exclude' ? 'adjust' : 'exclude')
          setTab('holder')
        }}
      >
        <Ban size={19} strokeWidth={1.6} />
        排除
      </button>
      <button
        className={`tool${tool === 'heal' ? ' is-active' : ''}`}
        title="除尘：点除灰尘与浮毛"
        disabled={!hasImage}
        onClick={() => {
          setEyedropper(false)
          setTool(tool === 'heal' ? 'adjust' : 'heal')
          setTab('repair')
        }}
      >
        <Brush size={19} strokeWidth={1.6} />
        除尘
      </button>
      <button
        className={`tool${eyedropper ? ' is-active' : ''}`}
        title="吸管：取样片基色"
        disabled={!hasImage}
        onClick={() => {
          setTool('adjust')
          setTab('negative')
          setEyedropper(!eyedropper)
        }}
      >
        <Pipette size={19} strokeWidth={1.6} />
        吸管
      </button>
    </nav>
  )
}
