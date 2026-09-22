/** 保真采集配置的可携带数据模型；导出规则只消费其不可变快照。 */
export const FIDELITY_CONFIGURATION_SCHEMA_VERSION = 1 as const
export type FidelityConfigurationStatus = 'draft' | 'active' | 'superseded'

export interface FilmIdentity { manufacturer: string; model: string; iso: number; notes?: string }
export interface CaptureConditions { camera: string; lens: string; magnification: string; backlight: string; rawDecoderVersion: string; inputColorProfile: string }
export interface ReferenceMaterial { identifier: string; confirmedAt: string }
export interface ReferenceMaterials { filmBase: ReferenceMaterial | null; greyScale: ReferenceMaterial | null; colorTarget: ReferenceMaterial | null }
export interface ThresholdSet { id: string; revision: number; colorDeltaE2000Max: number; neutralDeviationMax: number; frameConsistencyMax: number; channelClippingMax: number }
export type QaMetric = 'colorDeltaE2000' | 'neutralDeviation' | 'frameConsistency' | 'channelClipping'
export interface MeasurementEvidence { metric: QaMetric; value: number; unit: string; measuredAt: string; operator: string; method: string; referenceIdentifier: string; attachmentPath?: string; attachmentSha256?: string }
export interface QaEvidence { measurements: MeasurementEvidence[]; passed: boolean; attestedAt: string; attestedBy: string }
export interface RevalidationSchedule { maxRolls: number; maxDays: number; lastFullRevalidationAt: string | null; rollsSinceFullRevalidation: number; lastShortCheckAt: string | null }
export interface FidelityAdjustmentLimits { exposureEv: { min: number; max: number }; whiteBalanceKelvin: { min: number; max: number } }
export interface VisualReviewConditions { displayName: string; displayProfile: string; systemDisplaySettings: string; reviewedAt: string; reviewedBy: string }
export interface SourceFileReference { sha256: string; originalPath: string; relativePath?: string }

export interface FidelityConfiguration {
  schemaVersion: typeof FIDELITY_CONFIGURATION_SCHEMA_VERSION
  id: string
  lineageId: string
  revision: number
  name: string
  status: FidelityConfigurationStatus
  film: FilmIdentity
  capture: CaptureConditions
  references: ReferenceMaterials
  thresholds: ThresholdSet
  qaEvidence: QaEvidence | null
  revalidation: RevalidationSchedule
  adjustmentLimits: FidelityAdjustmentLimits
  visualReview: VisualReviewConditions | null
  sourceReference?: SourceFileReference
  createdAt: string
  supersededBy?: string
}
export interface FidelityConfigurationDocument { schemaVersion: typeof FIDELITY_CONFIGURATION_SCHEMA_VERSION; configurations: FidelityConfiguration[] }
export interface ConfigurationRevisionResult { superseded: FidelityConfiguration; revision: FidelityConfiguration }

/** 创建最小草稿；向导或导入流程再补齐参考物和测量证据。 */
export function createFidelityConfigurationDraft(id: string, now: string, name = '新的保真采集配置'): FidelityConfiguration {
  return {
    schemaVersion: 1, id, lineageId: id, revision: 1, name, status: 'draft', createdAt: now,
    film: { manufacturer: '', model: '', iso: 0 },
    capture: { camera: '', lens: '', magnification: '', backlight: '', rawDecoderVersion: '', inputColorProfile: '' },
    references: { filmBase: null, greyScale: null, colorTarget: null },
    thresholds: { id: `${id}-thresholds`, revision: 1, colorDeltaE2000Max: 0, neutralDeviationMax: 0, frameConsistencyMax: 0, channelClippingMax: 0 },
    qaEvidence: null,
    revalidation: { maxRolls: 1, maxDays: 1, lastFullRevalidationAt: null, rollsSinceFullRevalidation: 0, lastShortCheckAt: null },
    adjustmentLimits: { exposureEv: { min: 0, max: 0 }, whiteBalanceKelvin: { min: 0, max: 0 } },
    visualReview: null
  }
}

const requiredMetrics: QaMetric[] = ['colorDeltaE2000', 'neutralDeviation', 'frameConsistency', 'channelClipping']
export function filmIdentityKey(film: FilmIdentity): string {
  return [film.manufacturer, film.model, String(film.iso)].map((value) => value.trim().toLocaleLowerCase()).join(':')
}

