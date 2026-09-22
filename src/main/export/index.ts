import { promises as fs } from 'node:fs'
import sharp from 'sharp'
import type { ExportOptions } from '@shared/types'
import { encodeBmp } from '../decode/bmp'
import { encodeTiff16 } from './tiff'

/** 显示域 16bit RGB -> 8bit RGB */
function toRgb8(display: Uint16Array): Buffer {
  const out = Buffer.allocUnsafe(display.length)
  for (let i = 0; i < display.length; i++) out[i] = display[i] >> 8
  return out
}

/** 以 raw RGB 构造 sharp 管线：像素已完成调色与 sRGB 编码，这里只做编码 */
function rawPipeline(rgb8: Buffer, width: number, height: number): ReturnType<typeof sharp> {
  return sharp(rgb8, { raw: { width, height, channels: 3 }, limitInputPixels: false })
}

export interface EncodeInput {
  display: Uint16Array
  width: number
  height: number
  options: ExportOptions
  provenanceSummary?: string
}

/** 按目标格式编码并写入磁盘，返回文件字节数 */
export async function encodeAndWrite(input: EncodeInput): Promise<number> {
  const { display, width, height, options } = input
  const { format, quality, tiffBitDepth, dpi, filePath } = options

  if (format === 'tiff' && tiffBitDepth === 16) {
    const buf = encodeTiff16({ rgb16: display, width, height, dpi, description: input.provenanceSummary })
    await fs.writeFile(filePath, buf)
    return buf.length
  }

  const rgb8 = toRgb8(display)
  const pipeline = rawPipeline(rgb8, width, height)

  let buf: Buffer
  switch (format) {
    case 'jpeg':
      buf = await pipeline
        .jpeg({ quality, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0', mozjpeg: true })
        .withMetadata({ density: dpi })
        .toBuffer()
      break
    case 'png':
      buf = await pipeline.png({ compressionLevel: 9 }).withMetadata({ density: dpi }).toBuffer()
      break
    case 'tiff':
      buf = await pipeline.tiff({ compression: 'lzw' }).withMetadata({ density: dpi }).toBuffer()
      break
    case 'bmp':
      buf = encodeBmp(rgb8, width, height, dpi)
      break
    default:
      throw new Error(`不支持的导出格式: ${format}`)
  }

  await fs.writeFile(filePath, buf)
  return buf.length
}
