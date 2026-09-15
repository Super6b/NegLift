import type { EditParams, Histogram } from '@shared/types'
import type { GeometryInfo } from '@shared/pipeline'

export interface InitMessage {
  type: 'init'
  /** 线性 RGB 预览数据（Uint16 交错），会以 Transferable 方式移交 */
  data: Uint16Array
  width: number
  height: number
}

export interface RenderMessage {
  type: 'render'
  id: number
  params: EditParams
  applyCrop: boolean
  /** 输出缩放比例，拖动时用较小值换取帧率 */
  scale: number
  histogram: boolean
}

export type WorkerRequest = InitMessage | RenderMessage

export interface FrameMessage {
  type: 'frame'
  id: number
  pixels: Uint8ClampedArray
  width: number
  height: number
  geometry: GeometryInfo
  histogram?: Histogram
  /** 本次渲染耗时（毫秒） */
  elapsed: number
}

export type WorkerResponse = FrameMessage
