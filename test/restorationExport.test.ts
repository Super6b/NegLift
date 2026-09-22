import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { encodeAndWrite, writeFidelityProvenance } from '../src/main/export'
import { fidelityDerivative, hashFile, verifiedParent } from '../src/main/verifiedParent'
import { createDefaultParams } from '../src/shared/defaults'
import { openSession } from '../src/main/session'
import { runBatch } from '../src/main/batch'
import { resolveDecodeOutputParams } from '../src/shared/cameraProfile'

async function main(): Promise<void> {
  assert.equal(resolveDecodeOutputParams({ id: 'legacy', name: 'legacy', match: {}, decode: { output_color: 2 } }).output_color, 1)
  const dir = await fs.mkdtemp(join(tmpdir(), 'neglift-restoration-'))
  const parent = join(dir, 'parent.tif')
  const child = join(dir, 'child.tif')
  const verified = join(dir, 'verified.tif')
  let batchOutput: string | undefined
  const input = (filePath: string) => ({
    display: new Uint16Array([65535, 0, 0]), width: 1, height: 1, exclusive: true,
    options: { filePath, format: 'tiff' as const, tiffBitDepth: 16 as const, quality: 90, maxDimension: null, dpi: 300 }
  })
  try {
    await fs.writeFile(parent, 'preserved parent')
    await assert.rejects(encodeAndWrite(input(parent)), { code: 'EEXIST' })
    assert.equal(await fs.readFile(parent, 'utf8'), 'preserved parent')
    await encodeAndWrite(input(child))
    assert.ok((await fs.readFile(child)).length > 0)
    const tiff = await sharp(child).metadata()
    assert.equal(tiff.depth, 'ushort')
    assert.equal(tiff.hasProfile, true)
    assert.equal(tiff.icc?.subarray(36, 40).toString('ascii'), 'acsp')
    await encodeAndWrite(input(verified))
    await writeFidelityProvenance(verified, JSON.stringify({ fidelity: { status: 'verified-user-attested' }, params: createDefaultParams() }))
    assert.equal((await verifiedParent(verified))?.sha256, await hashFile(verified))
    assert.equal((await fidelityDerivative(verified))?.status, 'verified-user-attested')
    assert.equal((await openSession(verified)).meta.isFidelityPositive, true)
    const template = createDefaultParams()
    template.basic.contrast = 10
    const batch = await runBatch({
      files: [verified], outputDir: dir, template, autoHolder: false, autoDetect: true,
      export: { format: 'tiff', tiffBitDepth: 16, quality: 90, maxDimension: null, dpi: 300, fidelity: { mode: 'fidelity' } }
    }, () => undefined)
    assert.equal(batch.results[0].ok, true, batch.results[0].error)
    batchOutput = batch.results[0].output
    const childRecord = JSON.parse(await fs.readFile(`${batchOutput}.provenance.json`, 'utf8'))
    assert.equal(childRecord.fidelity.status, 'restoration')
    assert.equal(childRecord.fidelity.parent.sourceSha256, await hashFile(verified))
    assert.equal(childRecord.params.negative.enabled, false)
    assert.equal(childRecord.fidelity.changes.basic.contrast, 10)
    await fs.writeFile(verified, 'tampered pixels')
    assert.equal(await verifiedParent(verified), null)
    const unlinked = join(dir, 'unlinked.tif')
    await encodeAndWrite(input(unlinked))
    try {
      const rejected = await runBatch({
        files: [unlinked], outputDir: dir, template, autoHolder: false, autoDetect: false,
        export: { format: 'tiff', tiffBitDepth: 16, quality: 90, maxDimension: null, dpi: 300, fidelity: { mode: 'fidelity' } }
      }, () => undefined)
      assert.equal(rejected.results[0].ok, false)
      assert.match(rejected.results[0].error ?? '', /已验证的父版/)
    } finally { await fs.unlink(unlinked) }
    await fs.writeFile(`${child}.provenance.json`, 'existing provenance')
    await assert.rejects(writeFidelityProvenance(child, '{"schemaVersion":1}'), { code: 'EEXIST' })
    assert.equal(await fs.readFile(`${child}.provenance.json`, 'utf8'), 'existing provenance')
    await assert.rejects(fs.access(child), { code: 'ENOENT' })
    await encodeAndWrite(input(child))
    await assert.rejects(writeFidelityProvenance(child, 'not json'), SyntaxError)
    await assert.rejects(fs.access(child), { code: 'ENOENT' })
  } finally {
    await fs.unlink(parent).catch(() => undefined)
    await fs.unlink(child).catch(() => undefined)
    await fs.unlink(verified).catch(() => undefined)
    await fs.unlink(`${verified}.provenance.json`).catch(() => undefined)
    if (batchOutput) {
      await fs.unlink(batchOutput).catch(() => undefined)
      await fs.unlink(`${batchOutput}.provenance.json`).catch(() => undefined)
    }
    await fs.unlink(`${child}.provenance.json`).catch(() => undefined)
    await fs.rmdir(dir)
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
