import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react'
import { FolderOpen, Image as ImageIcon } from 'lucide-react'
import { computeGeometry, regionToSource } from '@shared/pipeline'
import { createDefaultParams } from '@shared/defaults'
import { createPreviewRenderer } from '../engine/renderClient'
import { CPU_MAX_RENDER_PIXELS, GPU_MAX_RENDER_PIXELS, type PreviewRenderer } from '../engine/types'
import { useEditor } from '../state/store'
import { CropOverlay } from './CropOverlay'
import { ExcludeOverlay } from './ExcludeOverlay'
import { RepairOverlay } from './RepairOverlay'
import { ValidAreaOverlay } from './ValidAreaOverlay'

export function PreviewArea() {
  const image = useEditor((s) => s.image)
  const params = useEditor((s) => s.params)
  const tool = useEditor((s) => s.tool)
  const zoom = useEditor((s) => s.zoom)
  const compare = useEditor((s) => s.compare)
  const eyedropper = useEditor((s) => s.eyedropper)
  const interacting = useEditor((s) => s.interacting)
  const tab = useEditor((s) => s.tab)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<PreviewRenderer | null>(null)
  /** 缩放后用于把指针下的内容点拉回原位 */
  const zoomAnchorRef = useRef<{ fx: number; fy: number; clientX: number; clientY: number } | null>(null)
  const [backend, setBackend] = useState<'gpu' | 'cpu'>('cpu')
  const [viewport, setViewport] = useState({ w: 0, h: 0 })
  const [dropActive, setDropActive] = useState(false)

  const applyCrop = tool !== 'crop'
  const showDetectionEvidence = tab === 'negative' && tool !== 'holder' && tool !== 'exclude'
  const validAreaPercent = params.transform.validArea ? params.transform.validArea.w * params.transform.validArea.h * 100 : 100
  const maxRenderPixels = backend === 'gpu' ? GPU_MAX_RENDER_PIXELS : CPU_MAX_RENDER_PIXELS

  /** 引擎持有画布，节点挂载后把它接进专用 host，避免与 React 子节点（覆盖层）抢 DOM */
  const attachHost = useCallback((node: HTMLDivElement | null) => {
    hostRef.current = node
    if (node && rendererRef.current) node.replaceChildren(rendererRef.current.canvas)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = (): void => setViewport({ w: el.clientWidth, h: el.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [image])

  /** 对比原片时使用「仅自动去色罩」的参数，方便判断调色幅度 */
  const compareParams = useMemo(() => {
    if (!image) return null
    const p = createDefaultParams()
    p.negative.mode = image.detected.mode
    p.negative.base = [...image.detected.base]
    p.negative.tRef = image.detected.tRef
    p.negative.strength = image.detected.suggestedStrength
    p.negative.alignBlack = [...image.detected.alignBlack]
    p.negative.alignWhite = [...image.detected.alignWhite]
    return p
  }, [image])

  const geo = useMemo(
    () => (image ? computeGeometry(image.meta.width, image.meta.height, params.transform) : null),
    [image, params.transform]
  )

  const regionW = geo ? (applyCrop ? geo.cropW : geo.transformedWidth) : 1
  const regionH = geo ? (applyCrop ? geo.cropH : geo.transformedHeight) : 1

  const viewScale = useMemo(() => {
    if (!viewport.w || !viewport.h || regionW <= 1 || regionH <= 1) return 0
    const fit = Math.min(viewport.w / regionW, viewport.h / regionH)
    return fit * zoom
  }, [viewport, regionW, regionH, zoom])

  const renderScale = useMemo(() => {
    if (!viewScale) return 0
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let s = Math.min(1, viewScale * dpr)
    // CPU 路径在拖动时降精度换帧率；GPU 足够快，始终保持清晰
    if (interacting && backend === 'cpu') s *= 0.62
    const pixels = regionW * regionH * s * s
    if (pixels > maxRenderPixels) s *= Math.sqrt(maxRenderPixels / pixels)
    return Math.max(0.03, s)
  }, [viewScale, regionW, regionH, interacting, backend, maxRenderPixels])

  // 图像变化时重建渲染器（GPU 不可用会自动回退 CPU），并把它的画布挂到舞台上
  useEffect(() => {
    rendererRef.current?.dispose()
    rendererRef.current = null
    if (!image) {
      setBackend('cpu')
      hostRef.current?.replaceChildren()
      return
    }
    const renderer = createPreviewRenderer(image.previewWidth, image.previewHeight)
    rendererRef.current = renderer
    setBackend(renderer.backend)
    renderer.onFrame = (frame) => {
      useEditor.getState().setFrameInfo({
        width: frame.width,
        height: frame.height,
        histogram: frame.histogram,
        elapsed: frame.elapsed
      })
    }
    renderer.load(image.preview, image.previewWidth, image.previewHeight)
    hostRef.current?.replaceChildren(renderer.canvas)
    return () => {
      renderer.onFrame = null
    }
  }, [image])

  // 参数变化 -> 请求新的一帧
  useEffect(() => {
    if (!image || !renderScale) return
    rendererRef.current?.request(compare && compareParams ? compareParams : params, applyCrop, renderScale, true)
  }, [image, params, compare, compareParams, applyCrop, renderScale, backend])

  // 滚轮以指针为中心缩放；按住鼠标拖动平移（交互工具除外）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const interactiveTool = (): boolean => {
      const t = useEditor.getState().tool
      return t === 'heal' || t === 'crop' || t === 'exclude' || t === 'holder' || useEditor.getState().eyedropper
    }

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const stage = stageRef.current
      const { zoom: current, setZoom } = useEditor.getState()
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      if (stage && stage.clientWidth > 0) {
        const sr = stage.getBoundingClientRect()
        zoomAnchorRef.current = {
          fx: (e.clientX - sr.left) / sr.width,
          fy: (e.clientY - sr.top) / sr.height,
          clientX: e.clientX,
          clientY: e.clientY
        }
      } else {
        zoomAnchorRef.current = null
      }
      setZoom(current * factor)
    }

    let pan: { x: number; y: number; sl: number; st: number } | null = null

    const onPointerDown = (e: PointerEvent): void => {
      // 中键始终平移（含除尘/裁切等）；左键在非交互工具下才平移
      if (e.button !== 1 && e.button !== 0) return
      if (!useEditor.getState().image) return
      if (e.button === 0 && interactiveTool()) return
      // 避免中键触发浏览器自动滚屏
      e.preventDefault()
      const target = e.target as HTMLElement | null
      if (e.button === 0 && target?.closest('button, a, input, select, textarea, label')) return
      pan = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop }
      el.setPointerCapture(e.pointerId)
      el.style.cursor = 'grabbing'
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!pan) return
      e.preventDefault()
      el.scrollLeft = pan.sl - (e.clientX - pan.x)
      el.scrollTop = pan.st - (e.clientY - pan.y)
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (!pan) return
      pan = null
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      el.style.cursor = ''
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerUp)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerUp)
    }
  }, [image])

  // 缩放导致舞台尺寸变化后：能完整放下则重新居中；仍溢出则把锚点拉回指针下
  useEffect(() => {
    const anchor = zoomAnchorRef.current
    const el = scrollRef.current
    const stage = stageRef.current
    if (!el || !stage) return
    zoomAnchorRef.current = null

    const frame = requestAnimationFrame(() => {
      const sr = stage.getBoundingClientRect()
      const er = el.getBoundingClientRect()
      if (sr.width < 1 || sr.height < 1) return

      const pad = 36 // 上下左右 padding 约 18*2
      const fits = sr.width + pad <= er.width && sr.height + pad <= er.height
      if (fits) {
        // 完整放入视口：交给 margin:auto 水平/垂直居中，清掉残留滚动
        el.scrollLeft = 0
        el.scrollTop = 0
        return
      }

      if (!anchor) return
      // 内容坐标 = 舞台在滚动内容中的原点 + 指针在舞台内的比例位置
      const contentX = sr.left - er.left + el.scrollLeft + anchor.fx * sr.width
      const contentY = sr.top - er.top + el.scrollTop + anchor.fy * sr.height
      el.scrollLeft = contentX - (anchor.clientX - er.left)
      el.scrollTop = contentY - (anchor.clientY - er.top)
    })
    return () => cancelAnimationFrame(frame)
  }, [viewScale, viewport.w, viewport.h])

  const handleClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (!eyedropper || !image || !geo) return
    const rect = e.currentTarget.getBoundingClientRect()
    const u = (e.clientX - rect.left) / rect.width
    const v = (e.clientY - rect.top) / rect.height
    const [su, sv] = regionToSource(u, v, image.meta.width, image.meta.height, params.transform, applyCrop)
    const { pickBase, setEyedropper } = useEditor.getState()
    setEyedropper(false)
    void pickBase(su, sv)
  }

  const handleDrop = (e: ReactDragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDropActive(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    void useEditor.getState().openFile(file)
  }

  const stage = {
    width: Math.max(1, Math.round(regionW * viewScale)),
    height: Math.max(1, Math.round(regionH * viewScale))
  }

  return (
    <div
      className={`preview-wrap${dropActive ? ' drop-active' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDropActive(true)
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={handleDrop}
    >
      <div className="preview-scroll" ref={scrollRef}>
        {image ? (
          <div
            className="preview-stage"
            ref={stageRef}
            style={{
              ...stage,
              cursor: eyedropper
                ? 'crosshair'
                : tool === 'heal' || tool === 'crop' || tool === 'exclude' || tool === 'holder'
                  ? undefined
                  : 'grab'
            }}
            onClick={handleClick}
          >
            {/* WebGL/CPU 画布只挂在这里；覆盖层是兄弟节点，互不 replaceChildren */}
            <div className="preview-canvas-host" ref={attachHost} />
            {tool === 'crop' && geo && (
              <CropOverlay
                crop={params.transform.crop ?? { x: 0, y: 0, w: 1, h: 1 }}
                aspect={params.transform.aspect}
                canvasW={geo.transformedWidth}
                canvasH={geo.transformedHeight}
                scale={viewScale}
                grid
                onChange={(crop, commit) => useEditor.getState().setCrop(crop, commit)}
                onInteractStart={() => useEditor.getState().beginInteract()}
                onInteractEnd={() => useEditor.getState().endInteract()}
              />
            )}
            {tool === 'holder' && geo && (
              <ValidAreaOverlay
                validArea={params.transform.validArea}
                srcW={image.meta.width}
                srcH={image.meta.height}
                transform={params.transform}
                applyCrop={applyCrop}
                stageW={stage.width}
                stageH={stage.height}
                onCommit={(rect) => useEditor.getState().setValidArea(rect, false)}
                onInteractStart={() => useEditor.getState().beginInteract()}
                onInteractEnd={() => useEditor.getState().endInteract()}
              />
            )}
            {showDetectionEvidence && geo && params.transform.validArea && (
              <ValidAreaOverlay
                validArea={params.transform.validArea}
                srcW={image.meta.width}
                srcH={image.meta.height}
                transform={params.transform}
                applyCrop={applyCrop}
                stageW={stage.width}
                stageH={stage.height}
                onCommit={() => undefined}
                onInteractStart={() => undefined}
                onInteractEnd={() => undefined}
                readOnly
              />
            )}
            {tool === 'heal' && geo && (
              <RepairOverlay
                strokes={params.repairs}
                srcW={image.meta.width}
                srcH={image.meta.height}
                transform={params.transform}
                applyCrop={applyCrop}
                stageW={stage.width}
                stageH={stage.height}
                radius={useEditor.getState().repairRadius}
                onCommitStroke={(stroke) => useEditor.getState().addRepairStroke(stroke, false)}
                onClickStroke={(i) => useEditor.getState().removeRepairSpot(i)}
                onInteractStart={() => useEditor.getState().beginInteract()}
                onInteractEnd={() => useEditor.getState().endInteract()}
              />
            )}
            {tool === 'exclude' && geo && (
              <ExcludeOverlay
                areas={params.transform.excludeAreas}
                srcW={image.meta.width}
                srcH={image.meta.height}
                transform={params.transform}
                applyCrop={applyCrop}
                stageW={stage.width}
                stageH={stage.height}
                onAdd={(rect) => useEditor.getState().addExcludeArea(rect)}
                onRemove={(index) => useEditor.getState().removeExcludeArea(index)}
                onInteractStart={() => useEditor.getState().beginInteract()}
                onInteractEnd={() => useEditor.getState().endInteract()}
              />
            )}
            {showDetectionEvidence && geo && params.transform.excludeAreas.length > 0 && (
              <ExcludeOverlay
                areas={params.transform.excludeAreas}
                srcW={image.meta.width}
                srcH={image.meta.height}
                transform={params.transform}
                applyCrop={applyCrop}
                stageW={stage.width}
                stageH={stage.height}
                onAdd={() => undefined}
                onRemove={() => undefined}
                onInteractStart={() => undefined}
                onInteractEnd={() => undefined}
                readOnly
              />
            )}
          </div>
        ) : (
          <EmptyState />
        )}
      </div>

      {image && (
        <div className="preview-badge">
          <span className="badge" title={backend === 'gpu' ? '预览由显卡渲染' : '预览由 CPU 渲染'}>
            {backend === 'gpu' ? 'GPU 渲染' : 'CPU 渲染'}
          </span>
          {image.meta.isRaw && <span className="badge is-raw">RAW {image.meta.bitsPerSample}bit</span>}
          {image.meta.degraded && <span className="badge is-warn">降级解码</span>}
          {compare && <span className="badge">对比：原片</span>}
          {eyedropper && <span className="badge">点击画面取片基色</span>}
        </div>
      )}
      {image && tab === 'negative' && (
        <div className={`detection-summary${params.negative.mode === 'align' ? ' is-review' : ''}`} role="status">
          <strong>{params.negative.mode === 'align' ? '需要检查：通道对齐' : '已检测片基'}</strong>
          <span>统计区域 {validAreaPercent.toFixed(1)}%</span>
          <span>排除区域 {params.transform.excludeAreas.length} 处</span>
          {params.negative.mode === 'align' && <small>检查肤色与中性色；偏色时使用吸管取样片基。</small>}
        </div>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="empty">
      <ImageIcon size={44} strokeWidth={1.2} />
      <h2>拖入照片开始调色</h2>
      <p>将 RAW 或常见图像文件拖到此处，或点击下方按钮选择文件。</p>
      <button className="btn is-primary" onClick={() => void useEditor.getState().openDialog()}>
        <FolderOpen size={15} /> 打开图片
      </button>
      <div className="formats">
        支持 RAW：CR2 / CR3 / NEF / NRW / ARW / SR2 / RAF / RW2 / ORF / PEF / DNG / RWL / SRW / 3FR / IIQ 等
        <br />
        支持图像：JPEG / PNG / TIFF / WebP / GIF / AVIF / HEIC / BMP
      </div>
    </div>
  )
}
