/** 可交付格式；DNG 仅作为相机原始输入，不能作为 NegLift 输出。 */
export type ExportFormat = 'jpeg' | 'png' | 'tiff' | 'bmp'

/** 将旧版保存的 DNG 导出选择安全迁移为 16 位 TIFF。 */
export function normalizeExportFormat(format: unknown): ExportFormat {
  return format === 'dng' ? 'tiff' : format === 'jpeg' || format === 'png' || format === 'bmp' ? format : 'tiff'
}

/** 兼容旧版保存的导出请求，并把 DNG 文件名改为 TIFF 文件名。 */
export function migrateExportOptions<T extends { filePath: string; format: unknown; tiffBitDepth: 8 | 16 }>(options: T): Omit<T, 'format' | 'filePath' | 'tiffBitDepth'> & {
  format: ExportFormat
  filePath: string
  tiffBitDepth: 8 | 16
} {
  const legacyDng = options.format === 'dng'
  return {
    ...options,
    format: normalizeExportFormat(options.format),
    filePath: legacyDng ? options.filePath.replace(/\.[^.\\/]+$/, '.tif') : options.filePath,
    tiffBitDepth: legacyDng ? 16 : options.tiffBitDepth
  }
}
