import type { BasicParams } from '@shared/types'
import { RefreshCw } from 'lucide-react'
import { Slider } from '../components/Slider'
import { useControls } from '../hooks/useControls'
import { DEFAULT_BASIC } from './constants'

interface Row {
  key: keyof BasicParams
  label: string
  min?: number
  max?: number
  step?: number
  precision?: number
  suffix?: string
}

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: '白平衡',
    rows: [
      { key: 'temperature', label: '色温' },
      { key: 'tint', label: '色调' }
    ]
  },
  {
    title: '曝光',
    rows: [
      { key: 'exposure', label: '曝光', min: -5, max: 5, step: 0.05, precision: 2, suffix: ' EV' },
      { key: 'contrast', label: '对比度' }
    ]
  },
  {
    title: '影调',
    rows: [
      { key: 'highlights', label: '高光' },
      { key: 'shadows', label: '阴影' },
      { key: 'whites', label: '白色阶' },
      { key: 'blacks', label: '黑色阶' }
    ]
  },
  {
    title: '色彩',
    rows: [
      { key: 'saturation', label: '饱和度' },
      { key: 'vibrance', label: '自然饱和度' }
    ]
  }
]

export function BasicPanel() {
  const { params, update, begin, end } = useControls()

  return (
    <>
      {GROUPS.map((group) => (
        <div className="section" key={group.title}>
          <div className="section-head">
            <span className="section-title">{group.title}</span>
            <span className="spacer" />
            <button
              className="btn is-ghost is-icon"
              title={`重置${group.title}`}
              onClick={() =>
                update((d) => {
                  for (const row of group.rows) d.basic[row.key] = DEFAULT_BASIC[row.key]
                })
              }
            >
              <RefreshCw size={13} />
            </button>
          </div>
          {group.rows.map((row) => (
            <Slider
              key={row.key}
              label={row.label}
              value={params.basic[row.key]}
              min={row.min ?? -100}
              max={row.max ?? 100}
              step={row.step ?? 1}
              precision={row.precision ?? 0}
              suffix={row.suffix ?? ''}
              resetValue={DEFAULT_BASIC[row.key]}
              onInteractStart={begin}
              onInteractEnd={end}
              onChange={(v, c) =>
                update((d) => {
                  d.basic[row.key] = v
                }, c)
              }
            />
          ))}
        </div>
      ))}
    </>
  )
}
