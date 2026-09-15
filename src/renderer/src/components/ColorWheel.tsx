import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Vec3 } from '@shared/types'

const SQRT_2_3 = Math.sqrt(2 / 3)
const DEG = Math.PI / 180

/**
 * 色相方向单位向量：RGB 三分量和恒为 0，因此色轮上的调整不会改变整体亮度，
 * 只会把色彩往某个方向推。等亮度平面上的极坐标与色相角一一对应。
 */
function hueDir(deg: number): Vec3 {
  const h = deg * DEG
  return [
    Math.cos(h) * SQRT_2_3,
    Math.cos(h - (2 * Math.PI) / 3) * SQRT_2_3,
    Math.cos(h - (4 * Math.PI) / 3) * SQRT_2_3
  ]
}

/** RGB 偏移向量 -> 色轮极坐标（角度为度，半径为 0..1） */
export function offsetsToWheel(v: Vec3): { angle: number; radius: number } {
  const u = SQRT_2_3 * (v[0] - (v[1] + v[2]) / 2)
  const w = ((SQRT_2_3 * Math.sqrt(3)) / 2) * (v[1] - v[2])
  return { angle: Math.atan2(w, u) / DEG, radius: Math.min(1, Math.hypot(u, w) / 100) }
}

function to255(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
}

interface Props {
  label: string
  value: Vec3
  size?: number
  onChange: (value: Vec3, commit: boolean) => void
  onInteractStart?: () => void
  onInteractEnd?: () => void
}

/** 色彩分级色轮：中心为中性，越靠边缘偏移越强，角度决定色相 */
export function ColorWheel({ label, value, size = 86, onChange, onInteractStart, onInteractEnd }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cacheRef = useRef<HTMLCanvasElement | null>(null)
  const dragging = useRef(false)
  const [ready, setReady] = useState(0)

  // 色轮底图与参数无关，只需按尺寸生成一次
  useEffect(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const px = Math.max(48, Math.round(size * dpr))
    const off = document.createElement('canvas')
    off.width = px
    off.height = px
    const ctx = off.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(px, px)
    const c = px / 2
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const dx = x - c + 0.5
        const dy = y - c + 0.5
        const dist = Math.hypot(dx, dy)
        if (dist > c) continue
        const r = dist / c
        const dir = hueDir(Math.atan2(dy, dx) / DEG)
        const i = (y * px + x) * 4
        img.data[i] = to255(0.5 + 0.5 * r * dir[0])
        img.data[i + 1] = to255(0.5 + 0.5 * r * dir[1])
        img.data[i + 2] = to255(0.5 + 0.5 * r * dir[2])
        img.data[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    cacheRef.current = off
    setReady((n) => n + 1)
  }, [size])

  useEffect(() => {
    const canvas = canvasRef.current
    const cache = cacheRef.current
    if (!canvas || !cache) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const px = cache.width
    canvas.width = px
    canvas.height = px
    const c = px / 2

    ctx.clearRect(0, 0, px, px)
    ctx.drawImage(cache, 0, 0)

    ctx.strokeStyle = 'rgba(128,128,128,0.35)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(c, c, c - 0.5, 0, Math.PI * 2)
    ctx.stroke()

    const { angle, radius } = offsetsToWheel(value)
    const x = c + Math.cos(angle * DEG) * radius * (c - 3)
    const y = c + Math.sin(angle * DEG) * radius * (c - 3)
    ctx.beginPath()
    ctx.arc(x, y, Math.max(4, px / 26), 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()
    ctx.strokeStyle = 'rgba(0,0,0,0.65)'
    ctx.lineWidth = 1.4
    ctx.stroke()
  }, [value, ready])

  const apply = useCallback(
    (clientX: number, clientY: number): void => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const radius = rect.width / 2
      const dx = clientX - rect.left - radius
      const dy = clientY - rect.top - radius
      const dist = Math.min(1, Math.hypot(dx, dy) / radius)
      const dir = hueDir((Math.atan2(dy, dx) / DEG))
      onChange([dir[0] * dist * 100, dir[1] * dist * 100, dir[2] * dist * 100], false)
    },
    [onChange]
  )

  const down = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    e.preventDefault()
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    onInteractStart?.()
    apply(e.clientX, e.clientY)
  }

  const move = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!dragging.current) return
    apply(e.clientX, e.clientY)
  }

  const up = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    onInteractEnd?.()
  }

  return (
    <div className="wheel">
      <canvas
        className="wheel-canvas"
        ref={canvasRef}
        style={{ width: size, height: size }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={() => {
          onInteractStart?.()
          onChange([0, 0, 0], false)
          onInteractEnd?.()
        }}
        title="拖动调整，双击复位"
      />
      <span className="wheel-label">{label}</span>
    </div>
  )
}
