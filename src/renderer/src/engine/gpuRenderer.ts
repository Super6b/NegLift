/**
 * GPU（WebGL2）预览渲染引擎。
 *
 * 逐像素工作全部交给显卡：几何反查 + 双线性采样 + 逐通道色调链 LUT +
 * 饱和度/HSL/色彩分级。CPU 只负责烘焙 LUT 与提交 uniform，
 * 因此可以把输出尺寸提到接近视口原始分辨率，缩放与拖动时依然跟手。
 *
 * 与 CPU 路径共用 `@shared/pipeline` 的几何与色调上下文，保证两条路径画面一致。
 */
import type { EditParams, Histogram } from '@shared/types'
import { computeGeometry, resolveValidArea, sourceToRegion } from '@shared/pipeline'
import { DENOISE_KERNEL, denoiseAmounts, isDenoiseActive } from '@shared/pipeline/denoise'
import { buildHslContext, buildGradeContext } from '@shared/pipeline/grade'
import { LUT_SIZE, bakeChannelLuts, buildToneContext } from '@shared/pipeline/tone'
import { DENOISE_FRAGMENT_SHADER, DOWNSAMPLE_FRAGMENT_SHADER, PREVIEW_FRAGMENT_SHADER, QUAD_VERTEX_SHADER } from './gpuShaders'
import { GPU_MAX_RENDER_PIXELS, type PreviewFrame, type PreviewRenderer } from './types'

const DEG = Math.PI / 180
/** 直方图采样画布边长：小尺寸渲染一次再读回，避免整帧回读 */
const HIST_SIZE = 256
/** 源图 mip 金字塔的最小长边：再小就没有采样价值了 */
const PYRAMID_MIN_EDGE = 64

/** mip 金字塔的一级 */
interface PyramidLevel {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
  width: number
  height: number
}

export interface GpuCapability {
  available: boolean
  maxTextureSize: number
  renderer: string
  reason?: string
}

let cachedCapability: GpuCapability | null = null

/** 探测 WebGL2 能力（结果缓存，同一会话内不变） */
export function probeGpu(): GpuCapability {
  if (cachedCapability) return cachedCapability
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false })
    if (!gl) {
      cachedCapability = { available: false, maxTextureSize: 0, renderer: '', reason: '当前环境不支持 WebGL2' }
      return cachedCapability
    }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'WebGL2'
    cachedCapability = {
      available: true,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      renderer
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  } catch (err) {
    cachedCapability = {
      available: false,
      maxTextureSize: 0,
      renderer: '',
      reason: err instanceof Error ? err.message : String(err)
    }
  }
  return cachedCapability
}

export class GpuPreviewEngine implements PreviewRenderer {
  readonly backend = 'gpu' as const
  /** GPU 下可放心渲染到全视口尺寸（配合源数据上限），远高于 CPU 路径 */
  readonly maxRenderPixels = GPU_MAX_RENDER_PIXELS
  readonly canvas: HTMLCanvasElement

  onFrame: ((frame: PreviewFrame) => void) | null = null

  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private denoiseProgram: WebGLProgram
  private downsampleProgram: WebGLProgram
  private vao: WebGLVertexArrayObject
  private uniforms = new Map<string, WebGLUniformLocation | null>()
  private denoiseUniforms = new Map<string, WebGLUniformLocation | null>()
  private downsampleUniforms = new Map<string, WebGLUniformLocation | null>()
  private srcTex: WebGLTexture
  private lutTex: WebGLTexture
  /** 除尘线段纹理：宽=2*maxSeg，高=1，RGBA32F */
  private repairTex: WebGLTexture | null = null
  private repairTexW = 0
  /** 源图 mip 金字塔：第 0 级即全分辨率源图，之后逐级 2×2 盒平均 */
  private pyramid: PyramidLevel[] = []
  /** 降噪 Pass 的输入：色调链渲染结果（带 mipmap 的离屏纹理） */
  private sceneTex: WebGLTexture | null = null
  private sceneFbo: WebGLFramebuffer | null = null
  private sceneW = 0
  private sceneH = 0
  private histTex: WebGLTexture | null = null
  private histFbo: WebGLFramebuffer | null = null
  private histPixels: Uint8Array | null = null
  private lutData = new Float32Array((LUT_SIZE + 1) * 3)
  /** 持有源数据引用，上下文丢失后可直接重建纹理 */
  private srcData: Uint16Array | null = null
  private srcW = 0
  private srcH = 0
  private lost = false

