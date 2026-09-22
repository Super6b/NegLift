import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canActivateConfiguration, configurationIssues, createConfigurationRevision, filmIdentityKey, parseFidelityConfigurationDocument, type FidelityConfiguration } from '../src/shared/fidelityConfiguration'
import { FidelityConfigurationStore } from '../src/main/fidelityConfigurations'

const now = '2026-09-22T00:00:00.000Z'
const reference = (identifier: string) => ({ identifier, confirmedAt: now })
function verified(id = 'config-1'): FidelityConfiguration {
  return {
    schemaVersion: 1, id, lineageId: 'lineage-1', revision: 1, name: '受控 Gold 200 翻拍', status: 'draft',
    film: { manufacturer: 'Kodak', model: 'Gold 200', iso: 200 },
    capture: { camera: 'Sony A7 IV', lens: 'Macro 90mm', magnification: '1:1', backlight: '固定背光 5600K', rawDecoderVersion: 'LibRaw 0.21', inputColorProfile: '相机配置文件 v1' },
    references: { filmBase: reference('片基边'), greyScale: reference('灰阶卡'), colorTarget: reference('色彩卡') },
    thresholds: { id: 'threshold-1', revision: 1, colorDeltaE2000Max: 3, neutralDeviationMax: 2, frameConsistencyMax: 2, channelClippingMax: 0.01 },
    qaEvidence: { passed: true, attestedAt: now, attestedBy: '操作者', measurements: [
      { metric: 'colorDeltaE2000', value: 2, unit: 'ΔE2000', measuredAt: now, operator: '操作者', method: '目标测量', referenceIdentifier: '色彩卡' },
      { metric: 'neutralDeviation', value: 1, unit: 'ΔE2000', measuredAt: now, operator: '操作者', method: '目标测量', referenceIdentifier: '灰阶卡' },
      { metric: 'frameConsistency', value: 1, unit: 'ΔE2000', measuredAt: now, operator: '操作者', method: '重复采集', referenceIdentifier: '色彩卡' },
      { metric: 'channelClipping', value: 0, unit: '比例', measuredAt: now, operator: '操作者', method: '直方图检查', referenceIdentifier: '色彩卡' }
    ] },
    revalidation: { maxRolls: 10, maxDays: 30, lastFullRevalidationAt: now, rollsSinceFullRevalidation: 0, lastShortCheckAt: now },
    adjustmentLimits: { exposureEv: { min: -0.5, max: 0.5 }, whiteBalanceKelvin: { min: -200, max: 200 } },
    visualReview: { displayName: '显示器', displayProfile: 'Display ICC', systemDisplaySettings: '默认', reviewedAt: now, reviewedBy: '操作者' },
    sourceReference: { sha256: 'a'.repeat(64), originalPath: 'D:/captures/gold.arw' }, createdAt: now
  }
}
async function run(): Promise<void> {
  const complete = verified()
  assert.equal(filmIdentityKey(complete.film), 'kodak:gold 200:200')
  assert.equal(canActivateConfiguration(complete), true)
  const incomplete = verified('draft-1'); incomplete.references.colorTarget = null; incomplete.qaEvidence = null
  assert.deepEqual(configurationIssues(incomplete).sort(), ['缺少保真验收证据', '缺少色彩目标参考物'].sort())
  const revision = createConfigurationRevision(complete, 'config-2', '2026-10-01T00:00:00.000Z', { thresholds: { ...complete.thresholds, id: 'threshold-2', revision: 2, colorDeltaE2000Max: 2 } })
  assert.equal(revision.superseded.status, 'superseded'); assert.equal(revision.superseded.supersededBy, 'config-2')
  assert.equal(revision.revision.status, 'draft'); assert.equal(revision.revision.qaEvidence, null); assert.equal(revision.revision.revision, 2)
  const dir = await mkdtemp(join(tmpdir(), 'neglift-fidelity-')); const store = new FidelityConfigurationStore(join(dir, 'configurations.json'))
  await assert.rejects(() => store.saveDraft({ id: 'bad' } as FidelityConfiguration), /未找到有效/)
  await store.saveDraft(complete); const active = await store.activate(complete.id); assert.equal(active.status, 'active')
  const revised = await store.revise(active.id, 'config-3', '2026-10-02T00:00:00.000Z', { name: '重新标定 Gold 200' })
  assert.equal(revised.revision.status, 'draft'); assert.equal((await store.list()).length, 2)
  const exported = await store.exportJson(); assert.equal(parseFidelityConfigurationDocument(exported).configurations.length, 2)
  assert.match(await readFile(join(dir, 'configurations.json'), 'utf8'), /"schemaVersion": 1/); await assert.rejects(() => store.importJson(exported), /已存在/)
  console.log('保真采集配置测试：生命周期、不可变修订、持久化与导入导出均通过')
}
void run()
