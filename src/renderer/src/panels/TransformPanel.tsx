import type { CropRect } from '@shared/types'
import { FlipHorizontal2, FlipVertical2, RefreshCw, RotateCcw, RotateCw } from 'lucide-react'
import { computeGeometry } from '@shared/pipeline'
import { Slider } from '../components/Slider'
import { useControls } from '../hooks/useControls'
import { useEditor } from '../state/store'

const ASPECTS: { label: string; value: number | null }[] = [
  { label: '自由', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:2', value: 3 / 2 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 }
]

export function TransformPanel() {
  const { params, update, begin, end } = useControls()
  const image = useEditor((s) => s.image)
  const tool = useEditor((s) => s.tool)
  const setTool = useEditor((s) => s.setTool)
  const setCrop = useEditor((s) => s.setCrop)
  const t = params.transform

  /** 旋转 90° 时同步旋转裁切框，避免裁切区域错位 */
  const rotateBy = (steps: number): void => {
    update((d) => {
      d.transform.rotate90 = (((d.transform.rotate90 + steps) % 4) + 4) % 4
      const crop = d.transform.crop
      if (crop) {
        if (steps > 0) {
          d.transform.crop = { x: 1 - crop.y - crop.h, y: crop.x, w: crop.h, h: crop.w }
        } else {
          d.transform.crop = { x: crop.y, y: 1 - crop.x - crop.w, w: crop.h, h: crop.w }
        }
      }
      if (d.transform.aspect) d.transform.aspect = 1 / d.transform.aspect
    })
  }

  /** 选中固定比例时，在未裁切画布内取最大的居中矩形作为裁切框 */
  const chooseAspect = (aspect: number | null): void => {
    if (!aspect || !image) {
      update((d) => {
        d.transform.aspect = aspect
      })
      return
    }
    const geo = computeGeometry(image.meta.width, image.meta.height, t)
    const aw = geo.transformedWidth
    const ah = geo.transformedHeight
    let w = aw
    let h = aw / aspect
    if (h > ah) {
      h = ah
      w = ah * aspect
    }
    const crop: CropRect = {
      x: (aw - w) / 2 / aw,
      y: (ah - h) / 2 / ah,
      w: w / aw,
      h: h / ah
    }
    update((d) => {
      d.transform.aspect = aspect
      d.transform.crop = crop
    })
    setTool('crop')
  }

  return (
    <>
      <div className="section">
        <div className="section-head">
          <span className="section-title">旋转</span>
          <span className="spacer" />
          <button
            className="btn is-ghost is-icon"
            title="重置旋转"
            onClick={() =>
              update((d) => {
                d.transform.rotate90 = 0
                d.transform.angle = 0
              })
            }
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="row">
          <button className="btn" onClick={() => rotateBy(-1)} title="逆时针 90°">
            <RotateCcw size={14} /> 逆时针 90°
          </button>
          <button className="btn" onClick={() => rotateBy(1)} title="顺时针 90°">
            <RotateCw size={14} /> 顺时针 90°
          </button>
        </div>
        <Slider
          label="角度微调"
          value={t.angle}
          min={-45}
          max={45}
          step={0.1}
          precision={1}
          suffix="°"
          resetValue={0}
          onInteractStart={begin}
          onInteractEnd={end}
          onChange={(v, c) =>
            update((d) => {
              d.transform.angle = v
            }, c)
          }
        />
        <div className="row">
          <button
            className={`btn${t.flipH ? ' is-on' : ''}`}
            onClick={() => update((d) => void (d.transform.flipH = !d.transform.flipH))}
          >
            <FlipVertical2 size={14} /> 水平翻转
          </button>
          <button
            className={`btn${t.flipV ? ' is-on' : ''}`}
            onClick={() => update((d) => void (d.transform.flipV = !d.transform.flipV))}
          >
            <FlipHorizontal2 size={14} /> 垂直翻转
          </button>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <span className="section-title">裁切比例</span>
          <span className="spacer" />
          <button
            className="btn is-ghost is-icon"
            title="重置裁切"
            onClick={() => setCrop(null)}
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="chips">
          {ASPECTS.map((a) => (
            <button
              key={a.label}
              className={`chip${t.aspect === a.value ? ' is-active' : ''}`}
              onClick={() => chooseAspect(a.value)}
            >
              {a.label}
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className={`btn${tool === 'crop' ? ' is-on' : ''}`}
            onClick={() => setTool(tool === 'crop' ? 'adjust' : 'crop')}
          >
            {tool === 'crop' ? '退出裁切编辑' : '进入裁切编辑'}
          </button>
          {t.crop && (
            <span className="meta">
              {Math.round(t.crop.w * 100)}% × {Math.round(t.crop.h * 100)}%
            </span>
          )}
        </div>
        <p className="hint">
          在预览画面中拖动裁切框改变构图，八个控制点可自由缩放；固定比例时角点与边中点会保持比例。
          片夹排除请到「片夹」栏目。
        </p>
      </div>
    </>
  )
}