/** 返回草稿或不可验证的明确原因；空数组表示可以发布为已验证采集配置。 */
export function configurationIssues(configuration: FidelityConfiguration): string[] {
  const issues: string[] = []
  if (!configuration.name.trim()) issues.push('缺少配置名称')
  if (!configuration.film.manufacturer.trim() || !configuration.film.model.trim() || configuration.film.iso <= 0) issues.push('胶片标识不完整')
  for (const [label, value] of Object.entries(configuration.capture)) if (!value.trim()) issues.push(`缺少采集条件：${label}`)
  if (!configuration.references.filmBase) issues.push('缺少片基边参考物')
  if (!configuration.references.greyScale) issues.push('缺少灰阶参考物')
  if (!configuration.references.colorTarget) issues.push('缺少色彩目标参考物')
  const limits = configuration.adjustmentLimits
  if (limits.exposureEv.min > limits.exposureEv.max || limits.whiteBalanceKelvin.min > limits.whiteBalanceKelvin.max) issues.push('逐帧调整范围无效')
  const thresholdValues = Object.entries(configuration.thresholds).filter(([key]) => key.endsWith('Max'))
  if (thresholdValues.some(([, value]) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) issues.push('验收阈值无效')
  if (!configuration.qaEvidence) issues.push('缺少保真验收证据')
  else {
    const metrics = new Set(configuration.qaEvidence.measurements.map((measurement) => measurement.metric))
    if (requiredMetrics.some((metric) => !metrics.has(metric))) issues.push('保真验收证据不完整')
    if (!configuration.qaEvidence.passed) issues.push('保真验收未通过')
  }
  if (!configuration.visualReview) issues.push('缺少视觉质检条件')
  if (configuration.revalidation.maxDays <= 0 || configuration.revalidation.maxRolls <= 0) issues.push('完整复测周期无效')
  return issues
}
export function canActivateConfiguration(configuration: FidelityConfiguration): boolean { return configurationIssues(configuration).length === 0 }

/** 关键条件或阈值变更必须新建修订版，不能借用旧测量结果。 */
export function createConfigurationRevision(
  configuration: FidelityConfiguration,
  nextId: string,
  createdAt: string,
  changes: Partial<Pick<FidelityConfiguration, 'name' | 'film' | 'capture' | 'references' | 'thresholds' | 'revalidation' | 'adjustmentLimits' | 'visualReview' | 'sourceReference'>>
): ConfigurationRevisionResult {
  if (configuration.status === 'superseded') throw new Error('已被取代的配置不能再创建修订版')
  const superseded: FidelityConfiguration = { ...configuration, status: 'superseded', supersededBy: nextId }
  const revision: FidelityConfiguration = { ...configuration, ...changes, id: nextId, lineageId: configuration.lineageId, revision: configuration.revision + 1, status: 'draft', qaEvidence: null, createdAt, supersededBy: undefined }
  return { superseded, revision }
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function isConfiguration(value: unknown): value is FidelityConfiguration {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<FidelityConfiguration>
  const raw = value as Record<string, unknown>
  const film = raw.film
  const capture = raw.capture
  const references = raw.references
  const thresholds = raw.thresholds
  const revalidation = raw.revalidation
  const adjustmentLimits = raw.adjustmentLimits
  return candidate.schemaVersion === FIDELITY_CONFIGURATION_SCHEMA_VERSION && typeof candidate.id === 'string' && typeof candidate.lineageId === 'string' && typeof candidate.revision === 'number' && typeof candidate.name === 'string' && (candidate.status === 'draft' || candidate.status === 'active' || candidate.status === 'superseded') &&
    isRecord(film) && isRecord(capture) && isRecord(references) && isRecord(thresholds) && isRecord(revalidation) && isRecord(adjustmentLimits) &&
    typeof film.manufacturer === 'string' && typeof film.model === 'string' && typeof film.iso === 'number' &&
    ['camera', 'lens', 'magnification', 'backlight', 'rawDecoderVersion', 'inputColorProfile'].every((key) => typeof capture[key] === 'string') &&
    ['colorDeltaE2000Max', 'neutralDeviationMax', 'frameConsistencyMax', 'channelClippingMax'].every((key) => typeof thresholds[key] === 'number') &&
    typeof revalidation.maxDays === 'number' && typeof revalidation.maxRolls === 'number' && isRecord(adjustmentLimits.exposureEv) && isRecord(adjustmentLimits.whiteBalanceKelvin) &&
    typeof candidate.createdAt === 'string'
}

/** 导入仅接受版本化文档；无效文件不能静默变成配置。 */
export function parseFidelityConfigurationDocument(json: string): FidelityConfigurationDocument {
  const value: unknown = JSON.parse(json)
  const configurations = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { configurations?: unknown }).configurations) ? (value as { configurations: unknown[] }).configurations : null
  if (!configurations || configurations.some((configuration) => !isConfiguration(configuration))) throw new Error('未找到有效的保真采集配置文件')
  const ids = new Set<string>()
  for (const configuration of configurations as FidelityConfiguration[]) { if (ids.has(configuration.id)) throw new Error('保真采集配置包含重复标识'); ids.add(configuration.id) }
  return { schemaVersion: FIDELITY_CONFIGURATION_SCHEMA_VERSION, configurations: configurations as FidelityConfiguration[] }
}
export function serializeFidelityConfigurationDocument(configurations: FidelityConfiguration[]): string {
  return `${JSON.stringify({ schemaVersion: FIDELITY_CONFIGURATION_SCHEMA_VERSION, configurations }, null, 2)}\n`
}
