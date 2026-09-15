import { useCallback, useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { RepairStroke, TransformParams } from '@shared/types'
import { regionToSource, sourceToRegion } from '@shared/pipeline'

const OVERLAY_MAX_BUFFER = 1600

interface Props {
  strokes: RepairStroke[]
  srcW: number
  srcH: number
  transform: TransformParams
  applyCrop: boolean
  stageW: number
  stageH: number
  radius: number
  onCommitStroke: (stroke: RepairStroke) => void
  onClickStroke: (index: number) => void
  onInteractStart: () => void
  onInteractEnd: () => void
}

/**
 * 除尘笔刷：拖拽时**实时**画出路径；松手提交整段笔触。
 * 指针移动时直接重绘 canvas，不依赖 React 状态刷新。
 */
export function RepairOverlay({
  strokes,
  srcW,
  srcH,
  transform,
  applyCrop,
  stageW,
  stageH,
  radius,
  onCommitStroke,
  onClickStroke,
  onInteractStart,
  onInteractEnd
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef(false)
  /** 源图归一化路径 */
  const pathRef = useRef<{ x: number; y: number }[]>([])
  /** 画布像素路径（拖动中，便于快速重绘） */
  const screenPathRef = useRef<{ x: number; y: number }[]>([])
  /** 悬停光标位置（画布像素），null 表示在外 */
  const cursorRef = useRef<{ x: number; y: number } | null>(null)
  const paintRef = useRef<(() => void) | null>(null)

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

    const longEdge = Math.max(srcW, srcH)
    const pxPerSrc = stageW / Math.max(1, srcW)

    const drawFromSrc = (pts: { x: number; y: number }[], rNorm: number, live: boolean): void => {
      if (pts.length === 0) return
      const screen: { x: number; y: number }[] = []
      for (const p of pts) {
        const [u, v] = sourceToRegion(p.x, p.y, srcW, srcH, transform, applyCrop)
        if (u < -0.1 || v < -0.1 || u > 1.1 || v > 1.1) continue
        screen.push({ x: u * stageW, y: v * stageH })
      }
      drawScreen(screen, rNorm, live)
    }

    const drawScreen = (screen: { x: number; y: number }[], rNorm: number, live: boolean): void => {
      if (screen.length === 0) return
      const r = Math.max(5, rNorm * longEdge * pxPerSrc)

      // 笔刷宽度半透明带
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = r * 2
      ctx.strokeStyle = live ? 'rgba(80, 200, 255, 0.35)' : 'rgba(80, 200, 255, 0.2)'
      ctx.beginPath()
      ctx.moveTo(screen[0].x, screen[0].y)
      for (let i = 1; i < screen.length; i++) ctx.lineTo(screen[i].x, screen[i].y)
      if (screen.length === 1) {
        ctx.moveTo(screen[0].x + r, screen[0].y)
        ctx.arc(screen[0].x, screen[0].y, r, 0, Math.PI * 2)
      }
      ctx.stroke()

      // 中心路径线（拖动中更亮，便于跟手）
      ctx.lineWidth = live ? 2 : 1.25
      ctx.strokeStyle = live ? 'rgba(120, 230, 255, 0.98)' : 'rgba(80, 200, 255, 0.9)'
      ctx.beginPath()
      ctx.moveTo(screen[0].x, screen[0].y)
      for (let i = 1; i < screen.length; i++) ctx.lineTo(screen[i].x, screen[i].y)
      if (screen.length === 1) {
        ctx.arc(screen[0].x, screen[0].y, 2, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.stroke()
      }
    }

    for (const st of strokes) {
      drawFromSrc(st.points, st.r, false)
    }
    // 实时路径：优先用屏幕坐标（最快）
    if (screenPathRef.current.length > 0 && dragRef.current) {
      drawScreen(screenPathRef.current, radius, true)
    }

    // 悬停光标：与笔刷半径一致的圆（拖动时不必再画，路径本身已显示）
    const cur = cursorRef.current
    if (cur && !dragRef.current) {
      const r = Math.max(4, radius * longEdge * pxPerSrc)
      ctx.beginPath()
      ctx.arc(cur.x, cur.y, r, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
      ctx.lineWidth = 1.25
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(cur.x, cur.y, r, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.lineWidth = 2.5
      ctx.stroke()
      // 中心点
      ctx.beginPath()
      ctx.arc(cur.x, cur.y, 1.5, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.fill()
    }
  }, [strokes, srcW, srcH, transform, applyCrop, stageW, stageH, radius])

  paintRef.current = paint
  useEffect(() => {
    paint()
  }, [paint])

  /** 拖动中直接重绘，不等 React */
  const repaint = useCallback((): void => {
    paintRef.current?.()
  }, [])

  const local = (e: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  const toSrc = (mx: number, my: number): { x: number; y: number } => {
    const [su, sv] = regionToSource(mx / stageW, my / stageH, srcW, srcH, transform, applyCrop)
    return { x: su, y: sv }
  }

  const hitStroke = (mx: number, my: number): number => {
    const longEdge = Math.max(srcW, srcH)
    const pxPerSrc = stageW / Math.max(1, srcW)
    for (let i = strokes.length - 1; i >= 0; i--) {
      const st = strokes[i]
      const r = Math.max(8, st.r * longEdge * pxPerSrc)
      for (const p of st.points) {
        const [u, v] = sourceToRegion(p.x, p.y, srcW, srcH, transform, applyCrop)
        if (Math.hypot(u * stageW - mx, v * stageH - my) <= r) return i
      }
    }
    return -1
  }

  const begin = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    // 仅左键涂路径；中键交给预览区平移
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const [mx, my] = local(e)
    const hit = hitStroke(mx, my)
    if (hit >= 0) {
      onClickStroke(hit)
      return
    }
    dragRef.current = true
    pathRef.current = [toSrc(mx, my)]
    screenPathRef.current = [{ x: mx, y: my }]
    onInteractStart()
    e.currentTarget.setPointerCapture(e.pointerId)
    repaint()
  }

  const move = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const [mx, my] = local(e)
    cursorRef.current = { x: mx, y: my }
    if (!dragRef.current) {
      // 仅移动光标：直接重绘（轻量）
      repaint()
      return
    }
    e.preventDefault()
    const screen = screenPathRef.current
    const last = screen[screen.length - 1]
    // 屏幕 ~3px 一个点，拖动时跟手
    if (last && Math.hypot(mx - last.x, my - last.y) < 3) return
    screen.push({ x: mx, y: my })
    pathRef.current.push(toSrc(mx, my))
    repaint()
  }

  const leave = (): void => {
    if (dragRef.current) return
    cursorRef.current = null
    repaint()
  }

  const end = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const was = dragRef.current
    dragRef.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    const pts = pathRef.current
    pathRef.current = []
    screenPathRef.current = []
    // 松手后仍显示光标圆（指针还在画布上）
    const [mx, my] = local(e)
    cursorRef.current = { x: mx, y: my }
    repaint()
    if (!was || pts.length === 0) {
      onInteractEnd()
      return
    }
    onCommitStroke({ points: pts, r: radius, strength: 1 })
    onInteractEnd()
  }

  return (
    <canvas
      className="repair-layer"
      ref={canvasRef}
      style={{ width: '100%', height: '100%', cursor: 'none' }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={leave}
    />
  )
}
