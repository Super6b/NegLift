/**
 * 预览渲染器的统一接口。
 *
 * GPU（WebGL2）与 CPU（Web Worker + LUT 色调链）两条实现必须输出一致画面，
 * 宿主组件只依赖这个接口，因此可以按能力自动选择或随时回退。
 */
import type { EditParams, Histogram } from '@shared/types'

/** CPU 路径单帧渲染像素上限（Web Worker + JS 色调链） */
export const CPU_MAX_RENDER_PIXELS = 4_000_000
/** GPU 路径单帧渲染像素上限：可渲染到接近视口原始分辨率 */
export const GPU_MAX_RENDER_PIXELS = 24_000_000

export interface PreviewFrame {
  width: number
  height: number
  histogram: Histogram | null
  /** 本次渲染耗时（毫秒） */
  elapsed: number
}

export interface PreviewRenderer {
  /** 渲染目标画布，由引擎持有，宿主负责挂载到 DOM */
  readonly canvas: HTMLCanvasElement
  /** 渲染后端标识，用于界面展示 */
  readonly backend: 'gpu' | 'cpu'
  /** 单帧渲染像素上限：GPU 可承受远高于 CPU 的输出尺寸 */
  readonly maxRenderPixels: number
  onFrame: ((frame: PreviewFrame) => void) | null
  /** 载入线性 RGB16 源数据（Uint16 交错） */
  load(data: Uint16Array, width: number, height: number): void
  /** 请求渲染一帧 */
  request(params: EditParams, applyCrop: boolean, scale: number, histogram: boolean): void
  dispose(): void
}
