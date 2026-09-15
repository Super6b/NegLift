import { useState } from 'react'

export interface SliderProps {
  label: string
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
        <span className="slider-label">{label}</span>
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
          <span
            className={`slider-value${modified ? ' is-modified' : ''}`}
            onDoubleClick={() => {
              setText(value.toFixed(precision))
              setEditing(true)
            }}
            title="双击输入数值"
          >
            {format(value, precision, suffix)}
          </span>
        )}
        <button
          className="slider-reset"
          title="重置"
          onClick={() => onChange(resetValue, true)}
          tabIndex={-1}
        >
          ⟲
        </button>
      </div>
      <input
        className="slider-input"
        type="range"
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
