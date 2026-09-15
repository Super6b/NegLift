/**
 * NegLift 共享类型定义
 * 主进程、预加载脚本与渲染进程共用同一套参数模型，保证「非破坏性编辑」的
 * 参数序列化、撤销/重做、预设存取与导出渲染完全一致。
 */

export type Vec3 = [number, number, number]

/** 归一化裁切矩形，坐标基于「几何变换后」的图像，取值 0..1 */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

/** 曲线控制点，x/y 均为 0..1 */
export interface CurvePoint {
  x: number
  y: number
}

export type CurveChannel = 'rgb' | 'r' | 'g' | 'b'

export type Curves = Record<CurveChannel, CurvePoint[]>

/**
 * 负片校正模式
 * - `base`：画面中存在未曝光的片基（色罩）时，按片基透射率做密度反相
 * - `align`：画面中**不含片基**时，先做三通道黑/白场对齐，再按 1-t 反色
 */
export type NegativeMode = 'base' | 'align'

/**
 * 负片去色罩参数
 *
 * base 模式（有片基）算法基于胶片密度模型：
 *   t = clamp(线性值 / 片基, eps, 1)      —— 归一化透射率，未曝光处 t = 1
 *   D = -log10(t)                          —— 相对片基的密度
 *   L = t^(-k) - 1                         —— 反相回线性光，k = 1/strength
 *   L = L / whitePoint                     —— 归一化到 0..1
 *
 * align 模式（无片基）算法为通道对齐 + 密度反相：
 *   n = (线性值 - alignBlack) / (alignWhite - alignBlack)   —— 逐通道对齐，消除色罩偏色
 *   t = tRef + (1 - tRef) * n                              —— 归一化透射率
 *   L = t^(-k) - 1,  L = L / whitePoint                     —— 与 base 模式相同的反相
 */
export interface NegativeParams {
  /** 是否启用负片反相（关闭时按正片处理） */
  enabled: boolean
  /** 校正模式：有片基用 base，无片基用 align */
  mode: NegativeMode
  /** 片基（色罩）三通道线性透射率，即未曝光胶片区域的值（base 模式） */
  base: Vec3
  /** 反相强度，k = 1 / strength，越大反差越强（base 模式） */
  strength: number
  /** 每通道密度平衡，用于校正胶片通道 Gamma 差异（base 模式） */
  balance: Vec3
  /** 参考最小透射率（画面中最亮处对应的片基比例），由自动检测得到（base 模式） */
  tRef: number
  /** 高光柔性滚降强度（base 模式） */
  highlightRolloff: number
  /** 通道对齐黑场（每通道的最低线性值，align 模式） */
  alignBlack: Vec3
  /** 通道对齐白场（每通道的最高线性值，align 模式） */
  alignWhite: Vec3
  /**
   * 对齐后两端保留的色彩空间（0..0.25）。
   * 反相输出映射到 [headroom, 1-headroom]，暗部/亮部留出余量便于后期曲线与分级。
   */
  alignHeadroom: number
}

/** 基础调色参数，滑块区间统一为 -100..100（exposure 为 EV） */
export interface BasicParams {
  /** 色温：负值偏冷，正值偏暖 */
  temperature: number
  /** 色调：负值偏绿，正值偏洋红 */
  tint: number
  /** 曝光，单位 EV */
  exposure: number
  /** 对比度 */
  contrast: number
  /** 高光 */
  highlights: number
  /** 阴影 */
  shadows: number
  /** 白色阶 */
  whites: number
  /** 黑色阶 */
  blacks: number
  /** 饱和度 */
  saturation: number
  /** 自然饱和度 */
  vibrance: number
}

/** HSL 色彩分离的 8 个色相分区 */
export type HslBandName = 'red' | 'orange' | 'yellow' | 'green' | 'aqua' | 'blue' | 'purple' | 'magenta'

/** 单个色相分区的调整量，均为 -100..100 */
export interface HslBand {
  hue: number
  saturation: number
  luminance: number
}

export type HslBands = Record<HslBandName, HslBand>

