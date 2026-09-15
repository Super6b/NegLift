import { useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { CropRect } from '@shared/types'

type HandleDir = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const HANDLES: HandleDir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const MIN_PX = 24

interface Props {
  crop: CropRect
  aspect: number | null
  /** 变换后画布的像素尺寸（未裁切） */
  canvasW: number
  canvasH: number
  /** 舞台 CSS 像素 / 图像像素 */
  scale: number
  grid: boolean
  onChange: (crop: CropRect, commit: boolean) => void
  onInteractStart: () => void
  onInteractEnd: () => void
}

interface DragState {
  mode: HandleDir
  startX: number
  startY: number
  rect: { x: number; y: number; w: number; h: number }
}

export function CropOverlay({
  crop,
  aspect,
  canvasW,
  canvasH,
  scale,
  grid,
  onChange,
  onInteractStart,
  onInteractEnd
}: Props) {
  const drag = useRef<DragState | null>(null)

  const px = {
    x: crop.x * canvasW,
    y: crop.y * canvasH,
    w: crop.w * canvasW,
    h: crop.h * canvasH
  }
  const box = {
    left: px.x * scale,
    top: px.y * scale,
    width: px.w * scale,
    height: px.h * scale
  }

  const begin = (e: ReactPointerEvent<HTMLElement>, mode: HandleDir): void => {
    e.preventDefault()
    e.stopPropagation()
    drag.current = { mode, startX: e.clientX, startY: e.clientY, rect: { ...px } }
    e.currentTarget.setPointerCapture(e.pointerId)
    onInteractStart()
  }

  const move = (e: ReactPointerEvent<HTMLElement>): void => {
    const state = drag.current
    if (!state) return
    e.preventDefault()

    const dx = (e.clientX - state.startX) / scale
    const dy = (e.clientY - state.startY) / scale
    const s = state.rect
    let { x, y, w, h } = s

    const mode = state.mode
    if (mode === 'move') {
      x = s.x + dx
      y = s.y + dy
    } else {
      if (mode.includes('e')) w = s.w + dx
      if (mode.includes('w')) {
        w = s.w - dx
        x = s.x + dx
      }
      if (mode.includes('s')) h = s.h + dy
      if (mode.includes('n')) {
        h = s.h - dy
        y = s.y + dy
      }

      if (aspect) {
        const corner = mode.length === 2
        if (corner) {
          if (Math.abs(w - s.w) >= Math.abs(h - s.h)) h = w / aspect
          else w = h * aspect
          if (mode.includes('w')) x = s.x + s.w - w
          if (mode.includes('n')) y = s.y + s.h - h
        } else if (mode === 'e' || mode === 'w') {
          h = w / aspect
          y = s.y + (s.h - h) / 2
        } else {
          w = h * aspect
          x = s.x + (s.w - w) / 2
        }
      }

      if (w < MIN_PX) {
        if (mode.includes('w')) x -= MIN_PX - w
        w = MIN_PX
        if (aspect) h = w / aspect
      }
      if (h < MIN_PX) {
        if (mode.includes('n')) y -= MIN_PX - h
        h = MIN_PX
        if (aspect) w = h * aspect
      }
    }

    // 限制在画布内
    w = Math.min(w, canvasW)
    h = Math.min(h, canvasH)
    x = Math.max(0, Math.min(x, canvasW - w))
    y = Math.max(0, Math.min(y, canvasH - h))

    onChange({ x: x / canvasW, y: y / canvasH, w: w / canvasW, h: h / canvasH }, false)
  }

  const end = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!drag.current) return
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    onInteractEnd()
  }

  const shadeTop = { left: 0, top: 0, width: '100%' as const, height: box.top }
  const shadeBottom = { left: 0, top: box.top + box.height, width: '100%' as const, height: `calc(100% - ${box.top + box.height}px)` }
  const shadeLeft = { left: 0, top: box.top, width: box.left, height: box.height }
  const shadeRight = {
    left: box.left + box.width,
    top: box.top,
    width: `calc(100% - ${box.left + box.width}px)`,
    height: box.height
  }

  return (
    <div className="crop-layer">
      <div className="crop-shade" style={shadeTop} />
      <div className="crop-shade" style={shadeBottom} />
      <div className="crop-shade" style={shadeLeft} />
      <div className="crop-shade" style={shadeRight} />

      <div
        className="crop-box"
        style={box}
        onPointerDown={(e) => begin(e, 'move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {grid && (
          <>
            <div className="crop-grid-line" style={{ left: '33.33%', top: 0, width: 1, height: '100%' }} />
            <div className="crop-grid-line" style={{ left: '66.66%', top: 0, width: 1, height: '100%' }} />
            <div className="crop-grid-line" style={{ top: '33.33%', left: 0, height: 1, width: '100%' }} />
            <div className="crop-grid-line" style={{ top: '66.66%', left: 0, height: 1, width: '100%' }} />
          </>
        )}
        {HANDLES.map((dir) => (
          <div
            key={dir}
            className="crop-handle"
            data-dir={dir}
            onPointerDown={(e) => begin(e, dir)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
        ))}
      </div>
    </div>
  )
}
