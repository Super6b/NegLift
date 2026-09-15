/**
 * 批量处理：对多张底片执行「自动定框/去色罩 + 风格模板 → 导出」。
 *
 * 性能：不依赖 GPU 编解码（对 LibRaw 去马赛克 + LUT 色调链收益极低），
 * 改为流水线——在渲染/编码当前张时，后台预解码下一张，把最耗时的
 * RAW 解码时间藏进上一张的 CPU 计算里；sharp 使用多线程做 JPEG/PNG 编码。
 */
import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type {
  BatchFileResult,
  BatchProgress,
  BatchRequest,
  CropRect,
  EditParams,
  TransformParams,
  Vec3
} from '@shared/types'
import { cloneParams } from '@shared/defaults'
import { computeGeometry, decimateLinear, renderLinear } from '@shared/pipeline'
import { detectHolderRect, detectNegative } from '@shared/pipeline/analysis'
import { decodeImage, type DecodeResult } from './decode'
import { encodeAndWrite } from './export'
import { applyModelRepairs } from './inpaint/model'
import { sourceToRegion } from '@shared/pipeline'
import type { CanvasRepairStroke } from '@shared/pipeline/repair'

const ANALYSIS_MAX_EDGE = 1600

const OUT_EXT: Record<BatchRequest['export']['format'], string> = {
  jpeg: 'jpg',
  png: 'png',
  tiff: 'tif',
  bmp: 'bmp',
  dng: 'dng'
}

let cancelFlag = false

export function cancelBatch(): void {
  cancelFlag = true
}

interface PreparedJob {
  index: number
  filePath: string
  fileName: string
  decode: DecodeResult
}

/** 用模板风格 + 每张检测结果组装最终参数 */
function buildParams(
  template: EditParams,
  detected: ReturnType<typeof detectNegative>,
  holder: CropRect | null,
  req: BatchRequest
): EditParams {
  const next = cloneParams(template)

  if (req.autoDetect) {
    next.negative.enabled = true
    next.negative.mode = detected.mode
    next.negative.base = [...detected.base] as Vec3
    next.negative.tRef = detected.tRef
    next.negative.strength = detected.suggestedStrength
    next.negative.alignBlack = [...detected.alignBlack] as Vec3
    next.negative.alignWhite = [...detected.alignWhite] as Vec3
  }

  if (req.autoHolder) {
    next.transform.validArea = holder ? { ...holder } : null
  }

  return next
}

async function decodeQuiet(filePath: string): Promise<DecodeResult> {
  return decodeImage(filePath)
}

async function analyzeAndRender(
  job: PreparedJob,
  template: EditParams,
  req: BatchRequest
): Promise<{ params: EditParams; rendered: ReturnType<typeof renderLinear>; camera?: string }> {
  const analysis = decimateLinear(job.decode.linear, job.decode.width, job.decode.height, ANALYSIS_MAX_EDGE)
  const holderScan: TransformParams['holderScan'] =
    template.transform.holderScan === 'outward' ? 'outward' : 'inward'
  const holder = req.autoHolder
    ? detectHolderRect(analysis.data, analysis.width, analysis.height, holderScan)
    : template.transform.validArea
      ? { ...template.transform.validArea }
      : null
  const detected = detectNegative(
    analysis.data,
    analysis.width,
    analysis.height,
    holder,
    holder,
    template.transform.excludeAreas
  )
  const params = buildParams(template, detected, holder, req)
  const geo = computeGeometry(job.decode.width, job.decode.height, params.transform)
  const longEdge = Math.max(geo.outputWidth, geo.outputHeight)
  const scale = req.export.maxDimension ? Math.min(1, req.export.maxDimension / longEdge) : 1
  const rendered = renderLinear(job.decode.linear, job.decode.width, job.decode.height, params, {
    applyCrop: true,
    scale
  })

  if (params.repairs?.length) {
    const strokes: CanvasRepairStroke[] = []
    const srcLong = Math.max(job.decode.width, job.decode.height)
    for (const st of params.repairs) {
      if (!st.points?.length || st.r <= 0) continue
      const pts: { x: number; y: number }[] = []
      for (const p of st.points) {
        const [u, v] = sourceToRegion(p.x, p.y, job.decode.width, job.decode.height, params.transform, true)
        pts.push({ x: u * rendered.width, y: v * rendered.height })
      }
      if (!pts.length) continue
      strokes.push({
        points: pts,
        r: Math.max(2, st.r * srcLong * scale),
        strength: st.strength ?? 1
      })
    }
    await applyModelRepairs(rendered.data, rendered.width, rendered.height, strokes)
  }

  return { params, rendered, camera: job.decode.camera }
}

