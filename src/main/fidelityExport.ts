import type { EditParams, ExportOptions } from '@shared/types'
import type { FidelityConfiguration } from '@shared/fidelityConfiguration'
import { decideFidelityExport, fidelityOutputPath, isRestorationParams, type FidelityDecision } from '@shared/fidelityDecision'
import type { DecodeResult } from './decode'
import { hashFile, verifiedParent } from './verifiedParent'

export async function prepareFidelityExport(
  sourcePath: string,
  decode: DecodeResult,
  params: EditParams,
  options: ExportOptions,
  configuration: FidelityConfiguration | null
): Promise<{ decision: FidelityDecision; options: ExportOptions; provenance: string }> {
  const requested = options.fidelity
  const sourceSha256 = requested?.mode === 'fidelity' ? await hashFile(sourcePath) : null
  const needsParent = requested?.mode === 'fidelity' && isRestorationParams(params)
  const prior = needsParent && sourceSha256 ? await verifiedParent(sourcePath, sourceSha256) : null
  if (needsParent && !prior) {
    throw new Error('修复派生文件需要已验证的父版及其完整谱系记录；请重新导出父版，或使用实用转换。')
  }
  const parent = prior ? { sourcePath, sourceSha256: prior.sha256, fidelity: { status: 'verified-user-attested' as const } } : null
  const changes = prior
    ? Object.fromEntries(Object.entries(params).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(prior.params[key as keyof EditParams])))
    : null
  const decision = decideFidelityExport({
    mode: requested?.mode ?? 'practical', configuration, params,
    source: { path: sourcePath, isRaw: decode.isRaw, sha256: sourceSha256, camera: decode.camera, lens: decode.lens, degraded: decode.degraded },
    now: new Date().toISOString(), shortCheckPassed: requested?.shortCheckPassed, shortCheckAt: requested?.shortCheckAt,
    rollLock: requested?.rollLock,
    parent: parent ? { sourcePath, sourceSha256: parent.sourceSha256, status: 'verified-user-attested' } : null
  })
  const output: ExportOptions = { ...options, filePath: fidelityOutputPath(options.filePath, decision) }
  if (decision.requiresTiff16) { output.format = 'tiff'; output.tiffBitDepth = 16 }
  const provenance = JSON.stringify({
    schemaVersion: 1, sourcePath, sourceSha256,
    fidelity: { status: decision.status, reasons: decision.reasons, configuration, requested, parent, changes }, params
  })
  return { decision, options: output, provenance }
}
