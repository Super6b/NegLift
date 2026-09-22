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

async function testRollLock(): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'neglift-roll-'))
  try {
    const files = [join(dir, 'first.png'), join(dir, 'second.png')]
    for (const [i, file] of files.entries()) {
      const pixels = Buffer.alloc(32 * 32 * 3)
      for (let p = 0; p < pixels.length; p += 3) {
        pixels[p] = i ? 35 : 155
        pixels[p + 1] = i ? 125 : 70
        pixels[p + 2] = i ? 210 : 50
      }
      await sharp(pixels, { raw: { width: 32, height: 32, channels: 3 } }).png().toFile(file)
    }
    const batch = await runBatch({
      files, outputDir: dir, template: createDefaultParams(), autoHolder: false, autoDetect: true,
      export: { format: 'tiff', tiffBitDepth: 16, quality: 90, maxDimension: null, dpi: 300, fidelity: { mode: 'fidelity' } }
    }, () => undefined)
    assert.equal(batch.results.length, 2)
    assert.ok(batch.results.every((result) => result.ok), batch.results.map((result) => result.error).join('; '))
    const records = await Promise.all(batch.results.map(async (result) => JSON.parse(await fs.readFile(`${result.output}.provenance.json`, 'utf8'))))
    assert.deepEqual(records[0].params.negative, records[1].params.negative)
    assert.deepEqual(records[0].fidelity.rollLock, records[1].fidelity.rollLock)
    assert.equal(records[1].fidelity.status, 'trial')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

void main().then(testRollLock).catch((error) => { console.error(error); process.exitCode = 1 })
