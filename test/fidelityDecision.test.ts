import assert from 'node:assert/strict'
import { createDefaultParams } from '../src/shared/defaults'
import { decideFidelityExport, parentFidelityReference } from '../src/shared/fidelityDecision'
import type { FidelityConfiguration } from '../src/shared/fidelityConfiguration'

const now = '2026-09-22T00:00:00.000Z'
const configuration: FidelityConfiguration = {
  schemaVersion: 1, id: 'c1', lineageId: 'c1', revision: 1, name: '受控配置', status: 'active', createdAt: now,
  film: { manufacturer: 'Kodak', model: 'Gold 200', iso: 200 },
  capture: { camera: '相机', lens: '镜头', magnification: '1:1', backlight: '固定背光', rawDecoderVersion: '版本', inputColorProfile: '色彩配置' },
  references: { filmBase: { identifier: '片基', confirmedAt: now }, greyScale: { identifier: '灰阶', confirmedAt: now }, colorTarget: { identifier: '色彩目标', confirmedAt: now } },
  thresholds: { id: 't1', revision: 1, colorDeltaE2000Max: 3, neutralDeviationMax: 2, frameConsistencyMax: 2, channelClippingMax: 0.01 },
  qaEvidence: { passed: true, attestedAt: now, attestedBy: '操作者', measurements: [
    { metric: 'colorDeltaE2000', value: 2, unit: 'ΔE', measuredAt: now, operator: '操作者', method: '测量', referenceIdentifier: '色彩目标' },
    { metric: 'neutralDeviation', value: 1, unit: 'ΔE', measuredAt: now, operator: '操作者', method: '测量', referenceIdentifier: '灰阶' },
    { metric: 'frameConsistency', value: 1, unit: 'ΔE', measuredAt: now, operator: '操作者', method: '测量', referenceIdentifier: '色彩目标' },
    { metric: 'channelClipping', value: 0, unit: '比例', measuredAt: now, operator: '操作者', method: '测量', referenceIdentifier: '色彩目标' }
  ] },
  revalidation: { maxRolls: 10, maxDays: 30, lastFullRevalidationAt: now, rollsSinceFullRevalidation: 0, lastShortCheckAt: now },
  adjustmentLimits: { exposureEv: { min: -1, max: 1 }, whiteBalanceKelvin: { min: -200, max: 200 } },
  visualReview: { displayName: '显示器', displayProfile: '配置', systemDisplaySettings: '默认', reviewedAt: now, reviewedBy: '操作者' }
}
const source = { sha256: 'a'.repeat(64), isRaw: true, path: 'C:/source.arw' }
assert.equal(decideFidelityExport({ mode: 'fidelity', configuration, source, params: createDefaultParams(), now }).status, 'verified-user-attested')
assert.equal(decideFidelityExport({ mode: 'fidelity', configuration: null, source, params: createDefaultParams(), now }).status, 'trial')
const restored = createDefaultParams(); restored.denoise.enabled = true
assert.equal(decideFidelityExport({ mode: 'fidelity', configuration, source, params: restored, now }).status, 'restoration')
assert.equal(decideFidelityExport({ mode: 'fidelity', configuration, source: { ...source, isRaw: false }, params: createDefaultParams(), now }).status, 'unverified')
const warm = createDefaultParams(); warm.basic.temperature = 300
assert.match(decideFidelityExport({ mode: 'fidelity', configuration, source, params: warm, now }).reasons.join(' '), /白平衡调整超出配置范围/)
assert.deepEqual(
  parentFidelityReference(JSON.stringify({ sourcePath: 'E:/exports/parent.tif', sourceSha256: 'b'.repeat(64), fidelity: { status: 'verified-user-attested' } })),
  { sourcePath: 'E:/exports/parent.tif', sourceSha256: 'b'.repeat(64), status: 'verified-user-attested' }
)
assert.equal(parentFidelityReference('not json'), null)
console.log('保真导出决策测试通过')