  constructor() {
    this.canvas = document.createElement('canvas')
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    })
    if (!gl) throw new Error('无法创建 WebGL2 上下文')
    this.gl = gl

    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lost = true
      console.warn('[NegLift] GPU 预览上下文丢失，等待恢复')
    })
    this.canvas.addEventListener('webglcontextrestored', () => {
      try {
        this.histTex = null
        this.histFbo = null
        this.histPixels = null
        this.sceneTex = null
        this.sceneFbo = null
        this.sceneW = 0
        this.sceneH = 0
        this.pyramid = []
        this.repairTex = null
        this.repairTexW = 0
        this.program = this.buildProgram(PREVIEW_FRAGMENT_SHADER)
        this.denoiseProgram = this.buildProgram(DENOISE_FRAGMENT_SHADER)
        this.downsampleProgram = this.buildProgram(DOWNSAMPLE_FRAGMENT_SHADER)
        this.vao = this.buildQuad()
        this.cacheUniforms()
        this.srcTex = this.createSrcTexture()
        this.lutTex = this.createLutTexture()
        this.ensureRepairTexture()
        if (this.srcData) this.uploadSource(this.srcData, this.srcW, this.srcH)
        this.lost = false
        console.info('[NegLift] GPU 预览上下文已恢复')
      } catch (err) {
        console.error('[NegLift] GPU 预览恢复失败：', err)
      }
    })

    this.program = this.buildProgram(PREVIEW_FRAGMENT_SHADER)
    this.denoiseProgram = this.buildProgram(DENOISE_FRAGMENT_SHADER)
    this.downsampleProgram = this.buildProgram(DOWNSAMPLE_FRAGMENT_SHADER)
    this.vao = this.buildQuad()
    this.cacheUniforms()
    this.srcTex = this.createSrcTexture()
    this.lutTex = this.createLutTexture()
    this.ensureRepairTexture()
  }

  load(data: Uint16Array, width: number, height: number): void {
    this.srcData = data
    this.srcW = width
    this.srcH = height
    this.uploadSource(data, width, height)
    this.buildPyramid()
  }

  /**
   * 逐级 2×2 盒平均生成源图金字塔。
   *
   * 缩小显示时如果只用双线性取 4 个源像素，噪声几乎不会被平均掉；
   * 按缩小倍率选取金字塔层级，等于对相应数量的源像素做面积平均。
   */
  private buildPyramid(): void {
    this.releasePyramid()
    const gl = this.gl
    const base: PyramidLevel = { tex: this.srcTex, fbo: null as unknown as WebGLFramebuffer, width: this.srcW, height: this.srcH }
    this.pyramid.push(base)

    gl.useProgram(this.downsampleProgram)
    const du = (n: string): WebGLUniformLocation | null => this.downsampleUniforms.get(n) ?? null
    gl.uniform1i(du('uSrc'), 0)
    gl.bindVertexArray(this.vao)

    let prev = base
    while (Math.max(prev.width, prev.height) > PYRAMID_MIN_EDGE) {
      const w = Math.max(1, prev.width >> 1)
      const h = Math.max(1, prev.height >> 1)
      const tex = gl.createTexture()
      const fbo = gl.createFramebuffer()
      if (!tex || !fbo) break
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      // 必须用 RGBA16UI：WebGL2 里 RGB16UI 不是 color-renderable，无法作为渲染目标
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16UI, w, h, 0, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.warn(`[NegLift] 源图金字塔第 ${this.pyramid.length} 级缓冲不完整（0x${status.toString(16)}），已跳过`)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.activeTexture(gl.TEXTURE0)
        gl.deleteTexture(tex)
        gl.deleteFramebuffer(fbo)
        break
      }
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, prev.tex)
      gl.uniform2i(du('uSrcSize'), prev.width, prev.height)
      gl.uniform2i(du('uDstSize'), w, h)
      gl.viewport(0, 0, w, h)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)

      const level: PyramidLevel = { tex, fbo, width: w, height: h }
      this.pyramid.push(level)
      prev = level
    }

    gl.bindVertexArray(null)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  private releasePyramid(): void {
    const gl = this.gl
    // 第 0 级就是源纹理本身，不在这里释放
    for (let i = 1; i < this.pyramid.length; i++) {
      gl.deleteTexture(this.pyramid[i].tex)
      gl.deleteFramebuffer(this.pyramid[i].fbo)
    }
    this.pyramid = []
  }

  /**
   * 按「每个输出像素覆盖多少源像素」选择金字塔层级。
   *
   * 取最接近的层级（四舍五入）而不是向下取整：向下取整会让实际平均的像素数
   * 比理论需要少最多 4 倍，缩小后残留噪声明显偏多；四舍五入把误差限制在 2 倍以内。
   */
  private selectLevel(minification: number): PyramidLevel {
    const last = this.pyramid.length - 1
    if (last <= 0) return this.pyramid[0]
    const lod = Math.round(Math.log2(Math.max(1, minification)))
    const index = Math.min(last, Math.max(0, lod))
    return this.pyramid[index]
  }

  request(params: EditParams, applyCrop: boolean, scale: number, histogram: boolean): void {
    if (this.lost || !this.srcW || !this.srcH || this.pyramid.length === 0) return
    const started = performance.now()
    const gl = this.gl

    const geo = computeGeometry(this.srcW, this.srcH, params.transform)
    const area = resolveValidArea(this.srcW, this.srcH, params.transform)
    const regionX = applyCrop ? geo.cropX : 0
    const regionY = applyCrop ? geo.cropY : 0
    const regionW = applyCrop ? geo.cropW : geo.transformedWidth
    const regionH = applyCrop ? geo.cropH : geo.transformedHeight

    const ow = Math.max(1, Math.round(regionW * scale))
    const oh = Math.max(1, Math.round(regionH * scale))
    if (this.canvas.width !== ow || this.canvas.height !== oh) {
      this.canvas.width = ow
      this.canvas.height = oh
    }

    // 降噪需要先把色调链结果画到离屏纹理；目标必须在绑定源纹理之前准备好
    const denoise = isDenoiseActive(params.denoise)
    const sceneTarget = denoise ? this.ensureSceneTarget(ow, oh) : null

    // 按缩小倍率选取源图金字塔层级：每个输出像素覆盖 >1 个源像素时，
    // 采样更粗的层级等价于对整片覆盖区域做面积平均，避免缩小后噪声突出。
    const minification = Math.max(regionW / ow, regionH / oh)
    const level = this.selectLevel(minification)
    const lodScaleX = level.width / this.srcW
    const lodScaleY = level.height / this.srcH

    const tone = buildToneContext(params)
    const luts = bakeChannelLuts(tone)
    this.lutData.set(luts[0], 0)
    this.lutData.set(luts[1], LUT_SIZE + 1)
    this.lutData.set(luts[2], (LUT_SIZE + 1) * 2)
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_SIZE + 1, 3, gl.RED, gl.FLOAT, this.lutData)

    const hsl = buildHslContext(params.hsl)
    const grade = buildGradeContext(params.grading)
    const angle = (params.transform.rotate90 * 90 + params.transform.angle) * DEG
    const u = (n: string): WebGLUniformLocation | null => this.uniforms.get(n) ?? null

    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, level.tex)
    gl.uniform1i(u('uSrc'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    gl.uniform1i(u('uLut'), 1)
    gl.activeTexture(gl.TEXTURE0)

    // 几何量都是「全分辨率源图像素」单位，采样更粗层级时需整体换算到该层级的像素单位
    gl.uniform2f(u('uSrcSize'), level.width, level.height)
    gl.uniform2f(
      u('uTransHalf'),
      (geo.transformedWidth / 2) * lodScaleX,
      (geo.transformedHeight / 2) * lodScaleY
    )
    gl.uniform2f(u('uRot'), Math.cos(angle), Math.sin(angle))
    gl.uniform2f(u('uAreaOrigin'), area.x * lodScaleX, area.y * lodScaleY)
    gl.uniform2f(u('uAreaHalf'), (area.w / 2) * lodScaleX, (area.h / 2) * lodScaleY)
    gl.uniform2f(u('uRegionOrigin'), regionX * lodScaleX, regionY * lodScaleY)
    gl.uniform2f(u('uRegionSize'), regionW * lodScaleX, regionH * lodScaleY)
    gl.uniform2f(u('uFlipSign'), params.transform.flipH ? -1 : 1, params.transform.flipV ? -1 : 1)

    // 除尘笔触：写入线段纹理（容量 512 段），各段独立
    const repairTex = this.ensureRepairTexture()
    const maxSeg = Math.floor(this.repairTexW / 2)
    const repairData = new Float32Array(this.repairTexW * 4)
    let repairSegs = 0
    const srcW = this.srcW
    const srcH = this.srcH
    if (params.repairs && params.repairs.length > 0) {
      const longSrc = Math.max(srcW, srcH)
      for (const st of params.repairs) {
        if (repairSegs >= maxSeg) break
        if (!st.points?.length || st.r <= 0) continue
        const rNorm = Math.max(0.0015, (st.r * longSrc) / Math.max(regionW, 1))
        const strength = st.strength ?? 1
        const mapped: { x: number; y: number }[] = []
        for (const p of st.points) {
          const [ru, rv] = sourceToRegion(p.x, p.y, srcW, srcH, params.transform, applyCrop)
          if (ru < -0.2 || rv < -0.2 || ru > 1.2 || rv > 1.2) continue
          mapped.push({ x: ru, y: rv })
        }
        if (mapped.length === 0) continue
        // 预览抽稀：每段最多约 12 点 → 11 段，保证后续笔触都能进
        const step = Math.max(1, Math.ceil(mapped.length / 12))
        const pts: typeof mapped = []
        for (let i = 0; i < mapped.length; i += step) pts.push(mapped[i])
        if (pts[pts.length - 1] !== mapped[mapped.length - 1]) pts.push(mapped[mapped.length - 1])

        const pushSeg = (ax: number, ay: number, bx: number, by: number): void => {
          if (repairSegs >= maxSeg) return
          const t0 = repairSegs * 2
          const t1 = t0 + 1
          repairData[t0 * 4] = ax
          repairData[t0 * 4 + 1] = ay
          repairData[t0 * 4 + 2] = bx
          repairData[t0 * 4 + 3] = by
          repairData[t1 * 4] = rNorm
          repairData[t1 * 4 + 1] = strength
          repairSegs++
        }

        if (pts.length === 1) {
          pushSeg(pts[0].x, pts[0].y, pts[0].x, pts[0].y)
        } else {
          for (let i = 0; i < pts.length - 1; i++) {
            if (repairSegs >= maxSeg) break
            pushSeg(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y)
          }
        }
      }
    }
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, repairTex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.repairTexW, 1, gl.RGBA, gl.FLOAT, repairData)
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1i(u('uRepairTex'), 2)
    gl.uniform2f(u('uRepairTexSize'), this.repairTexW, 1)
    gl.uniform1i(u('uRepairSegCount'), repairSegs)

    const satAmount = params.basic.saturation / 100
    const vibAmount = params.basic.vibrance / 100
    gl.uniform1f(u('uSatAmount'), satAmount)
    gl.uniform1f(u('uVibAmount'), vibAmount)
    gl.uniform1i(u('uSatActive'), satAmount !== 0 || vibAmount !== 0 ? 1 : 0)

    gl.uniform1i(u('uHslActive'), hsl.active ? 1 : 0)
    gl.uniform1fv(u('uHueShift'), hsl.hue)
    gl.uniform1fv(u('uSatAdj'), hsl.sat)
    gl.uniform1fv(u('uLumAdj'), hsl.lum)

    gl.uniform1i(u('uGradeActive'), grade.active ? 1 : 0)
    gl.uniform3fv(u('uGradeS'), grade.s)
    gl.uniform3fv(u('uGradeM'), grade.m)
    gl.uniform3fv(u('uGradeH'), grade.h)
    gl.uniform1f(u('uGradePivot'), grade.pivot)
    gl.uniform1f(u('uGradeGamma'), grade.gamma)

    // 第一遍：色调链。启用降噪时先画到离屏纹理，否则直接画到画布
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneTarget)
    gl.viewport(0, 0, ow, oh)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // 第二遍：降噪（亮度引导的色度/亮度滤波）
    let finalProgram = this.program
    if (denoise) {
      finalProgram = this.denoiseProgram
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.sceneTex)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.useProgram(this.denoiseProgram)
      const du = (n: string): WebGLUniformLocation | null => this.denoiseUniforms.get(n) ?? null
      const amounts = denoiseAmounts(params.denoise)
      gl.uniform1i(du('uScene'), 0)
      gl.uniform2f(du('uSceneSize'), ow, oh)
      gl.uniform1f(du('uColorAmount'), amounts.color)
      gl.uniform1f(du('uLumaAmount'), amounts.luminance)
      gl.uniform1f(du('uChromaSigma'), DENOISE_KERNEL.chromaSigma)
      gl.uniform1f(du('uLumaSigma'), DENOISE_KERNEL.lumaSigma)
      gl.uniform1f(du('uWMin'), DENOISE_KERNEL.wMin)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, ow, oh)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    const hist = histogram ? this.computeHistogram(finalProgram) : null

    gl.bindVertexArray(null)
    this.onFrame?.({ width: ow, height: oh, histogram: hist, elapsed: performance.now() - started })
  }

  dispose(): void {
    const gl = this.gl
    this.releasePyramid()
    gl.deleteTexture(this.srcTex)
    gl.deleteTexture(this.lutTex)
    if (this.repairTex) gl.deleteTexture(this.repairTex)
    this.repairTex = null
    if (this.sceneTex) gl.deleteTexture(this.sceneTex)
    if (this.sceneFbo) gl.deleteFramebuffer(this.sceneFbo)
    if (this.histTex) gl.deleteTexture(this.histTex)
    if (this.histFbo) gl.deleteFramebuffer(this.histFbo)
    gl.deleteVertexArray(this.vao)
    gl.deleteProgram(this.program)
    gl.deleteProgram(this.denoiseProgram)
    gl.deleteProgram(this.downsampleProgram)
    this.sceneTex = null
    this.sceneFbo = null
    this.histTex = null
    this.histFbo = null
    this.lost = true
  }

  /**
   * 直方图：用同一套 uniform 在小尺寸离屏缓冲上再画一次，
   * 只回读 256×256 像素统计分布，避免整帧回读造成的卡顿。
   *
   * 注意：这里的纹理操作必须切到独立的纹理单元，否则会覆盖 LUT 纹理的绑定与存储。
   */
  private computeHistogram(program: WebGLProgram): Histogram | null {
    const gl = this.gl
    if (!this.histFbo) {
      gl.activeTexture(gl.TEXTURE3)
      const tex = gl.createTexture()
      const fbo = gl.createFramebuffer()
      if (!tex || !fbo) {
        gl.activeTexture(gl.TEXTURE0)
        return null
      }
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, HIST_SIZE, HIST_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.bindTexture(gl.TEXTURE_2D, null)
      gl.activeTexture(gl.TEXTURE0)
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteTexture(tex)
        gl.deleteFramebuffer(fbo)
        return null
      }
      this.histTex = tex
      this.histFbo = fbo
      this.histPixels = new Uint8Array(HIST_SIZE * HIST_SIZE * 4)
    }

    gl.useProgram(program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFbo)
    gl.viewport(0, 0, HIST_SIZE, HIST_SIZE)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.readPixels(0, 0, HIST_SIZE, HIST_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, this.histPixels as Uint8Array)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    const px = this.histPixels as Uint8Array
    const hist: Histogram = {
      r: new Array<number>(256).fill(0),
      g: new Array<number>(256).fill(0),
      b: new Array<number>(256).fill(0),
      l: new Array<number>(256).fill(0)
    }
    const total = HIST_SIZE * HIST_SIZE
    for (let i = 0; i < total; i++) {
      const r = px[i * 4]
      const g = px[i * 4 + 1]
      const b = px[i * 4 + 2]
      hist.r[r]++
      hist.g[g]++
      hist.b[b]++
      hist.l[(0.2126 * r + 0.7152 * g + 0.0722 * b) | 0]++
    }
    return hist
  }

  /**
   * 创建/复用降噪输入纹理（RGBA8 + mipmap 链，供降噪 Pass 取 level 2 的 4×4 平均）。
   * 必须在绑定源纹理之前调用，避免覆盖纹理单元 0 的绑定。
   */
  private ensureSceneTarget(width: number, height: number): WebGLFramebuffer {
    const gl = this.gl
    if (this.sceneFbo && this.sceneW === width && this.sceneH === height) return this.sceneFbo
    if (this.sceneTex) gl.deleteTexture(this.sceneTex)
    if (this.sceneFbo) gl.deleteFramebuffer(this.sceneFbo)
    const tex = gl.createTexture()
    const fbo = gl.createFramebuffer()
    if (!tex || !fbo) throw new Error('创建降噪离屏缓冲失败')
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(tex)
      gl.deleteFramebuffer(fbo)
      throw new Error(`降噪离屏缓冲不完整：0x${status.toString(16)}`)
    }
    this.sceneTex = tex
    this.sceneFbo = fbo
    this.sceneW = width
    this.sceneH = height
    return fbo
  }

  /** 上传线性 RGB16 源数据（UNPACK_ALIGNMENT=2，避免奇数宽度时的行对齐问题） */
  private uploadSource(data: Uint16Array, width: number, height: number): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16UI, width, height, 0, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, data)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  /** 除尘线段纹理：容量 512 段（1024 texel） */
  private ensureRepairTexture(): WebGLTexture {
    const gl = this.gl
    const maxSeg = 512
    const w = maxSeg * 2
    if (this.repairTex && this.repairTexW === w) return this.repairTex
    if (this.repairTex) gl.deleteTexture(this.repairTex)
    const tex = gl.createTexture()
    if (!tex) throw new Error('无法创建除尘纹理')
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, 1, 0, gl.RGBA, gl.FLOAT, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.activeTexture(gl.TEXTURE0)
    this.repairTex = tex
    this.repairTexW = w
    return tex
  }

  private cacheUniforms(): void {
    const names = [
      'uSrc',
      'uLut',
      'uSrcSize',
      'uTransHalf',
      'uRot',
      'uAreaOrigin',
      'uAreaHalf',
      'uRegionOrigin',
      'uRegionSize',
      'uFlipSign',
      'uSatAmount',
      'uVibAmount',
      'uSatActive',
      'uHslActive',
      'uHueShift',
      'uSatAdj',
      'uLumAdj',
      'uGradeActive',
      'uGradeS',
      'uGradeM',
      'uGradeH',
      'uGradePivot',
      'uGradeGamma',
      'uRepairSegCount',
      'uRepairTex',
      'uRepairTexSize'
    ]
    this.uniforms.clear()
    for (const n of names) this.uniforms.set(n, this.gl.getUniformLocation(this.program, n))

    const denoiseNames = [
      'uScene',
      'uSceneSize',
      'uColorAmount',
      'uLumaAmount',
      'uChromaSigma',
      'uLumaSigma',
      'uWMin'
    ]
    this.denoiseUniforms.clear()
    for (const n of denoiseNames) {
      this.denoiseUniforms.set(n, this.gl.getUniformLocation(this.denoiseProgram, n))
    }

    this.downsampleUniforms.clear()
    for (const n of ['uSrc', 'uSrcSize', 'uDstSize']) {
      this.downsampleUniforms.set(n, this.gl.getUniformLocation(this.downsampleProgram, n))
    }
  }

  private createSrcTexture(): WebGLTexture {
    const gl = this.gl
    const tex = gl.createTexture()
    if (!tex) throw new Error('创建纹理失败')
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)
    return tex
  }

  private createLutTexture(): WebGLTexture {
    const gl = this.gl
    const tex = gl.createTexture()
    if (!tex) throw new Error('创建纹理失败')
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, LUT_SIZE + 1, 3, 0, gl.RED, gl.FLOAT, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)
    return tex
  }

  private buildProgram(fragmentSource: string): WebGLProgram {
    const gl = this.gl
    const vs = this.compile(gl.VERTEX_SHADER, QUAD_VERTEX_SHADER)
    const fs = this.compile(gl.FRAGMENT_SHADER, fragmentSource)
    const program = gl.createProgram()
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program)
      gl.deleteProgram(program)
      throw new Error(`着色器链接失败：${log ?? ''}`)
    }
    return program
  }

  private compile(type: number, source: string): WebGLShader {
    const gl = this.gl
    const shader = gl.createShader(type)
    if (!shader) throw new Error('创建着色器失败')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader)
      gl.deleteShader(shader)
      throw new Error(`着色器编译失败：${log ?? ''}`)
    }
    return shader
  }

  private buildQuad(): WebGLVertexArrayObject {
    const gl = this.gl
    const vao = gl.createVertexArray()
    if (!vao) throw new Error('创建 VAO 失败')
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(this.program, 'aPos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    return vao
  }
}