/**
 * 色彩分级（含色彩平衡）：分别对阴影 / 中间调 / 高光施加 RGB 偏移。
 * 每个分量取值 -100..100，配合混合与平衡控制过渡范围。
 */
export interface ColorGradingParams {
  shadows: Vec3
  midtones: Vec3
  highlights: Vec3
  /** 三个影调区域之间的混合程度 0..100 */
  blending: number
  /** 平衡：负值偏向阴影，正值偏向高光 -100..100 */
  balance: number
}

/**
 * 片夹边界扫描方向
 * - `inward`：从图像边缘向中心扫描，遇到画面内容即停（默认，适合片夹在外圈）
 * - `outward`：从中心/画面内容向边缘扫描，内容终止处即为片夹内边界
 */
export type HolderScanDirection = 'inward' | 'outward'

/** 几何变换参数 */
export interface TransformParams {
  /** 90° 快捷旋转次数，0..3 */
  rotate90: number
  /** 角度微调，-45..45 度 */
  angle: number
  /** 水平翻转 */
  flipH: boolean
  /** 垂直翻转 */
  flipV: boolean
  /** 裁切框，null 表示不裁切 */
  crop: CropRect | null
  /** 裁切锁定比例（宽/高），null 为自由裁切 */
  aspect: number | null
  /**
   * 有效图像区域（归一化原图坐标），用于排除翻拍片夹 / 边框等非画面内容。
   *
   * 该区域在旋转与裁切**之前**生效：先按有效区域截取画面，再做旋转与裁切。
   * 去色罩的片基 / 通道对齐检测同样仅在该区域内进行，避免片夹干扰参考值。
   * null 表示整幅图像都是有效画面。
   */
  validArea: CropRect | null
  /**
   * 特殊排除区域（归一化原图坐标），例如齿孔、漏光边、反光斑。
   *
   * 这些像素属于画面、且大多接近纯黑，若参与统计会把片基 / 通道对齐的
   * 参考值整体拉低，导致去色罩偏色。标记后只从**统计**中剔除，不影响渲染，
   * 画面本身保持完整。
   *
   * 与 validArea 一样基于原图坐标，因此不受裁切与旋转影响；
   * 与 crop / validArea 求交后，剩余区域才是去色罩的统计范围。
   */
  excludeAreas: CropRect[]
  /** 自动识别片夹时的扫描方向（从外向内 / 从中心向边缘） */
  holderScan: HolderScanDirection
}

/**
 * 降噪参数（快速路径）
 *
 * 色彩噪点与亮度噪点分开控制。彩色噪点在去马赛克后表现为低频的色斑，
 * 因此采用「亮度引导的边缘保持滤波」只作用在色度通道、并在 1/4 分辨率上处理，
 * 可以大幅去噪同时完整保留亮度细节；亮度降噪在全分辨率上做轻度处理。
 */
export interface DenoiseParams {
  enabled: boolean
  /** 色彩噪点降噪强度等级 0..10 */
  color: number
  /** 亮度噪点降噪强度等级 0..10 */
  luminance: number
}

/**
 * 除尘笔触上的一个点（原图归一化坐标）。
 */
export interface RepairPoint {
  x: number
  y: number
}

/**
 * 一段除尘笔触：整段路径作为一个孔区域做一次修补（而非逐点圆形）。
 * 坐标为**原图归一化** 0..1，不随裁切/旋转漂移。
 */
export interface RepairStroke {
  /** 路径点，至少 1 个；点击 = 单点笔触 */
  points: RepairPoint[]
  /** 笔刷半径（原图归一化长边比例） */
  r: number
  /** 修复强度 0..1，默认 1 */
  strength?: number
}

/** 一次编辑的全部参数 */
export interface EditParams {
  version: number
  negative: NegativeParams
  basic: BasicParams
  curves: Curves
  hsl: HslBands
  grading: ColorGradingParams
  denoise: DenoiseParams
  transform: TransformParams
  /** 手动/自动除尘笔触列表 */
  repairs: RepairStroke[]
}

