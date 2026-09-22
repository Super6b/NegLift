import { createDefaultParams } from './defaults'
import type { EditParams } from './types'
import { configurationIssues, type FidelityConfiguration } from './fidelityConfiguration'

export type FidelityMode = 'practical' | 'fidelity'
export type FidelityExportStatus = 'practical' | 'trial' | 'verified-user-attested' | 'unverified' | 'restoration'

export interface FidelitySourceIdentity {
  sha256: string | null
  isRaw: boolean
  path: string
}

export interface FidelityDecisionInput {
  mode: FidelityMode
  configuration: FidelityConfiguration | null
  source: FidelitySourceIdentity
  params: EditParams
  now: string
  shortCheckPassed?: boolean
}

export interface FidelityDecision {
  status: FidelityExportStatus
  reasons: string[]
  verified: boolean
  needsUnverifiedSuffix: boolean
  requiresTiff16: boolean
}

export interface ParentFidelityReference {
  sourcePath: string
  sourceSha256: string
  status: FidelityExportStatus
}

const DEFAULT = createDefaultParams()
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** 读取父导出嵌入的最小保真溯源信息；损坏或非保真数据一律忽略。 */
export function parentFidelityReference(text: string): ParentFidelityReference | null {
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object') return null
    const record = value as { sourcePath?: unknown; sourceSha256?: unknown; fidelity?: { status?: unknown } }
    const status = record.fidelity?.status
    if (
      typeof record.sourcePath !== 'string' ||
      typeof record.sourceSha256 !== 'string' ||
      !['practical', 'trial', 'verified-user-attested', 'unverified', 'restoration'].includes(String(status))
    ) return null
    return { sourcePath: record.sourcePath, sourceSha256: record.sourceSha256, status: status as FidelityExportStatus }
  } catch {
    return null
  }
}

/** A saved restoration can be compared only with its recorded, verified parent. */
export function restorationParentReference(text: string): { path: string; sha256: string } | null {
  try {
    const record = JSON.parse(text) as { sourcePath?: unknown; sourceSha256?: unknown; fidelity?: { status?: unknown; parent?: { sourcePath?: unknown; sourceSha256?: unknown; fidelity?: { status?: unknown } } } }
    const parent = record?.fidelity?.parent
    if (record?.fidelity?.status !== 'restoration' || parent?.fidelity?.status !== 'verified-user-attested' ||
      typeof parent.sourcePath !== 'string' || !parent.sourcePath ||
      typeof parent.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(parent.sourceSha256) ||
      record.sourcePath !== parent.sourcePath || record.sourceSha256 !== parent.sourceSha256) return null
    return { path: parent.sourcePath, sha256: parent.sourceSha256 }
  } catch {
    return null
  }
}

/** 保真之外的像素改变一律构成修复派生文件。 */
export function isRestorationParams(params: EditParams): boolean {
  return params.denoise.enabled || params.repairs.length > 0 ||
    !same(params.curves, DEFAULT.curves) || !same(params.hsl, DEFAULT.hsl) || !same(params.grading, DEFAULT.grading) ||
    params.basic.contrast !== 0 || params.basic.highlights !== 0 || params.basic.shadows !== 0 ||
    params.basic.whites !== 0 || params.basic.blacks !== 0 || params.basic.saturation !== 0 || params.basic.vibrance !== 0
}

function qaIssues(configuration: FidelityConfiguration): string[] {
  const evidence = configuration.qaEvidence
  if (!evidence) return []
  const value = (metric: string): number | undefined => evidence.measurements.find((item) => item.metric === metric)?.value
  const checks: [string, number, number][] = [
    ['色彩误差超过验收阈值', value('colorDeltaE2000') ?? Infinity, configuration.thresholds.colorDeltaE2000Max],
    ['中性偏差超过验收阈值', value('neutralDeviation') ?? Infinity, configuration.thresholds.neutralDeviationMax],
    ['跨帧偏差超过验收阈值', value('frameConsistency') ?? Infinity, configuration.thresholds.frameConsistencyMax],
    ['逐通道裁切超过验收阈值', value('channelClipping') ?? Infinity, configuration.thresholds.channelClippingMax]
  ]
  return checks.filter(([, actual, max]) => actual > max).map(([reason]) => reason)
}

function expired(configuration: FidelityConfiguration, now: string): string[] {
  const result: string[] = []
  const last = configuration.revalidation.lastFullRevalidationAt
  if (!last) result.push('缺少完整复测记录')
  else if (Date.parse(now) - Date.parse(last) > configuration.revalidation.maxDays * 86_400_000) result.push('完整复测已过期')
  if (configuration.revalidation.rollsSinceFullRevalidation >= configuration.revalidation.maxRolls) result.push('已达到完整复测卷数上限')
  return result
}

export function decideFidelityExport(input: FidelityDecisionInput): FidelityDecision {
  if (input.mode === 'practical') return { status: 'practical', reasons: [], verified: false, needsUnverifiedSuffix: false, requiresTiff16: false }
  if (isRestorationParams(input.params)) return { status: 'restoration', reasons: ['包含创意调色、降噪或修补处理'], verified: false, needsUnverifiedSuffix: false, requiresTiff16: false }
  if (!input.configuration) return { status: 'trial', reasons: ['未选择已验证采集配置'], verified: false, needsUnverifiedSuffix: true, requiresTiff16: true }

  const reasons = configurationIssues(input.configuration)
  if (input.configuration.status !== 'active') reasons.push(input.configuration.status === 'superseded' ? '采集配置已被取代' : '采集配置尚未激活')
  if (!input.source.isRaw) reasons.push('源文件不是可验证的相机原始图像')
  if (!input.source.sha256) reasons.push('缺少源文件校验值')
  if (input.shortCheckPassed === false) reasons.push('本卷简短检查未通过')
  if (input.params.basic.exposure < input.configuration.adjustmentLimits.exposureEv.min || input.params.basic.exposure > input.configuration.adjustmentLimits.exposureEv.max) reasons.push('曝光调整超出配置范围')
  // 当前调节器以温度偏移量表达白平衡；配置的范围以同一偏移单位记录。
  if (input.params.basic.temperature < input.configuration.adjustmentLimits.whiteBalanceKelvin.min || input.params.basic.temperature > input.configuration.adjustmentLimits.whiteBalanceKelvin.max) reasons.push('白平衡调整超出配置范围')
  reasons.push(...qaIssues(input.configuration), ...expired(input.configuration, input.now))
  if (reasons.length) return { status: 'unverified', reasons: [...new Set(reasons)], verified: false, needsUnverifiedSuffix: true, requiresTiff16: true }
  return { status: 'verified-user-attested', reasons: [], verified: true, needsUnverifiedSuffix: false, requiresTiff16: true }
}
