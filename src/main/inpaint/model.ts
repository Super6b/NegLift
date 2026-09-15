/**
 * 本地 ONNX 修补：已停用（效果不佳）。
 * 导出/批量/预览均不再调用模型，仅保留经典扩散修补。
 */
import type { CanvasRepairStroke } from '@shared/pipeline/repair'

/** 恒为空操作：关闭本地模型路径 */
export async function applyModelRepairs(
  _data: Uint16Array,
  _width: number,
  _height: number,
  _strokes: CanvasRepairStroke[]
): Promise<boolean> {
  return false
}

export function clearModel(): void {
  /* no-op */
}

export function getModelStatus(): {
  available: boolean
  path: string | null
  name: string | null
  source?: 'builtin' | 'user' | null
  error?: string
} {
  return { available: false, path: null, name: null, source: null }
}

export function modelsDir(): string {
  return ''
}

export async function listModelFiles(): Promise<string[]> {
  return []
}

export async function ensureModelsDir(): Promise<string> {
  return ''
}

export async function loadModel(_path: string): Promise<ReturnType<typeof getModelStatus>> {
  return getModelStatus()
}

export async function autoLoadLastModel(): Promise<ReturnType<typeof getModelStatus>> {
  return getModelStatus()
}

export function builtinModelCandidates(): string[] {
  return []
}
