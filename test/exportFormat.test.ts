import { migrateExportOptions, normalizeExportFormat } from '../src/shared/exportFormat'

const cases: [unknown, string][] = [
  ['jpeg', 'jpeg'],
  ['png', 'png'],
  ['tiff', 'tiff'],
  ['bmp', 'bmp'],
  ['dng', 'tiff'],
  ['unknown', 'tiff'],
  [null, 'tiff']
]

for (const [input, expected] of cases) {
  const actual = normalizeExportFormat(input)
  if (actual !== expected) throw new Error(`${String(input)} 应迁移为 ${expected}，实际为 ${actual}`)
}

console.log(`导出格式迁移测试通过：${cases.length}/${cases.length}`)

const migrated = migrateExportOptions({ filePath: 'C:\\exports\\frame.dng', format: 'dng', tiffBitDepth: 8 as const })
if (migrated.format !== 'tiff' || migrated.filePath !== 'C:\\exports\\frame.tif' || migrated.tiffBitDepth !== 16) {
  throw new Error('旧 DNG 导出请求必须迁移为 16 位 TIFF 和 .tif 文件名')
}