async function encodeJob(
  job: PreparedJob,
  rendered: ReturnType<typeof renderLinear>,
  camera: string | undefined,
  req: BatchRequest
): Promise<string> {
  const stem = job.fileName.replace(/\.[^.]+$/, '') || job.fileName
  const outName = `${stem}_neglift.${OUT_EXT[req.export.format]}`
  const outPath = await uniqueOutputPath(req.outputDir, outName)
  await encodeAndWrite({
    display: rendered.data,
    width: rendered.width,
    height: rendered.height,
    options: { ...req.export, filePath: outPath },
    cameraModel: camera
  })
  return outPath
}

/**
 * 执行批量。`onProgress` 在阶段变化时上报；返回全部文件结果。
 *
 * 流水线：`prefetch` 持有下一张的 decode Promise，与当前张的
 * analyze/render/encode 重叠执行。
 */
export async function runBatch(
  req: BatchRequest,
  onProgress: (p: BatchProgress) => void
): Promise<BatchProgress> {
  cancelFlag = false
  const total = req.files.length
  const results: BatchFileResult[] = []
  const template = cloneParams(req.template)

  const emit = (
    index: number,
    fileName: string,
    stage: string,
    progress: number,
    status: BatchProgress['status'] = 'running'
  ): void => {
    const overall =
      status === 'running'
        ? (index + Math.min(1, Math.max(0, progress))) / Math.max(1, total)
        : status === 'finished'
          ? 1
          : index / Math.max(1, total)
    onProgress({
      index,
      total,
      fileName,
      stage,
      progress,
      overall,
      status,
      results: results.map((r) => ({ ...r }))
    })
  }

  const finish = (status: BatchProgress['status'], index: number, fileName: string): BatchProgress => {
    emit(index, fileName, status, 1, status)
    return {
      index,
      total,
      fileName,
      stage: status,
      progress: 1,
      overall: status === 'finished' ? 1 : results.length / Math.max(1, total),
      status,
      results
    }
  }

  let prefetch: Promise<PreparedJob> | null = null

  const startPrefetch = (index: number): void => {
    if (index >= total || cancelFlag) return
    const filePath = req.files[index]
    const fileName = basename(filePath)
    prefetch = decodeQuiet(filePath).then((decode) => ({
      index,
      filePath,
      fileName,
      decode
    }))
    // 预取失败不打断主流程，等轮到该张再报错
    prefetch.catch(() => undefined)
  }

  startPrefetch(0)

  for (let i = 0; i < total; i++) {
    if (cancelFlag) return finish('cancelled', i, basename(req.files[i]))

    const fileName = basename(req.files[i])
    let job: PreparedJob
    try {
      emit(i, fileName, 'decode', 0)
      if (!prefetch) throw new Error('缺少解码任务')
      job = await prefetch
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      results.push({ fileName, ok: false, error: message })
      emit(i, fileName, `error: ${message}`, 1)
      prefetch = null
      startPrefetch(i + 1)
      continue
    }
    prefetch = null

    // 下一张解码与本张处理重叠
    startPrefetch(i + 1)

    if (cancelFlag) return finish('cancelled', i, fileName)

    try {
      emit(i, fileName, 'analyze / render', 0.58)
      const { rendered, camera } = await analyzeAndRender(job, template, req)
      if (cancelFlag) return finish('cancelled', i, fileName)

      emit(i, fileName, 'encode', 0.9)
      const outPath = await encodeJob(job, rendered, camera, req)
      results.push({ fileName, ok: true, output: outPath })
      emit(i, fileName, 'done', 1)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      results.push({ fileName, ok: false, error: message })
      emit(i, fileName, `error: ${message}`, 1)
    }
  }

  const lastName = results.length > 0 ? results[results.length - 1].fileName : ''
  return finish(cancelFlag ? 'cancelled' : 'finished', Math.max(0, total - 1), lastName)
}

/** 输出文件名冲突时追加序号 */
export async function uniqueOutputPath(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = join(dir, name)
  let n = 1
  for (;;) {
    try {
      await fs.access(candidate)
      candidate = join(dir, `${stem}_${n}${ext}`)
      n++
    } catch {
      return candidate
    }
  }
}
