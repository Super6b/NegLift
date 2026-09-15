import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { CurvePoint } from '@shared/types'
import { buildCurveLut } from '@shared/pipeline/curve'
import { clamp } from '@shared/pipeline/color'

interface Props {
  points: CurvePoint[]
  color: string
  onChange: (points: CurvePoint[], commit: boolean) => void
  onInteractStart?: () => void
  onInteractEnd?: () => void
}

const PAD = 8
const HIT_RADIUS = 11

/** 单调三次插值曲线编辑器：支持拖动、添加、右键删除控制点 */
export function CurveEditor({ points, color, onChange, onInteractStart, onInteractEnd }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState(260)
  const dragIndex = useRef<number>(-1)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => setSize(canvas.clientWidth || 260))
    observer.observe(canvas)
    setSize(canvas.clientWidth || 260)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)

    const inner = size - PAD * 2

    ctx.strokeStyle = 'rgba(128,128,128,0.22)'
    ctx.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      const p = PAD + (inner * i) / 4
      ctx.beginPath()
      ctx.moveTo(p, PAD)
      ctx.lineTo(p, PAD + inner)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(PAD, p)
      ctx.lineTo(PAD + inner, p)
      ctx.stroke()
    }

    ctx.strokeStyle = 'rgba(128,128,128,0.45)'
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(PAD, PAD + inner)
    ctx.lineTo(PAD + inner, PAD)
    ctx.stroke()
    ctx.setLineDash([])

    const lut = buildCurveLut(points, 256)
    ctx.beginPath()
    for (let i = 0; i <= 256; i++) {
      const x = PAD + (i / 256) * inner
      const y = PAD + inner - lut[i] * inner
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = color
    ctx.lineWidth = 1.8
    ctx.stroke()

    for (const p of points) {
      const x = PAD + p.x * inner
      const y = PAD + inner - p.y * inner
      ctx.beginPath()
      ctx.arc(x, y, 4.5, 0, Math.PI * 2)
      ctx.fillStyle = '#fff'
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }, [points, color, size])

  const toCurve = useCallback(
    (clientX: number, clientY: number): CurvePoint => {
      const canvas = canvasRef.current!
      const rect = canvas.getBoundingClientRect()
      const inner = size - PAD * 2
      const x = Math.min(1, Math.max(0, (clientX - rect.left - PAD) / inner))
      const y = Math.min(1, Math.max(0, 1 - (clientY - rect.top - PAD) / inner))
      return { x, y }
    },
    [size]
  )

  const findPoint = useCallback(
    (clientX: number, clientY: number): number => {
      const canvas = canvasRef.current!
      const rect = canvas.getBoundingClientRect()
      const inner = size - PAD * 2
      let best = -1
      let bestDist = HIT_RADIUS
      points.forEach((p, i) => {
        const dx = clientX - rect.left - (PAD + p.x * inner)
        const dy = clientY - rect.top - (PAD + inner - p.y * inner)
        const dist = Math.hypot(dx, dy)
        if (dist < bestDist) {
          bestDist = dist
          best = i
        }
      })
      return best
    },
    [points, size]
  )

  const handleDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    e.preventDefault()
    const index = findPoint(e.clientX, e.clientY)
    onInteractStart?.()
    if (index >= 0) {
      dragIndex.current = index
    } else {
      const created = toCurve(e.clientX, e.clientY)
      const next = [...points, created].sort((a, b) => a.x - b.x)
      dragIndex.current = next.findIndex((p) => p === created)
      onChange(next, false)
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handleMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const index = dragIndex.current
    if (index < 0) return
    const target = toCurve(e.clientX, e.clientY)
    const next = points.map((p) => ({ ...p }))
    // 首尾端点：y 自由，x 也可拖（黑场/白场点），但不得越过相邻点
    if (index === 0) {
      target.x = Math.min(target.x, next[1].x - 0.005)
      target.y = Math.min(1, Math.max(0, target.y))
    } else if (index === points.length - 1) {
      target.x = Math.max(target.x, next[index - 1].x + 0.005)
      target.y = Math.min(1, Math.max(0, target.y))
    } else {
      target.x = Math.min(Math.max(target.x, next[index - 1].x + 0.005), next[index + 1].x - 0.005)
      target.y = Math.min(1, Math.max(0, target.y))
    }
    next[index] = { x: clamp(target.x, 0, 1), y: clamp(target.y, 0, 1) }
    onChange(next, false)
  }

  const handleUp = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (dragIndex.current < 0) return
    dragIndex.current = -1
    e.currentTarget.releasePointerCapture(e.pointerId)
    onInteractEnd?.()
  }

  const handleContext = (e: ReactMouseEvent<HTMLCanvasElement>): void => {
    e.preventDefault()
    const index = findPoint(e.clientX, e.clientY)
    if (index <= 0 || index >= points.length - 1) return
    onChange(
      points.filter((_, i) => i !== index),
      true
    )
  }

  return (
    <canvas
      className="curve-canvas"
      ref={canvasRef}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onContextMenu={handleContext}
    />
  )
}
