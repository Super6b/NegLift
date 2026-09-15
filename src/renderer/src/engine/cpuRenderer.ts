import type { EditParams } from '@shared/types'
import type { FrameMessage, RenderMessage, WorkerRequest } from './messages'
import { CPU_MAX_RENDER_PIXELS, type PreviewFrame, type PreviewRenderer } from './types'

/**
 * CPU 预览渲染引擎：维护一个常驻 Worker，采用「最新请求优先」策略。
 * 拖动滑块时不断产生新请求，引擎始终丢弃过期的渲染任务，
 * 保证界面只呈现最新参数对应的画面。
 *
 * 作为 GPU 路径不可用时的回退实现，同时也是导出渲染的一致性基准。
 */
export class CpuPreviewEngine implements PreviewRenderer {
  readonly backend = 'cpu' as const
  readonly maxRenderPixels = CPU_MAX_RENDER_PIXELS
  readonly canvas: HTMLCanvasElement

  onFrame: ((frame: PreviewFrame) => void) | null = null

  private worker: Worker | null = null
  private seq = 0
  private sentId = -1
  private busy = false
  private queued: RenderMessage | null = null

  constructor() {
    this.canvas = document.createElement('canvas')
  }

  /** 载入新的源数据，旧的 Worker 会被销毁（源数据通过 Transferable 移交） */
  load(data: Uint16Array, width: number, height: number): void {
    this.dispose()
    const payload = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice()
    this.worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<FrameMessage>) => this.handle(event.data)
    const init: WorkerRequest = { type: 'init', data: payload, width, height }
    this.worker.postMessage(init, [payload.buffer])
  }

  request(params: EditParams, applyCrop: boolean, scale: number, histogram: boolean): void {
    this.queued = { type: 'render', id: ++this.seq, params, applyCrop, scale, histogram }
    this.pump()
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    this.queued = null
    this.busy = false
    this.sentId = -1
  }

  private pump(): void {
    if (this.busy || !this.queued || !this.worker) return
    const msg = this.queued
    this.queued = null
    this.busy = true
    this.sentId = msg.id
    this.worker.postMessage(msg)
  }

  private handle(frame: FrameMessage): void {
    this.busy = false
    if (frame.id === this.sentId) {
      this.blit(frame)
      this.onFrame?.({
        width: frame.width,
        height: frame.height,
        histogram: frame.histogram ?? null,
        elapsed: frame.elapsed
      })
    }
    this.pump()
  }

  /** Worker 回传的是 RGBA8 像素，这里直接画到自持画布上 */
  private blit(frame: FrameMessage): void {
    const canvas = this.canvas
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width
      canvas.height = frame.height
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const image = new ImageData(frame.width, frame.height)
    image.data.set(frame.pixels)
    ctx.putImageData(image, 0, 0)
  }
}
