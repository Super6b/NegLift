import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { decodeImage } from '../../src/main/decode'
import { encodeAndWrite, writeFidelityProvenance } from '../../src/main/export'
import { runBatch } from '../../src/main/batch'
import { detectHolderRect, detectNegative } from '../../src/shared/pipeline/analysis'
import { decimateLinear, renderLinear } from '../../src/shared/pipeline'
import { createDefaultParams } from '../../src/shared/defaults'
import { decideFidelityExport } from '../../src/shared/fidelityDecision'

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function main(): Promise<void> {
  const files = process.argv.slice(2)
  if (!files.length) throw new Error('Usage: node out/raw-smoke.cjs <local RAW files...>')
  const root = path.resolve('out/reference-smoke')
  await fs.mkdir(root, { recursive: true })
  const outputDir = await fs.mkdtemp(path.join(root, 'run-'))
  const report = []

  for (const file of files) {
    const source = path.resolve(file)
    const decoded = await decodeImage(source, undefined, null)
    assert(decoded.isRaw && !decoded.degraded && decoded.bitsPerSample === 16, `${file}: RAW decode degraded`)
    const analysis = decimateLinear(decoded.linear, decoded.width, decoded.height, 1600)
    const holder = detectHolderRect(analysis.data, analysis.width, analysis.height)
    const detected = detectNegative(analysis.data, analysis.width, analysis.height, holder, holder)
    const params = createDefaultParams()
    params.negative.mode = detected.mode
    params.negative.base = detected.base
    params.negative.tRef = detected.tRef
    params.negative.strength = detected.suggestedStrength
    params.negative.alignBlack = detected.alignBlack
    params.negative.alignWhite = detected.alignWhite
    params.transform.validArea = holder
    const rendered = renderLinear(decoded.linear, decoded.width, decoded.height, params, { applyCrop: true })
    const sourceSha256 = await sha256(source)
    const decision = decideFidelityExport({
      mode: 'fidelity', configuration: null,
      source: { path: source, isRaw: decoded.isRaw, sha256: sourceSha256 },
      params, now: new Date().toISOString()
    })
    assert(decision.status === 'trial' && decision.needsUnverifiedSuffix)
    const output = path.join(outputDir, `${path.parse(source).name}_unverified.tif`)
    const provenance = JSON.stringify({
      schemaVersion: 1, sourcePath: source, sourceSha256,
      fidelity: { status: decision.status, reasons: decision.reasons, configuration: null }, params
    })
    await encodeAndWrite({
      display: rendered.data, width: rendered.width, height: rendered.height,
      options: { filePath: output, format: 'tiff', tiffBitDepth: 16, quality: 90, maxDimension: null, dpi: 300 },
      provenanceSummary: provenance
    })
    await writeFidelityProvenance(output, provenance)
    const metadata = await sharp(output).metadata()
    assert(metadata.width === rendered.width && metadata.height === rendered.height && metadata.depth === 'ushort')
    assert(metadata.hasProfile && metadata.icc?.subarray(36, 40).toString('ascii') === 'acsp')
    const sidecar = JSON.parse(await fs.readFile(`${output}.provenance.json`, 'utf8'))
    assert.equal(sidecar.outputSha256, await sha256(output))
    const preview = path.join(outputDir, `${path.parse(source).name}-preview.jpg`)
    await sharp(output).resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(preview)
    report.push({
      source: path.basename(source), sourceSha256, outputSha256: sidecar.outputSha256,
      camera: decoded.camera, sourceSize: [decoded.width, decoded.height], outputSize: [rendered.width, rendered.height],
      status: decision.status, reasons: decision.reasons, holder, hasIccProfile: metadata.hasProfile,
      output: path.relative(process.cwd(), output), preview: path.relative(process.cwd(), preview)
    })
  }
  if (files.length > 1) {
    const batch = await runBatch({
      files, outputDir, template: createDefaultParams(), autoHolder: true, autoDetect: true,
      export: { format: 'tiff', tiffBitDepth: 16, quality: 90, maxDimension: null, dpi: 300, fidelity: { mode: 'fidelity' } }
    }, () => undefined)
    assert(batch.results.every((result) => result.ok), batch.results.map((result) => result.error).join('; '))
    const records = await Promise.all(batch.results.map(async (result) => JSON.parse(await fs.readFile(`${result.output}.provenance.json`, 'utf8'))))
    assert(records.every((record) => record.fidelity.status === 'trial'))
    assert(batch.results.every((result) => result.output && path.basename(result.output).endsWith('_unverified.tif')))
    const sizes = await Promise.all(batch.results.map(async (result) => sharp(result.output!).metadata()))
    assert(sizes.every((metadata, index) => metadata.width === report[index].sourceSize[0] && metadata.height === report[index].sourceSize[1] && metadata.depth === 'ushort' && metadata.hasProfile))
    assert(records.every((record) => JSON.stringify(record.params.negative) === JSON.stringify(records[0].params.negative)))
    assert(records.every((record) => JSON.stringify(record.fidelity.rollLock) === JSON.stringify(records[0].fidelity.rollLock)))
    console.log(`Batch roll lock: ${batch.results.length} RAW frames passed`)
  }
  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
