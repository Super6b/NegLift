/**
 * 预览渲染器工厂。
 *
 * 优先使用 WebGL2（GPU）渲染；在缺少 WebGL2、源图超出最大纹理尺寸或
 * 着色器初始化失败时自动回退到 CPU Worker 实现，保证功能永远可用。
 */
import { CpuPreviewEngine } from './cpuRenderer'
import { GpuPreviewEngine, probeGpu } from './gpuRenderer'
import type { PreviewRenderer } from './types'

export type { PreviewFrame, PreviewRenderer } from './types'

export function createPreviewRenderer(width: number, height: number): PreviewRenderer {
  const cap = probeGpu()
  if (cap.available && Math.max(width, height) <= cap.maxTextureSize) {
    try {
      return new GpuPreviewEngine()
    } catch (err) {
      console.warn('[NegLift] GPU 预览初始化失败，已回退到 CPU 渲染：', err)
    }
  }
  return new CpuPreviewEngine()
}
