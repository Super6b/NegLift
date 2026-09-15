import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { CropRect, TransformParams } from '@shared/types'
import { regionToSource, sourceToRegion } from '@shared/pipeline'

interface Props {
  /** 排除区域，归一化原图坐标 */
  areas: CropRect[]
  srcW: number
  srcH: number
  transform: TransformParams
  applyCrop: boolean
  /** 舞台 CSS 像素尺寸 */
  stageW: number
  stageH: number
  onAdd: (rect: CropRect) => void
  onRemove: (index: number) => void
  onInteractStart: () => void
  onInteractEnd: () => void
}

/** 拖出小于该尺寸视为点击（用于删除已标记的区域） */
const MIN_DRAG_PX = 6
const FILL = 'rgba(255, 96, 96, 0.26)'
const STROKE = 'rgba(255, 120, 120, 0.95)'
const OVERLAY_MAX_BUFFER = 1600

type Quad = [number, number][]

/** 排除区域投影到当前输出坐标后的四个角 */
function projectQuad(
  area: CropRect,
  srcW: number,
  srcH: number,
  transform: TransformParams,
  applyCrop: boolean
): Quad {
  const corners: [number, number][] = [
    [area.x, area.y],
    [area.x + area.w, area.y],
    [area.x + area.w, area.y + area.h],
    [area.x, area.y + area.h]
  ]
  return corners.map(([u, v]) => sourceToRegion(u, v, srcW, srcH, transform, applyCrop))
}

/** 点是否落在四边形内（射线法），用于点击删除 */
function inQuad(quad: Quad, u: number, v: number): boolean {
  let inside = false
  for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
    const [xi, yi] = quad[i]
    const [xj, yj] = quad[j]
    if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

interface DragState {
  startX: number
  startY: number
  curX: number
  curY: number
  moved: boolean
}

/**
 * 特殊区域排除的选择层。
 *
 * 显示在预览之上，用鼠标拖拽框出齿孔 / 漏光边等不应参与去色罩统计的区域；
 * 在已有区域上单击可将其删除。区域以**原图坐标**保存，因此旋转、裁切后
 * 仍牢牢贴在胶片上。
 */
export function ExcludeOverlay({
  areas,
  srcW,
  srcH,
  transform,
  applyCrop,
  stageW,
  stageH,
  onAdd,
  onRemove,
  onInteractStart,
  onInteractEnd
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<DragState | null>(null)

  const quads = useMemo(
    () => areas.map((a) => projectQuad(a, srcW, srcH, transform, applyCrop)),
    [areas, srcW, srcH, transform, applyCrop]
  )

  const paint = useCallback((): void => {
    const canvas = canvasRef.current
    if (!canvas || stageW <= 0 || stageH <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const bw = Math.max(1, Math.min(OVERLAY_MAX_BUFFER, Math.round(stageW * dpr)))
    const bh = Math.max(1, Math.min(OVERLAY_MAX_BUFFER, Math.round(stageH * dpr)))
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
    }
    ctx.setTransform(bw / stageW, 0, 0, bh / stageH, 0, 0)
    ctx.clearRect(0, 0, stageW, stageH)

    for (const quad of quads) {
      ctx.beginPath()
      quad.forEach(([u, v], i) => {
        const x = u * stageW
        const y = v * stageH
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.closePath()
      ctx.fillStyle = FILL
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = STROKE
      ctx.stroke()
    }

    const drag = dragRef.current
    if (drag?.moved) {
      const x = Math.min(drag.startX, drag.curX)
      const y = Math.min(drag.startY, drag.curY)
      const w = Math.abs(drag.curX - drag.startX)
      const h = Math.abs(drag.curY - drag.startY)
      ctx.fillStyle = FILL
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = STROKE
      ctx.strokeRect(x + 0.5, y + 0.5, w, h)
    }
  }, [quads, stageW, stageH])

  useEffect(() => paint(), [paint])

  const localPos = (e: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  const begin = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const [x, y] = localPos(e)
    dragRef.current = { startX: x, startY: y, curX: x, curY: y, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const move = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    e.preventDefault()
    const [x, y] = localPos(e)
    drag.curX = x
    drag.curY = y
    if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) >= MIN_DRAG_PX) {
      drag.moved = true
      onInteractStart()
    }
    paint()
  }

  const end = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)

    if (!drag.moved) {
      // 未拖动 => 点击：命中已有区域则删除
      const u = drag.startX / stageW
      const v = drag.startY / stageH
      for (let i = quads.length - 1; i >= 0; i--) {
        if (inQuad(quads[i], u, v)) {
          onRemove(i)
          return
        }
      }
      paint()
      return
    }

    onInteractEnd()
    // 屏幕上的拖拽框映射回原图坐标；旋转情况下取包围盒
    const a = regionToSource(drag.startX / stageW, drag.startY / stageH, srcW, srcH, transform, applyCrop)
    const b = regionToSource(drag.curX / stageW, drag.curY / stageH, srcW, srcH, transform, applyCrop)
    const x0 = Math.max(0, Math.min(a[0], b[0]))
    const y0 = Math.max(0, Math.min(a[1], b[1]))
    const x1 = Math.min(1, Math.max(a[0], b[0]))
    const y1 = Math.min(1, Math.max(a[1], b[1]))
    if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) {
      paint()
      return
    }
    onAdd({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
  }

  return (
    <canvas
      className="exclude-layer"
      ref={canvasRef}
      style={{ width: '100%', height: '100%' }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onClick={(e) => e.stopPropagation()}
    />
  )
}
