/**
 * 轻量 BMP 编解码器。
 * sharp 预编译版未包含 BMP 加载器，这里自行实现最常见的形式：
 * 解码：BI_RGB 的 24/32 位、8 位调色板、以及 BI_BITFIELDS 的 32 位
 * 编码：24 位 BI_RGB（自下而上）
 */

export interface BmpDecoded {
  rgb: Uint8Array
  width: number
  height: number
}

export function decodeBmp(input: Buffer): BmpDecoded {
  if (input.length < 54 || input.readUInt16LE(0) !== 0x4d42) {
    throw new Error('不是有效的 BMP 文件')
  }

  const dataOffset = input.readUInt32LE(10)
  const headerSize = input.readUInt32LE(14)
  const width = input.readInt32LE(18)
  const rawHeight = input.readInt32LE(22)
  const bitCount = input.readUInt16LE(28)
  const compression = input.readUInt32LE(30)

  const topDown = rawHeight < 0
  const height = Math.abs(rawHeight)

  if (width <= 0 || height <= 0) throw new Error('BMP 尺寸无效')
  if (compression !== 0 && compression !== 3) throw new Error(`不支持的 BMP 压缩方式: ${compression}`)
  if (bitCount !== 24 && bitCount !== 32 && bitCount !== 8) {
    throw new Error(`不支持的 BMP 位深: ${bitCount}`)
  }

  const rgb = new Uint8Array(width * height * 3)
  let palette: Uint8Array | null = null

  if (bitCount === 8) {
    const paletteOffset = 14 + headerSize
    const paletteCount = input.readUInt32LE(46) || 256
    palette = new Uint8Array(256 * 3)
    for (let i = 0; i < Math.min(paletteCount, 256); i++) {
      const p = paletteOffset + i * 4
      if (p + 2 >= input.length) break
      palette[i * 3] = input[p + 2]
      palette[i * 3 + 1] = input[p + 1]
      palette[i * 3 + 2] = input[p]
    }
  }

  const srcBpp = bitCount / 8
  const rowStride = Math.floor((bitCount * width + 31) / 32) * 4

  for (let y = 0; y < height; y++) {
    const srcRow = topDown ? y : height - 1 - y
    const rowStart = dataOffset + srcRow * rowStride
    if (rowStart + rowStride > input.length + 4) break

    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 3
      if (bitCount === 8) {
        const idx = input[rowStart + x]
        rgb[di] = palette![idx * 3]
        rgb[di + 1] = palette![idx * 3 + 1]
        rgb[di + 2] = palette![idx * 3 + 2]
      } else {
        const si = rowStart + x * srcBpp
        rgb[di] = input[si + 2]
        rgb[di + 1] = input[si + 1]
        rgb[di + 2] = input[si]
      }
    }
  }

  return { rgb, width, height }
}

/** 将 8bit RGB 数据编码为 24 位 BMP */
export function encodeBmp(rgb: Uint8Array, width: number, height: number, dpi = 300): Buffer {
  const rowStride = Math.floor((24 * width + 31) / 32) * 4
  const pixelBytes = rowStride * height
  const dataOffset = 54
  const out = Buffer.alloc(dataOffset + pixelBytes)

  out.write('BM', 0, 'ascii')
  out.writeUInt32LE(out.length, 2)
  out.writeUInt32LE(0, 6)
  out.writeUInt32LE(dataOffset, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(width, 18)
  out.writeInt32LE(height, 22)
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  out.writeUInt32LE(0, 30)
  out.writeUInt32LE(pixelBytes, 34)
  const ppm = Math.round(dpi / 0.0254)
  out.writeInt32LE(ppm, 38)
  out.writeInt32LE(ppm, 42)
  out.writeUInt32LE(0, 46)
  out.writeUInt32LE(0, 50)

  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y
    let di = dataOffset + y * rowStride
    let si = srcRow * width * 3
    for (let x = 0; x < width; x++) {
      out[di++] = rgb[si + 2]
      out[di++] = rgb[si + 1]
      out[di++] = rgb[si]
      si += 3
    }
  }

  return out
}
