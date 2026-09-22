import { useState } from 'react'
import { RotateCcw } from 'lucide-react'

export interface SliderProps {
  label: string
  channel?: 'r' | 'g' | 'b'
  value: number
  onChange: (value: number, commit: boolean) => void
  onInteractStart?: () => void
  onInteractEnd?: () => void
  min?: number
  max?: number
  step?: number
  /** 重置目标值，默认 0 */
  resetValue?: number
  precision?: number
  suffix?: string
}

function format(value: number, precision: number, suffix: string): string {
  const fixed = value.toFixed(precision)
  const signed = value > 0 && precision >= 0 ? `+${fixed}` : fixed
  return suffix ? `${signed}${suffix}` : signed
}

export function Slider({
  label,
  channel,
  value,
  onChange,
  onInteractStart,
  onInteractEnd,
  min = -100,
  max = 100,
  step = 1,
  resetValue = 0,
  precision = 0,
  suffix = ''
}: SliderProps) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const modified = Math.abs(value - resetValue) > 1e-6

  const commitText = (): void => {
    setEditing(false)
    const parsed = Number.parseFloat(text)
    if (Number.isFinite(parsed)) {
      onChange(Math.min(max, Math.max(min, parsed)), true)
    }
  }

  return (
    <div className="slider">
      <div className="slider-head">
        <span className="slider-label">
          {channel && <span className={`channel-swatch is-${channel}`} aria-hidden="true" />}
          {label}
        </span>
        {editing ? (
          <input
            className="slider-value"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitText()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <button
            type="button"
            className={`slider-value${modified ? ' is-modified' : ''}`}
            onClick={() => {
              setText(value.toFixed(precision))
              setEditing(true)
            }}
            title="输入数值"
          >
            {format(value, precision, suffix)}
          </button>
        )}
        <button
          className="slider-reset"
          aria-label={`重置${label}`}
          title={`重置${label}`}
          onClick={() => onChange(resetValue, true)}
        >
          <RotateCcw size={12} aria-hidden="true" />
        </button>
      </div>
      <input
        className="slider-input"
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onInteractStart}
        onPointerUp={onInteractEnd}
        onPointerCancel={onInteractEnd}
        onLostPointerCapture={onInteractEnd}
        onChange={(e) => onChange(Number.parseFloat(e.target.value), false)}
      />
    </div>
  )
}
