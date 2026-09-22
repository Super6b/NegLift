/**
 * 极简 TIFF 编码器（16 位 RGB，未压缩，单 strip）。
 *
 * 之所以自行实现：sharp 的 raw 输入固定按 8 位解释，无法直接产出 16 位文件。
 */

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 }

interface IfdEntry {
  tag: number
  type: number
  count: number
  data: Buffer
}

const TAG = {
  NewSubfileType: 254,
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  PhotometricInterpretation: 262,
  StripOffsets: 273,
  Orientation: 274,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  XResolution: 282,
  YResolution: 283,
  PlanarConfiguration: 284,
  ResolutionUnit: 296,
  SampleFormat: 339,
  IccProfile: 34675,
  ImageDescription: 270,
} as const

function short(v: number): Buffer {
  const b = Buffer.allocUnsafe(2)
  b.writeUInt16LE(v, 0)
  return b
}

function long(v: number): Buffer {
  const b = Buffer.allocUnsafe(4)
  b.writeUInt32LE(v >>> 0, 0)
  return b
}

function shorts(values: number[]): Buffer {
  const b = Buffer.allocUnsafe(values.length * 2)
  values.forEach((v, i) => b.writeUInt16LE(v, i * 2))
  return b
}

function rational(numerator: number, denominator: number): Buffer {
  const b = Buffer.allocUnsafe(8)
  b.writeUInt32LE(numerator >>> 0, 0)
  b.writeUInt32LE(denominator >>> 0, 4)
  return b
}

export interface TiffEncodeOptions {
  rgb16: Uint16Array
  width: number
  height: number
  dpi: number
  description?: string
  iccProfile?: Buffer
}

export function encodeTiff16(options: TiffEncodeOptions): Buffer {
  const { rgb16, width, height, dpi } = options
  const samples = width * height * 3
  const pixelBytes = samples * 2

  const entries: IfdEntry[] = []
  const push = (tag: number, type: number, count: number, data: Buffer): void => {
    entries.push({ tag, type, count, data })
  }
  // IFD 条目必须按 tag 升序排列
  push(TAG.NewSubfileType, 4, 1, long(0))
  push(TAG.ImageWidth, 4, 1, long(width))
  push(TAG.ImageLength, 4, 1, long(height))
  push(TAG.BitsPerSample, 3, 3, shorts([16, 16, 16]))
  push(TAG.Compression, 3, 1, short(1))
  push(TAG.PhotometricInterpretation, 3, 1, short(2))
  if (options.description) push(TAG.ImageDescription, 2, Buffer.byteLength(options.description) + 1, Buffer.from(`${options.description}\0`, 'utf8'))
  push(TAG.StripOffsets, 4, 1, long(0)) // 稍后回填
  push(TAG.Orientation, 3, 1, short(1))
  push(TAG.SamplesPerPixel, 3, 1, short(3))
  push(TAG.RowsPerStrip, 4, 1, long(height))
  push(TAG.StripByteCounts, 4, 1, long(pixelBytes))
  push(TAG.XResolution, 5, 1, rational(Math.round(dpi), 1))
  push(TAG.YResolution, 5, 1, rational(Math.round(dpi), 1))
  push(TAG.PlanarConfiguration, 3, 1, short(1))
  push(TAG.ResolutionUnit, 3, 1, short(2))
  push(TAG.SampleFormat, 3, 3, shorts([1, 1, 1]))
  if (options.iccProfile) push(TAG.IccProfile, 7, options.iccProfile.length, options.iccProfile)

  const ifdOffset = 8
  const ifdSize = 2 + entries.length * 12 + 4
  let cursor = ifdOffset + ifdSize
  if (cursor % 2 !== 0) cursor++

  const inlineOffsets = new Map<IfdEntry, number>()
  for (const e of entries) {
    const size = e.count * TYPE_SIZES[e.type]
    if (size > 4) {
      inlineOffsets.set(e, cursor)
      cursor += size
      if (cursor % 2 !== 0) cursor++
    }
  }

  const pixelOffset = cursor
  const total = pixelOffset + pixelBytes
  const out = Buffer.alloc(total)

  // TIFF 头
  out.write('II', 0, 'ascii')
  out.writeUInt16LE(42, 2)
  out.writeUInt32LE(ifdOffset, 4)

  // IFD
  out.writeUInt16LE(entries.length, ifdOffset)
  let p = ifdOffset + 2
  for (const e of entries) {
    const size = e.count * TYPE_SIZES[e.type]
    out.writeUInt16LE(e.tag, p)
    out.writeUInt16LE(e.type, p + 2)
    out.writeUInt32LE(e.count, p + 4)
    if (size > 4) {
      out.writeUInt32LE(inlineOffsets.get(e)!, p + 8)
    } else {
      e.data.copy(out, p + 8, 0, Math.min(size, 4))
      // 长度不足 4 的按 0 填充（Buffer.allocUnsafe 不会清零）
      for (let i = size; i < 4; i++) out[p + 8 + i] = 0
    }
    p += 12
  }
  out.writeUInt32LE(0, p)

  // 外部数据
  for (const e of entries) {
    const off = inlineOffsets.get(e)
    if (off !== undefined) e.data.copy(out, off)
  }

  // 回填 StripOffsets
  const stripEntryIndex = entries.findIndex((e) => e.tag === TAG.StripOffsets)
  out.writeUInt32LE(pixelOffset, ifdOffset + 2 + stripEntryIndex * 12 + 8)

  // 像素数据（本机为小端，Uint16Array 的字节序与 TIFF 要求一致，直接复制）
  Buffer.from(rgb16.buffer, rgb16.byteOffset, rgb16.byteLength).copy(out, pixelOffset)

  return out
}
