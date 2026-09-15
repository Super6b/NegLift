/**
 * 实时预览渲染 Worker。
 *
 * 渲染进程持有解码后的线性预览数据，所有调色与几何变换都在这里完成，
 * 避免阻塞 UI 线程。Worker 常驻保存源数据，主线程只需发送参数。
 */
import { renderLinear, toRgba8 } from '@shared/pipeline'
import type { FrameMessage, WorkerRequest } from './messages'

const ctx = self as unknown as DedicatedWorkerGlobalScope

let src: Uint16Array | null = null
let srcW = 0
let srcH = 0

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data

  if (msg.type === 'init') {
    src = msg.data
    srcW = msg.width
    srcH = msg.height
    return
  }

  if (!src) return

  const started = performance.now()
  const result = renderLinear(src, srcW, srcH, msg.params, {
    applyCrop: msg.applyCrop,
    scale: msg.scale,
    histogram: msg.histogram
  })
  const pixels = toRgba8(result)

  const frame: FrameMessage = {
    type: 'frame',
    id: msg.id,
    pixels,
    width: result.width,
    height: result.height,
    geometry: result.geometry,
    histogram: result.histogram,
    elapsed: performance.now() - started
  }
  ctx.postMessage(frame, [pixels.buffer])
}