/** 直方图数据，256 级，四通道 */
export interface Histogram {
  r: number[]
  g: number[]
  b: number[]
  l: number[]
}

/** 从解码结果中提取的元信息 */
export interface ImageMeta {
  fileName: string
  filePath: string
  fileSize: number
  /** 原始像素尺寸（几何变换前） */
  width: number
  height: number
  /** 是否为 RAW 原始文件 */
  isRaw: boolean
  /** 解码是否降级（例如仅使用内嵌预览图） */
  degraded: boolean
  /** 降级原因说明 */
  degradedReason?: string
  camera?: string
  lens?: string
  iso?: number
  aperture?: number
  shutterSpeed?: number
  focalLength?: number
  capturedAt?: number
  /** 传感器位深 */
  bitsPerSample: number
  /** 生效的机型优化配置 */
  profileId?: string
  profileName?: string
  profileSource?: 'user' | 'builtin' | 'none'
}

/** 打开文件后返回给渲染进程的载荷 */
export interface OpenedImage {
  meta: ImageMeta
  /** 线性 RGB 数据（Uint16 交错，0..65535），尺寸为 previewWidth/Height */
  preview: Uint16Array
  previewWidth: number
  previewHeight: number
  /** 主进程根据预览图自动检测出的参数，作为初始编辑参数 */
  detected: DetectResult
  /** 预览是否为原始分辨率（false 表示超出内存上限被降采样） */
  fullSize: boolean
}

/**
 * 胶片条中的轻量条目：不含完整预览像素，避免多选打开时 IPC 内存峰值崩溃。
 * 切换到该张时再通过 openImagePath 加载完整预览。
 */
export interface LibraryOpenEntry {
  meta: ImageMeta
  detected: DetectResult
  /** JPEG dataURL 缩略图（线性负片预览，仅作占位） */
  thumbUrl: string
  fullSize: boolean
  /** 小尺寸线性 RGB 预览，用于按参数重算处理后缩略图（可选） */
  linearThumb?: Uint16Array
  linearThumbWidth?: number
  linearThumbHeight?: number
}

/** 多选打开结果：完整预览只带回最后一张；其余仅元数据+缩略图 */
export interface OpenBatchResult {
  entries: LibraryOpenEntry[]
  /** 最后一张的完整载荷（作为当前编辑对象）；失败则为 null */
  active: OpenedImage | null
}

export interface ExportOptions {
  filePath: string
  format: 'jpeg' | 'png' | 'tiff' | 'bmp' | 'dng'
  /** JPEG 质量 1..100 */
  quality: number
  /** TIFF 位深 */
  tiffBitDepth: 8 | 16
  /** 长边像素上限，null 表示原始尺寸 */
  maxDimension: number | null
  /** 输出分辨率（DPI），写入文件元数据 */
  dpi: number
}

export interface ExportResult {
  ok: boolean
  filePath?: string
  fileSize?: number
  width?: number
  height?: number
  error?: string
}

/** 批量导出：每张用自己的参数 */
export interface ExportBatchItem {
  filePath: string
  params: EditParams
}

export interface ExportBatchResult {
  ok: boolean
  results: ExportResult[]
  error?: string
}

/** 批量处理请求：用当前风格模板 + 每张自动检测，批量导出 */
export interface BatchRequest {
  files: string[]
  outputDir: string
  /** 风格模板（基础/曲线/HSL/分级 + 几何等），来自当前打开图的参数 */
  template: EditParams
  export: Omit<ExportOptions, 'filePath'>
  /** 每张自动检测片夹有效区 */
  autoHolder: boolean
  /** 每张自动检测去色罩参数 */
  autoDetect: boolean
}

export interface BatchFileResult {
  fileName: string
  ok: boolean
  output?: string
  error?: string
}

export interface BatchProgress {
  /** 当前处理下标（0-based） */
  index: number
  total: number
  fileName: string
  stage: string
  /** 当前文件进度 0..1 */
  progress: number
  /** 总体进度 0..1 */
  overall: number
  status: 'running' | 'finished' | 'cancelled'
  results: BatchFileResult[]
}

