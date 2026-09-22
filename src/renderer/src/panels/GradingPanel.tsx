import type { Vec3 } from '@shared/types'
import { RefreshCw } from 'lucide-react'
import { createDefaultGrading } from '@shared/defaults'
import { ColorWheel } from '../components/ColorWheel'
import { Slider } from '../components/Slider'
import { useControls } from '../hooks/useControls'

type Region = 'shadows' | 'midtones' | 'highlights'

const REGIONS: { key: Region; label: string }[] = [
  { key: 'shadows', label: '阴影' },
  { key: 'midtones', label: '中间调' },
  { key: 'highlights', label: '高光' }
]

const DEFAULTS = createDefaultGrading()

export function GradingPanel() {
  const { params, update, begin, end } = useControls()
  const g = params.grading

  const setRegion = (key: Region, value: Vec3, commit: boolean): void => {
    update((d) => {
      d.grading[key] = [value[0], value[1], value[2]]
    }, commit)
  }

  return (
    <>
      <div className="section">
        <div className="section-head">
          <span className="section-title">色彩分级</span>
          <span className="spacer" />
          <button
            className="btn is-ghost is-icon"
            title="重置色彩分级"
            onClick={() =>
              update((d) => {
                d.grading = createDefaultGrading()
              })
            }
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="wheels">
          {REGIONS.map((r) => (
            <ColorWheel
              key={r.key}
              label={r.label}
              value={g[r.key]}
              onChange={(v, commit) => setRegion(r.key, v, commit)}
              onInteractStart={begin}
              onInteractEnd={end}
            />
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <span className="section-title">混合与平衡</span>
        </div>
        <Slider
          label="混合"
          value={g.blending}
          resetValue={DEFAULTS.blending}
          onInteractStart={begin}
          onInteractEnd={end}
          onChange={(v, c) =>
            update((d) => {
              d.grading.blending = v
            }, c)
          }
        />
        <Slider
          label="平衡"
          value={g.balance}
          resetValue={DEFAULTS.balance}
          onInteractStart={begin}
          onInteractEnd={end}
          onChange={(v, c) =>
            update((d) => {
              d.grading.balance = v
            }, c)
          }
        />
      </div>
    </>
  )
}
