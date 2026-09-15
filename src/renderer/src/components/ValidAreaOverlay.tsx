import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { CropRect, TransformParams } from '@shared/types'
import { regionToSource, sourceToRegion } from '@shared/pipeline'

type HandleDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move' | 'draw'

const MIN_PX = 24
const HANDLE_HIT = 14
/** overlay canvas 缓冲上限：大图 100% 缩放时 stage 可达数千像素，超限会直接崩 */
const OVERLAY_MAX_BUFFER = 1600

interface Props {
  validArea: CropRect | null
  srcW: number
  srcH: number
  transform: TransformParams
  applyCrop: boolean
  stageW: number
  stageH: number
  /** 松手时提交一次（拖拽过程中不写 store，避免掉帧） */
  onCommit: (rect: CropRect | null) => void
  onInteractStart: () => void
  onInteractEnd: () => void
}

interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
}

interface DragState {
  mode: HandleDir
  startX: number
  startY: number
  startBox: ScreenRect
  moved: boolean
}

function projectRect(
  area: CropRect,
  srcW: number,
  srcH: number,
  transform: TransformParams,
  applyCrop: boolean,
  stageW: number,
  stageH: number
): ScreenRect {
  const corners: [number, number][] = [
    [area.x, area.y],
    [area.x + area.w, area.y],
    [area.x + area.w, area.y + area.h],
    [area.x, area.y + area.h]
  ]
  const pts = corners.map(([u, v]) => sourceToRegion(u, v, srcW, srcH, transform, applyCrop))
  const xs = pts.map((p) => p[0] * stageW)
  const ys = pts.map((p) => p[1] * stageH)
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  const x1 = Math.max(...xs)
  const y1 = Math.max(...ys)
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

function clampRect(r: ScreenRect, stageW: number, stageH: number): ScreenRect {
  const w = Math.max(MIN_PX, Math.min(stageW, r.w))
  const h = Math.max(MIN_PX, Math.min(stageH, r.h))
  const x = Math.min(Math.max(0, r.x), stageW - w)
  const y = Math.min(Math.max(0, r.y), stageH - h)
  return { x, y, w, h }
}

function screenToValid(
  r: ScreenRect,
  stageW: number,
  stageH: number,
  srcW: number,
  srcH: number,
  transform: TransformParams,
  applyCrop: boolean
): CropRect {
  const a = regionToSource(r.x / stageW, r.y / stageH, srcW, srcH, transform, applyCrop)
  const b = regionToSource(
    (r.x + r.w) / stageW,
    (r.y + r.h) / stageH,
    srcW,
    srcH,
    transform,
    applyCrop
  )
  const x0 = Math.max(0, Math.min(a[0], b[0]))
  const y0 = Math.max(0, Math.min(a[1], b[1]))
  const x1 = Math.min(1, Math.max(a[0], b[0]))
  const y1 = Math.min(1, Math.max(a[1], b[1]))
  return { x: x0, y: y0, w: Math.max(1e-4, x1 - x0), h: Math.max(1e-4, y1 - y0) }
}

function handlePos(dir: HandleDir, box: ScreenRect): [number, number] {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  switch (dir) {
    case 'nw':
      return [box.x, box.y]
    case 'n':
      return [cx, box.y]
    case 'ne':
      return [box.x + box.w, box.y]
    case 'e':
      return [box.x + box.w, cy]
    case 'se':
      return [box.x + box.w, box.y + box.h]
    case 's':
      return [cx, box.y + box.h]
    case 'sw':
      return [box.x, box.y + box.h]
    case 'w':
      return [box.x, cy]
    default:
      return [cx, cy]
  }
}

function applyDrag(mode: HandleDir, s: ScreenRect, dx: number, dy: number): ScreenRect {
  if (mode === 'move') {
    return clampRect({ x: s.x + dx, y: s.y + dy, w: s.w, h: s.h }, 1e6, 1e6)
  }
  if (mode === 'draw') {
    const x = Math.min(s.x, s.x + dx)
    const y = Math.min(s.y, s.y + dy)
    const w = Math.abs(dx)
    const h = Math.abs(dy)
    return { x, y, w: Math.max(1, w), h: Math.max(1, h) }
  }

  let { x, y, w, h } = s
  if (mode.includes('e')) w = s.w + dx
  if (mode.includes('s')) h = s.h + dy
  if (mode.includes('w')) {
    x = s.x + dx
    w = s.w - dx
  }
  if (mode.includes('n')) {
    y = s.y + dy
    h = s.h - dy
  }
  // 允许向内收缩，也允许向外扩大到舞台边缘
  w = Math.max(MIN_PX, w)
  h = Math.max(MIN_PX, h)
  if (mode.includes('w')) x = s.x + s.w - w
  if (mode.includes('n')) y = s.y + s.h - h
  if (mode.includes('e')) x = s.x
  if (mode.includes('s')) y = s.y
  // 边/角贴到舞台边界时锁住
  if (x < 0) {
    w += x
    x = 0
  }
  if (y < 0) {
    h += y
    y = 0
  }
  if (x + w > 1e6) w = 1e6 - x
  if (y + h > 1e6) h = 1e6 - y
  return { x, y, w: Math.max(MIN_PX, w), h: Math.max(MIN_PX, h) }
}

const EDGE_DIRS: HandleDir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/**
 * 片夹手动排除：单层 canvas 接收全部指针事件。
 * 拖拽过程只更新本地盒子，松手才写入 store——避免每帧触发全图重渲染。
 */
export function ValidAreaOverlay({
  validArea,
  srcW,
  srcH,
  transform,
  applyCrop,
  stageW,
  stageH,
  onCommit,
  onInteractStart,
  onInteractEnd
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const boxRef = useRef<ScreenRect | null>(
    validArea ? projectRect(validArea, srcW, srcH, transform, applyCrop, stageW, stageH) : null
  )
  const [tick, setTick] = useState(0)
  const force = useCallback(() => setTick((t) => t + 1), [])

  // 外部改写（自动识别 / 撤销）时同步本地盒子；拖拽中不打断
  useEffect(() => {
    if (dragRef.current) return
    boxRef.current = validArea
      ? projectRect(validArea, srcW, srcH, transform, applyCrop, stageW, stageH)
      : null
    force()
  }, [validArea, srcW, srcH, transform, applyCrop, stageW, stageH, force])

  const paint = useCallback((): void => {
    const canvas = canvasRef.current
    if (!canvas || stageW <= 0 || stageH <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // 缓冲分辨率封顶，CSS 仍铺满 stage；坐标全部按 stage 逻辑像素绘制
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const bw = Math.max(1, Math.min(OVERLAY_MAX_BUFFER, Math.round(stageW * dpr)))
    const bh = Math.max(1, Math.min(OVERLAY_MAX_BUFFER, Math.round(stageH * dpr)))
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
    }
    ctx.setTransform(bw / stageW, 0, 0, bh / stageH, 0, 0)
    ctx.clearRect(0, 0, stageW, stageH)

    const box = boxRef.current
    if (!box) {
      ctx.strokeStyle = 'rgba(240, 163, 94, 0.45)'
      ctx.setLineDash([6, 4])
      ctx.lineWidth = 1.5
      ctx.strokeRect(4.5, 4.5, stageW - 9, stageH - 9)
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(240, 163, 94, 0.9)'
      ctx.font = '13px sans-serif'
      ctx.fillText('拖拽框出有效画面（可整幅）', 12, 22)
      return
    }

    // 外侧遮罩
    ctx.fillStyle = 'rgba(0, 0, 0, 0.48)'
    ctx.fillRect(0, 0, stageW, box.y)
    ctx.fillRect(0, box.y + box.h, stageW, Math.max(0, stageH - box.y - box.h))
    ctx.fillRect(0, box.y, box.x, box.h)
    ctx.fillRect(box.x + box.w, box.y, Math.max(0, stageW - box.x - box.w), box.h)

    ctx.strokeStyle = '#f0a35e'
    ctx.lineWidth = 1.5
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, Math.max(1, box.w - 1), Math.max(1, box.h - 1))

    ctx.strokeStyle = 'rgba(240, 163, 94, 0.35)'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.strokeRect(box.x + 6.5, box.y + 6.5, Math.max(0, box.w - 13), Math.max(0, box.h - 13))
    ctx.setLineDash([])

    for (const dir of EDGE_DIRS) {
      const [hx, hy] = handlePos(dir, box)
      ctx.fillStyle = '#f0a35e'
      ctx.strokeStyle = '#1a1206'
      ctx.lineWidth = 1
      const s = HANDLE_HIT
      ctx.beginPath()
      ctx.rect(hx - s / 2, hy - s / 2, s, s)
      ctx.fill()
      ctx.stroke()
    }

    ctx.fillStyle = 'rgba(240, 163, 94, 0.85)'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('拖动手柄调整 · 可向外扩大', box.x + box.w / 2, box.y + box.h / 2)
    ctx.textAlign = 'start'
  }, [stageW, stageH])

  useEffect(() => {
    paint()
  }, [paint, tick])

  const localPos = (e: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  const hitTest = (mx: number, my: number, box: ScreenRect | null): HandleDir => {
    if (!box) return 'draw'
    const pad = HANDLE_HIT
    for (const dir of EDGE_DIRS) {
      const [hx, hy] = handlePos(dir, box)
      if (Math.abs(mx - hx) <= pad && Math.abs(my - hy) <= pad) return dir
    }
    // 框内空白：移动
    if (mx > box.x && mx < box.x + box.w && my > box.y && my < box.y + box.h) return 'move'
    return 'draw'
  }

  const begin = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const [mx, my] = localPos(e)
    const box = boxRef.current
    const mode = hitTest(mx, my, box)
    const startBox: ScreenRect =
      mode === 'draw'
        ? { x: mx, y: my, w: 0, h: 0 }
        : box
          ? { ...box }
          : { x: 0, y: 0, w: stageW, h: stageH }

    dragRef.current = { mode, startX: mx, startY: my, startBox, moved: false }
    onInteractStart()
    e.currentTarget.setPointerCapture(e.pointerId)
    if (mode === 'draw') {
      boxRef.current = null
      force()
    }
  }

  const move = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    e.preventDefault()
    const [mx, my] = localPos(e)
    const dx = mx - drag.startX
    const dy = my - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < 3) return
    drag.moved = true

    const next = applyDrag(drag.mode, drag.startBox, dx, dy)
    boxRef.current =
      drag.mode === 'draw' ? next : clampRect(next, stageW, stageH)
    force()
    paint()
  }

  const end = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }

    const box = boxRef.current
    if (!drag.moved && drag.mode !== 'draw') {
      // 点击不改区域
      force()
      onInteractEnd()
      return
    }

    if (!box || box.w < MIN_PX || box.h < MIN_PX) {
      // 拖出过小：恢复
      boxRef.current = validArea
        ? projectRect(validArea, srcW, srcH, transform, applyCrop, stageW, stageH)
        : null
      force()
      onInteractEnd()
      return
    }

    const clamped = clampRect(box, stageW, stageH)
    boxRef.current = clamped
    force()
    onCommit(screenToValid(clamped, stageW, stageH, srcW, srcH, transform, applyCrop))
    onInteractEnd()
  }

  return (
    <canvas
      className="valid-area-layer"
      ref={canvasRef}
      style={{ width: '100%', height: '100%', cursor: 'default' }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    />
  )
}
