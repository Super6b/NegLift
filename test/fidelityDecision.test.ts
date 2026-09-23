import assert from 'node:assert/strict'
import { createDefaultParams } from '../src/shared/defaults'
import { createFidelityRollLock, decideFidelityExport, fidelityOutputPath, restorationParentReference } from '../src/shared/fidelityDecision'
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
const source = { sha256: 'a'.repeat(64), isRaw: true, path: 'C:/source.arw', camera: '相机', lens: '镜头', degraded: false }
const valid = { mode: 'fidelity' as const, configuration, source, params: createDefaultParams(), now, shortCheckPassed: true, shortCheckAt: now }
assert.equal(decideFidelityExport(valid).status, 'verified-user-attested')
assert.match(decideFidelityExport({ ...valid, shortCheckAt: undefined }).reasons.join(' '), /缺少本卷简短检查/)
assert.equal(fidelityOutputPath('C:/exports/frame.jpg', decideFidelityExport({ mode: 'fidelity', configuration: null, source, params: valid.params, now })), 'C:/exports/frame_unverified.tif')
assert.match(decideFidelityExport({ ...valid, shortCheckPassed: undefined }).reasons.join(' '), /缺少本卷简短检查/)
assert.match(decideFidelityExport({ ...valid, shortCheckPassed: false }).reasons.join(' '), /简短检查未通过/)
assert.match(decideFidelityExport({ ...valid, source: { ...source, camera: '其他相机' } }).reasons.join(' '), /相机型号不符/)
assert.match(decideFidelityExport({ ...valid, source: { ...source, lens: '其他镜头' } }).reasons.join(' '), /镜头不符/)
assert.match(decideFidelityExport({ ...valid, source: { ...source, degraded: true } }).reasons.join(' '), /降级/)
assert.match(decideFidelityExport({ ...valid, configuration: { ...configuration, sourceReference: { sha256: 'b'.repeat(64), originalPath: source.path } } }).reasons.join(' '), /校验值不符/)
assert.equal(decideFidelityExport({ ...valid, source: { ...source, path: 'C:/next-frame.arw', sha256: 'c'.repeat(64) }, configuration: { ...configuration, sourceReference: { sha256: source.sha256!, originalPath: source.path } } }).status, 'verified-user-attested')
assert.match(decideFidelityExport({ ...valid, source: { ...source, sha256: null } }).reasons.join(' '), /缺少源文件校验值/)
const lock = createFidelityRollLock(valid.params, configuration)
assert.equal(decideFidelityExport({ ...valid, rollLock: lock }).status, 'verified-user-attested')
const nextFrame = createDefaultParams(); nextFrame.basic.temperature = 50; nextFrame.basic.exposure = 0.5
assert.equal(decideFidelityExport({ ...valid, params: nextFrame, rollLock: lock }).status, 'verified-user-attested')
nextFrame.negative.tRef += 0.1
assert.match(decideFidelityExport({ ...valid, params: nextFrame, rollLock: lock }).reasons.join(' '), /整卷锁定/)
assert.match(decideFidelityExport({ ...valid, rollLock: lock, configuration: { ...configuration, thresholds: { ...configuration.thresholds, colorDeltaE2000Max: 4 } } }).reasons.join(' '), /整卷锁定/)
assert.equal(decideFidelityExport({ mode: 'fidelity', configuration: null, source, params: createDefaultParams(), now }).status, 'trial')
const restored = createDefaultParams(); restored.denoise.enabled = true
assert.equal(decideFidelityExport({ mode: 'fidelity', configuration, source, params: restored, now }).status, 'unverified')
assert.equal(decideFidelityExport({ mode: 'fidelity', configuration, source, params: restored, now,
  parent: { sourcePath: source.path, sourceSha256: source.sha256!, status: 'verified-user-attested' } }).status, 'restoration')
assert.equal(decideFidelityExport({ mode: 'fidelity', configuration, source: { ...source, isRaw: false }, params: createDefaultParams(), now }).status, 'unverified')
const warm = createDefaultParams(); warm.basic.temperature = 300
assert.match(decideFidelityExport({ mode: 'fidelity', configuration, source, params: warm, now }).reasons.join(' '), /白平衡调整超出配置范围/)
const parent = { sourcePath: 'E:/exports/parent.tif', sourceSha256: 'b'.repeat(64), fidelity: { status: 'verified-user-attested' } }
assert.deepEqual(restorationParentReference(JSON.stringify({ sourcePath: parent.sourcePath, sourceSha256: parent.sourceSha256, outputSha256: 'c'.repeat(64), fidelity: { status: 'restoration', parent } })), {
  path: parent.sourcePath, sha256: parent.sourceSha256, childSha256: 'c'.repeat(64)
})
assert.equal(restorationParentReference(JSON.stringify({ sourcePath: parent.sourcePath, sourceSha256: parent.sourceSha256, fidelity: { status: 'restoration', parent: { ...parent, fidelity: { status: 'unverified' } } } })), null)
assert.equal(restorationParentReference(JSON.stringify({ sourcePath: parent.sourcePath, sourceSha256: parent.sourceSha256, fidelity: { status: 'unverified', parent } })), null)
assert.equal(restorationParentReference(JSON.stringify({ sourcePath: 'wrong.tif', sourceSha256: parent.sourceSha256, fidelity: { status: 'restoration', parent } })), null)
assert.equal(restorationParentReference('invalid'), null)
console.log('保真导出决策测试通过')