export interface DetectResult {
  /** 自动判定的校正模式：画面中有无片基决定用 base 还是 align */
  mode: NegativeMode
  base: Vec3
  tRef: number
  suggestedStrength: number
  /** 通道对齐黑场（align 模式） */
  alignBlack: Vec3
  /** 通道对齐白场（align 模式） */
  alignWhite: Vec3
  /** 自动识别出的有效区域（排除片夹），null 表示未发现片夹 */
  validArea: CropRect | null
}

/** 打开图片过程中的阶段进度（0..1），用于界面进度条 */
export interface OpenProgress {
  /** 阶段标识：open / demosaic / extract / analyze / ready */
  stage: string
  /** 总体进度，0..1 */
  progress: number
  /** 当前阶段的中文描述 */
  label: string
}

/** 主进程 IPC 暴露给渲染进程的能力 */
export interface NegLiftApi {
  openImageDialog(): Promise<OpenBatchResult | null>
  openImagePath(filePath: string): Promise<OpenedImage | null>
  getPathForFile(file: File): string
  sampleBase(u: number, v: number): Promise<Vec3 | null>
  detectNegative(params: TransformParams): Promise<DetectResult | null>
  /** 自动识别翻拍片夹，返回应保留的有效区域；direction 控制扫描方向 */
  detectHolder(direction?: HolderScanDirection): Promise<CropRect | null>
  chooseExportPath(defaultName: string): Promise<string | null>
  exportImage(options: ExportOptions, params: EditParams): Promise<ExportResult>
  /** 按路径解码并导出（不依赖当前会话，用于胶片条批量） */
  exportImageFromPath(
    sourcePath: string,
    destPath: string,
    options: Omit<ExportOptions, 'filePath'>,
    params: EditParams
  ): Promise<ExportResult>
  closeImage(): Promise<void>
  /** 在系统文件管理器中定位文件（导出后分享/查看） */
  showInFolder(filePath: string): Promise<void>
  getPlatform(): string
  onMenuCommand(cb: (command: string) => void): () => void
  /** 沉浸模式时通知主进程隐藏/显示应用菜单栏 */
  setImmersiveChrome(on: boolean): void
  /** 同步系统标题栏配色与应用主题 */
  setTitleTheme(theme: 'dark' | 'light'): void
  /** 订阅打开图片的进度上报 */
  onOpenProgress(cb: (progress: OpenProgress) => void): () => void
  /** 批量：多选源文件 */
  batchChooseFiles(): Promise<string[] | null>
  /** 批量：选择输出目录 */
  batchChooseOutputDir(): Promise<string | null>
  /** 批量：开始处理 */
  batchRun(request: BatchRequest): Promise<BatchProgress | null>
  /** 批量：取消 */
  batchCancel(): Promise<void>
  /** 订阅批量进度 */
  onBatchProgress(cb: (progress: BatchProgress) => void): () => void
  /** 导入机型优化 JSON，返回保存路径与条数 */
  importCameraProfile(): Promise<{ ok: true; path: string; count: number } | null>
  /** 打开用户机型配置目录 */
  openCameraProfileDir(): Promise<void>
  /** 本地修补模型状态 */
  inpaintStatus(): Promise<InpaintModelStatus>
  /** 选择并加载 ONNX 修补模型 */
  inpaintPickModel(): Promise<InpaintModelStatus>
  /** 打开模型目录 */
  inpaintOpenFolder(): Promise<string[]>
  /**
   * 用当前会话 + 参数 + 模型渲染一张预览图（JPEG dataURL），
   * 供「模型除尘预览」开关在编辑时显示效果。
   */
  previewWithModel(params: EditParams, maxEdge?: number): Promise<ModelPreviewResult>
}

export interface InpaintModelStatus {
  available: boolean
  path: string | null
  name: string | null
  source?: 'builtin' | 'user' | null
  error?: string
}

export interface ModelPreviewResult {
  ok: boolean
  dataUrl?: string
  width?: number
  height?: number
  error?: string
}
