import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeAndWrite, writeFidelityProvenance } from '../src/main/export'

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'neglift-restoration-'))
  const parent = join(dir, 'parent.tif')
  const child = join(dir, 'child.tif')
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
    await fs.writeFile(`${child}.provenance.json`, 'existing provenance')
    await assert.rejects(writeFidelityProvenance(child, 'replacement'), { code: 'EEXIST' })
    assert.equal(await fs.readFile(`${child}.provenance.json`, 'utf8'), 'existing provenance')
    await assert.rejects(fs.access(child), { code: 'ENOENT' })
  } finally {
    await fs.unlink(parent).catch(() => undefined)
    await fs.unlink(child).catch(() => undefined)
    await fs.unlink(`${child}.provenance.json`).catch(() => undefined)
    await fs.rmdir(dir)
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
