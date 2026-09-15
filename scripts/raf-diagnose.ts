/**
 * RAF 解码诊断：尺寸、holder、是否能在较小预览下工作。
 * npx esbuild scripts/raf-diagnose.ts --bundle --platform=node --format=cjs --target=node20 --alias:@shared=./src/shared --external:sharp --external:lightdrift-libraw --outfile=out/raf-diagnose.cjs && node out/raf-diagnose.cjs
 */
import path from 'node:path'
import { detectHolderRect } from '../src/shared/pipeline/analysis'
import { decimateLinear, sourceToRegion } from '../src/shared/pipeline'

const ROOT = path.resolve(__dirname, '..')

async function decodeRaw(filePath: string) {
  const { LibRaw } = await import('lightdrift-libraw')
  const raw = new LibRaw()
  try {
    await raw.loadFile(filePath)
    const md = await raw.getMetadata()
    console.log('meta', {
      make: md.make,
      model: md.model,
      width: md.width,
      height: md.height,
      rawWidth: md.rawWidth,
      rawHeight: md.rawHeight
    })
    await raw.setOutputParams({
      output_bps: 16,
      gamma: [1, 1, 0, 0, 0, 0],
      no_auto_bright: true,
      output_color: 1,
      use_camera_wb: true,
      use_camera_matrix: 1,
      user_qual: 0,
      highlight: 0,
      output_tiff: false
    })
    await raw.processImage()
    const img = await raw.dcrawMakeMemImage()
    console.log('img', {
      w: img.width,
      h: img.height,
      colors: img.colors,
      bits: img.bits,
      bytes: img.data?.length
    })
    const pixels = img.width * img.height
    const out = new Uint16Array(pixels * 3)
    if (img.bits === 16) {
      const src = new Uint16Array(img.data.buffer, img.data.byteOffset, Math.floor(img.data.length / 2))
      if (img.colors === 3) out.set(src.subarray(0, out.length))
      else {
        const ch = img.colors
        for (let i = 0, s = 0, d = 0; i < pixels; i++, s += ch, d += 3) {
          out[d] = src[s]
          out[d + 1] = src[s + 1]
          out[d + 2] = src[s + 2]
        }
      }
    } else {
      for (let i = 0; i < out.length; i++) out[i] = img.data[i] * 257
    }
    return { linear: out, width: img.width, height: img.height }
  } finally {
    try {
      await raw.close()
    } catch {}
  }
}

async function main() {
  const file = process.argv[2] || path.join(ROOT, 'raw pic', 'DSCF5048.RAF')
  console.log('decode', file)
  const t0 = Date.now()
  const dec = await decodeRaw(file)
  console.log('decoded in', Date.now() - t0, 'ms', dec.width, 'x', dec.height)

  const an = decimateLinear(dec.linear, dec.width, dec.height, 1600)
  const holder = detectHolderRect(an.data, an.width, an.height)
  console.log('holder', holder)

  // 模拟 sourceToRegion 全幅 validArea
  const area = holder ?? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }
  const samples: [number, number][] = [
    [0.5, 0.5],
    [area.x + area.w / 2, area.y + area.h / 2],
    [0.2, 0.2],
    [0.8, 0.8]
  ]
  for (const [u, v] of samples) {
    const p = sourceToRegion(u, v, dec.width, dec.height, {
      rotate90: 0,
      angle: 0,
      flipH: false,
      flipV: false,
      crop: null,
      aspect: null,
      validArea: area,
      excludeAreas: [],
      holderScan: 'inward'
    }, true)
    console.log('sourceToRegion', u, v, '->', p)
  }

  // 大 canvas 估算
  const long = Math.max(dec.width, dec.height)
  console.log('full-res overlay canvas would be', long * 2, 'x', Math.round((dec.height / dec.width) * long * 2), '(dpr=2)')
}

void main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
