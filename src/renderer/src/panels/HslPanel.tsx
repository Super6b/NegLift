import { useState } from 'react'
import type { HslBandName } from '@shared/types'
import { RefreshCw } from 'lucide-react'
import { HSL_BANDS, HSL_BAND_HUE, HSL_BAND_LABEL, createDefaultHsl } from '@shared/defaults'
import { Slider } from '../components/Slider'
import { useControls } from '../hooks/useControls'

/** 每个分区的色相中点，用于给 chips 上色 */
function chipColor(name: HslBandName): string {
  return `hsl(${HSL_BAND_HUE[name]} 70% 52%)`
}

const ROWS = [
  { key: 'hue', label: '色相' },
  { key: 'saturation', label: '饱和度' },
  { key: 'luminance', label: '明度' }
] as const

const DEFAULTS = createDefaultHsl()

export function HslPanel() {
  const { params, update, begin, end } = useControls()
  const [band, setBand] = useState<HslBandName>('red')
  const current = params.hsl[band]

  return (
    <>
      <div className="section">
        <div className="section-head">
          <span className="section-title">色相分区</span>
          <span className="spacer" />
          <button
            className="btn is-ghost is-icon"
            title="重置全部 HSL 调整"
            onClick={() =>
              update((d) => {
                d.hsl = createDefaultHsl()
              })
            }
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="chips">
          {HSL_BANDS.map((name) => (
            <button
              key={name}
              className={`chip${name === band ? ' is-active' : ''}`}
              onClick={() => setBand(name)}
              aria-pressed={name === band}
            >
              <span className="channel-swatch" style={{ backgroundColor: chipColor(name) }} aria-hidden="true" />
              {HSL_BAND_LABEL[name]}
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <span className="section-title">{HSL_BAND_LABEL[band]}调整</span>
          <span className="spacer" />
          <button
            className="btn is-ghost is-icon"
            title={`重置${HSL_BAND_LABEL[band]}`}
            onClick={() =>
              update((d) => {
                d.hsl[band] = { ...DEFAULTS[band] }
              })
            }
          >
            <RefreshCw size={13} />
          </button>
        </div>
        {ROWS.map((row) => (
          <Slider
            key={row.key}
            label={row.label}
            value={current[row.key]}
            resetValue={DEFAULTS[band][row.key]}
            onInteractStart={begin}
            onInteractEnd={end}
            onChange={(v, c) =>
              update((d) => {
                d.hsl[band][row.key] = v
              }, c)
            }
          />
        ))}
      </div>
    </>
  )
}
