import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import type { EditParams } from '@shared/types'

export async function hashFile(filePath: string): Promise<string | null> {
  try {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(filePath)) hash.update(chunk)
    return hash.digest('hex')
  } catch { return null }
}

// ponytail: adjacent sidecars only; use an asset catalogue if derivatives move independently.
export async function fidelityDerivative(filePath: string, sha256?: string | null): Promise<{ sha256: string; params: EditParams; status: string } | null> {
  try {
    const record = JSON.parse(await fs.readFile(`${filePath}.provenance.json`, 'utf8')) as {
      fidelity?: { status?: unknown }; outputSha256?: unknown; params?: EditParams
    }
    const actual = sha256 ?? await hashFile(filePath)
    const status = record.fidelity?.status
    if (!['verified-user-attested', 'restoration', 'unverified', 'trial'].includes(String(status)) ||
      !actual || record.outputSha256 !== actual || !record.params) return null
    return { sha256: actual, params: record.params, status: status as string }
  } catch { return null }
}

export async function verifiedParent(filePath: string, sha256?: string | null): Promise<{ sha256: string; params: EditParams } | null> {
  const derivative = await fidelityDerivative(filePath, sha256)
  return derivative?.status === 'verified-user-attested' ? derivative : null
}
