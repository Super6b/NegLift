import { create } from 'zustand'
import type {
  CropRect,
  DetectResult,
  EditParams,
  Histogram,
  HolderScanDirection,
  ImageMeta,
  LibraryOpenEntry,
  OpenBatchResult,
  OpenedImage,
  OpenProgress,
  RepairStroke,
  TransformParams,
  Vec3
} from '@shared/types'
import { cloneParams, createDefaultParams } from '@shared/defaults'
import { renderLinear } from '@shared/pipeline'
import {
  applyCustomPresetParams,
  applyPreset,
  applyWorkflowParams,
  loadCustomPresets,
  saveCustomPresets,
  type CustomPreset,
  type FilmPreset
} from '../presets/filmPresets'

export type ToolId = 'adjust' | 'crop' | 'exclude' | 'holder' | 'heal'
export type PanelTab =
  | 'holder'
  | 'negative'
  | 'repair'
  | 'basic'
  | 'curves'
  | 'hsl'
  | 'grading'
  | 'denoise'
  | 'presets'
  | 'transform'
export type Theme = 'dark' | 'light'

export interface ToastMessage {
  id: number
  text: string
  kind: 'info' | 'error'
}

/** 胶片条中的一页：完整预览 + 各自参数与撤销栈 */
export interface LibraryItem {
  id: string
  restorationPath?: string | null
  /** 完整载荷；非当前张在多选导入时可为 null，切换时再从磁盘加载 */
  image: OpenedImage | null
  meta: ImageMeta
  detected: DetectResult
  params: EditParams
  past: EditParams[]
  future: EditParams[]
  selected: boolean
  /** 处理后缩略图 dataURL（优先）；无则退回线性占位 */
  thumbUrl: string
  /** 小尺寸线性预览，用于按参数重算处理后缩略图 */
  linearThumb?: Uint16Array
  linearThumbWidth?: number
  linearThumbHeight?: number
}

const HISTORY_LIMIT = 60

let libSeq = 0
function nextLibId(): string {
  return `lib-${Date.now().toString(36)}-${++libSeq}`
}

/** 用线性小图 + 当前参数渲染处理后缩略图 */
function renderProcessedThumb(
  linear: Uint16Array,
  lw: number,
  lh: number,
  params: EditParams
): string {
  try {
    const result = renderLinear(linear, lw, lh, params, {
      applyCrop: false,
      scale: 1,
      histogram: false
    })
    const canvas = document.createElement('canvas')
    canvas.width = result.width
    canvas.height = result.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    const imgData = ctx.createImageData(result.width, result.height)
    const out = imgData.data
    const src = result.data
    for (let i = 0, s = 0, d = 0; i < result.width * result.height; i++, s += 3, d += 4) {
      out[d] = src[s] >> 8
      out[d + 1] = src[s + 1] >> 8
      out[d + 2] = src[s + 2] >> 8
      out[d + 3] = 255
    }
    ctx.putImageData(imgData, 0, 0)
    return canvas.toDataURL('image/jpeg', 0.78)
  } catch {
    return ''
  }
}

/** 从完整预览生成小线性副本（无则先降采样） */
function extractLinearThumb(image: OpenedImage): {
  data: Uint16Array
  w: number
  h: number
} {
  const long = 160
  const s = long / Math.max(image.previewWidth, image.previewHeight, 1)
  if (s >= 0.99) {
    return { data: image.preview, w: image.previewWidth, h: image.previewHeight }
  }
  const w = Math.max(1, Math.round(image.previewWidth * s))
  const h = Math.max(1, Math.round(image.previewHeight * s))
  const out = new Uint16Array(w * h * 3)
  const stepX = image.previewWidth / w
  const stepY = image.previewHeight / h
  for (let y = 0; y < h; y++) {
    const sy = Math.min(image.previewHeight - 1, Math.floor((y + 0.5) * stepY))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(image.previewWidth - 1, Math.floor((x + 0.5) * stepX))
      const si = (sy * image.previewWidth + sx) * 3
      const di = (y * w + x) * 3
      out[di] = image.preview[si]
      out[di + 1] = image.preview[si + 1]
      out[di + 2] = image.preview[si + 2]
    }
  }
  return { data: out, w, h }
}

/** 每帧渲染完成后回写的统计信息，供直方图与状态栏订阅 */
export interface FrameInfo {
  width: number
  height: number
  histogram: Histogram | null
  /** 渲染耗时（毫秒） */
  elapsed: number
}

interface EditorState {
  image: OpenedImage | null
  params: EditParams
  past: EditParams[]
  future: EditParams[]

  /** 胶片条：已导入的多张图 */
  library: LibraryItem[]
  /** 当前编辑的 library id */
  activeId: string | null

  theme: Theme
  tool: ToolId
  tab: PanelTab
  zoom: number
  immersive: boolean
  compare: boolean
  restorationPath: string | null
  eyedropper: boolean
  exportOpen: boolean
  exporting: boolean
  batchOpen: boolean
  interacting: boolean
  interactBase: EditParams | null
  toast: ToastMessage | null
  openProgress: OpenProgress | null
  activePresetId: string | null
  customPresets: CustomPreset[]
  frameInfo: FrameInfo | null
  /** 是否用本地 ONNX 模型预览除尘结果 */
  modelPreviewEnabled: boolean
  /** 模型预览 JPEG dataURL（null 表示未启用/未生成） */
  modelPreviewUrl: string | null
  /** 模型预览生成中 */
  modelPreviewBusy: boolean

  openDialog: () => Promise<void>
  openPath: (filePath: string) => Promise<void>
  openFile: (file: File) => Promise<void>
  closeImage: () => Promise<void>
  /** 切换胶片条当前张 */
  setActiveLibraryId: (id: string) => Promise<void>
  toggleLibrarySelected: (id: string) => void
  setAllLibrarySelected: (selected: boolean) => void
  /** 从胶片条移除（不关闭应用会话时尽量激活下一张） */
  removeFromLibrary: (id: string) => void
  /** 把当前编辑态写回 library（切换/导出前调用） */
  syncActiveToLibrary: () => void

  update: (mutator: (draft: EditParams) => void, commit?: boolean) => void
  beginInteract: () => void
  endInteract: () => void
  undo: () => void
  redo: () => void
  resetAll: () => void
  setCrop: (crop: CropRect | null, commit?: boolean) => void

  detect: (silent?: boolean) => Promise<void>
  /** 自动识别翻拍片夹并据此设定有效区域，随后在该区域内重新检测 */
  detectHolder: (direction?: HolderScanDirection) => Promise<void>
  /** 直接设置有效区域（归一化原图坐标），null 表示整幅图像 */
  setValidArea: (rect: CropRect | null, commit?: boolean) => void
  /** 按四边内缩比例设置有效区域（0..0.5），任一边为 0 表示该边不裁 */
  setValidInsets: (insets: { top: number; right: number; bottom: number; left: number }, commit?: boolean) => void
  /** 追加一个特殊排除区域（归一化原图坐标） */
  addExcludeArea: (rect: CropRect) => void
  /** 删除第 index 个排除区域 */
  removeExcludeArea: (index: number) => void
  /** 清空所有排除区域 */
  clearExcludeAreas: () => void
  /** 手动除尘：追加整段笔触（commit=false 时配合 endInteract 一次提交） */
  addRepairStroke: (stroke: RepairStroke, commit?: boolean) => void
  /** 删除第 index 段笔触 */
  removeRepairSpot: (index: number) => void
  /** 清空修复笔触 */
  clearRepairSpots: () => void
  /** 按笔刷半径设置有效区域无关；画笔半径 */
  repairRadius: number
  setRepairRadius: (r: number) => void
  /** 开关 ONNX 除尘预览；开启时立即重算 */
  setModelPreviewEnabled: (on: boolean) => Promise<void>
  /** 用当前参数重算模型预览图 */
  refreshModelPreview: () => Promise<void>
  pickBase: (u: number, v: number) => Promise<void>

  applyFilmPreset: (preset: FilmPreset) => void
  applyCustomPreset: (id: string) => void
  saveCustomPreset: (name: string) => void
  deleteCustomPreset: (id: string) => void
  /** 把工作流预设应用到胶片条勾选项（或全部） */
  applyWorkflowToLibrary: (presetId: string, scope: 'selected' | 'all') => void
  /** 按当前 params 刷新指定 library 项的处理后缩略图 */
  refreshLibraryThumb: (id: string) => void

  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setTool: (tool: ToolId) => void
  setTab: (tab: PanelTab) => void
  setZoom: (zoom: number) => void
  toggleImmersive: () => void
  setCompare: (on: boolean) => void
  setRestorationPath: (path: string | null) => void
  setEyedropper: (on: boolean) => void
  setExportOpen: (open: boolean) => void
  setExporting: (on: boolean) => void
  setBatchOpen: (open: boolean) => void
  notify: (text: string, kind?: 'info' | 'error') => void
  clearToast: () => void
  setOpenProgress: (progress: OpenProgress | null) => void
  setFrameInfo: (info: FrameInfo) => void
}

let toastSeq = 0
let toastTimer: ReturnType<typeof setTimeout> | null = null

function initialTheme(): Theme {
  const saved = localStorage.getItem('neglift.theme')
  return saved === 'light' ? 'light' : 'dark'
}

function collapsed(params: EditParams): string {
  return JSON.stringify(params)
}

/**
 * 决定去色罩统计范围的几何量。
 *
 * 裁切与有效区域共同定义了「哪些像素算数」：它们一变，片基 / 通道对齐就必须
 * 基于新范围重算，否则去色罩仍按变化前的画面统计，与所见画面不一致。
 */
function regionKey(t: TransformParams): string {
  return `${JSON.stringify(t.crop)}|${JSON.stringify(t.validArea)}`
}

/**
 * 把自动检测结果写入参数。
 * 片基与通道对齐两组数据同时写入，用户切换校正模式时无需重新检测。
 */
function applyDetected(params: EditParams, detected: DetectResult, positive = false): void {
  params.negative.mode = detected.mode
  params.negative.base = [...detected.base] as Vec3
  params.negative.tRef = detected.tRef
  params.negative.strength = detected.suggestedStrength
  params.negative.alignBlack = [...detected.alignBlack] as Vec3
  params.negative.alignWhite = [...detected.alignWhite] as Vec3
  params.negative.enabled = !positive
}

export const useEditor = create<EditorState>((set, get) => {
  /** 记录一次可撤销的操作 */
  const commitFrom = (before: EditParams): void => {
    set((state) => ({
      past: [...state.past, before].slice(-HISTORY_LIMIT),
      future: []
    }))
  }

  const loadImage = async (
    loader: () => Promise<OpenBatchResult | OpenedImage | null>,
    label: string
  ): Promise<void> => {
    set({ openProgress: { stage: 'open', progress: 0.01, label: '准备打开…' } })
    try {
      const loaded = await loader()
      if (!loaded) return

      const { library } = get()
      let added: LibraryItem[] = []
      let activeId: string | null = null
      let activeImage: OpenedImage | null = null

      if ('entries' in loaded && 'active' in loaded) {
        // OpenBatchResult：多选导入
        const batch = loaded as OpenBatchResult
        added = batch.entries.map((entry: LibraryOpenEntry) => {
          const params = createDefaultParams()
          applyDetected(params, entry.detected, entry.meta.isFidelityPositive)
          params.transform.validArea = !entry.meta.isFidelityPositive && entry.detected.validArea ? { ...entry.detected.validArea } : null
          const isActive = batch.active?.meta.filePath === entry.meta.filePath
          const linearThumb = entry.linearThumb
          const lw = entry.linearThumbWidth ?? 0
          const lh = entry.linearThumbHeight ?? 0
          const thumbUrl =
            isActive && batch.active
              ? (() => {
                  const { data, w, h } = extractLinearThumb(batch.active)
                  return renderProcessedThumb(data, w, h, params)
                })()
              : linearThumb && lw && lh
                ? renderProcessedThumb(linearThumb, lw, lh, params)
                : entry.thumbUrl
          return {
            id: nextLibId(),
            image: isActive ? batch.active : null,
            meta: entry.meta,
            detected: entry.detected,
            params,
            past: [],
            future: [],
            selected: true,
            thumbUrl,
            linearThumb,
            linearThumbWidth: lw,
            linearThumbHeight: lh
          }
        })
        activeImage = batch.active
        activeId = added[added.length - 1]?.id ?? null
      } else {
        // 单张 OpenedImage
        const image = loaded as OpenedImage
        const params = createDefaultParams()
        applyDetected(params, image.detected, image.meta.isFidelityPositive)
        params.transform.validArea = !image.meta.isFidelityPositive && image.detected.validArea ? { ...image.detected.validArea } : null
        const { data, w, h } = extractLinearThumb(image)
        const item: LibraryItem = {
          id: nextLibId(),
          image,
          meta: image.meta,
          detected: image.detected,
          params,
          past: [],
          future: [],
          selected: true,
          thumbUrl: renderProcessedThumb(data, w, h, params),
          linearThumb: data,
          linearThumbWidth: w,
          linearThumbHeight: h
        }
        added = [item]
        activeImage = image
        activeId = item.id
      }

      const nextLibrary = [...library, ...added]
      const activeItem = added.find((i) => i.id === activeId) ?? added[added.length - 1]
      const activeParams = activeItem.params
      set({
        library: nextLibrary,
        activeId: activeItem.id,
        image: activeImage,
        params: activeParams,
        past: [],
        future: [],
        activePresetId: null,
        compare: false,
        restorationPath: null,
        zoom: 1,
        tab: 'holder',
        modelPreviewUrl: null
      })

      const firstMeta = added[0]?.meta
      if (added.length > 1) {
        get().notify(`已载入 ${added.length} 张图片（${label}），可在底部胶片条切换`)
      } else if (firstMeta?.degraded) {
        get().notify(firstMeta.degradedReason ?? '该文件已降级解码', 'error')
      } else if (activeImage && !activeImage.fullSize) {
        get().notify(
          `已载入 ${activeImage.meta.fileName}：图像过大，预览已降采样为 ${activeImage.previewWidth}×${activeImage.previewHeight}`
        )
      } else if (activeImage?.detected.mode === 'align') {
        get().notify(`已载入 ${activeImage.meta.fileName}：画面中未发现片基，已切换到「通道对齐」校正`)
      } else if (activeImage) {
        get().notify(`已载入 ${activeImage.meta.fileName}（${label}）`)
      }
    } catch (err) {
      get().notify(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      set({ openProgress: null })
    }
  }

  /** 把当前编辑态写回 library 对应项（切换/导出前调用） */
  const syncActiveToLibrary = (): void => {
    const { library, activeId, image, params, past, future } = get()
    if (!activeId || !image) return
    set({
      library: library.map((item) =>
        item.id === activeId
          ? {
              ...item,
              image,
              meta: image.meta,
              detected: image.detected,
              params: cloneParams(params),
              past: [...past],
              future: [...future]
            }
          : item
      )
    })
  }

  return {
    image: null,
    params: createDefaultParams(),
    past: [],
    future: [],
    library: [],
    activeId: null,

    theme: initialTheme(),
    tool: 'adjust',
    tab: 'holder',
    zoom: 1,
    immersive: false,
    compare: false,
    restorationPath: null,
    eyedropper: false,
    exportOpen: false,
    exporting: false,
    batchOpen: false,
    interacting: false,
    interactBase: null,
    toast: null,
    openProgress: null,
    activePresetId: null,
    customPresets: loadCustomPresets(),
    frameInfo: null,
    repairRadius: 0.005,
    modelPreviewEnabled: false,
    modelPreviewUrl: null,
    modelPreviewBusy: false,

    openDialog: async () => {
      await loadImage(() => window.negLift.openImageDialog(), 'RAW/图像')
    },

    openPath: async (filePath) => {
      await loadImage(() => window.negLift.openImagePath(filePath), '已从磁盘读取')
    },

    openFile: async (file) => {
      const filePath = window.negLift.getPathForFile(file)
      if (!filePath) {
        get().notify('无法读取拖入文件的路径，请使用「打开图片」按钮', 'error')
        return
      }
      await get().openPath(filePath)
    },

    closeImage: async () => {
      await window.negLift.closeImage()
      set({
        image: null,
        params: createDefaultParams(),
        past: [],
        future: [],
        activePresetId: null,
        library: [],
        activeId: null,
        restorationPath: null
      })
    },

    setActiveLibraryId: async (id) => {
      const { library, activeId } = get()
      if (id === activeId) return
      const next = library.find((item) => item.id === id)
      if (!next) return
      syncActiveToLibrary()

      set({ openProgress: { stage: 'open', progress: 0.2, label: `载入 ${next.meta.fileName}…` } })
      try {
        let image = next.image
        if (!image) {
          const loaded = await window.negLift.openImagePath(next.meta.filePath)
          if (!loaded) {
            get().notify(`无法重新载入 ${next.meta.fileName}`, 'error')
            return
          }
          image = loaded
        }
        const fresh = get().library.find((item) => item.id === id)
        if (!fresh) return
        set({
          library: get().library.map((item) =>
            item.id === id ? { ...item, image: image as OpenedImage } : item
          ),
          activeId: id,
          image: image as OpenedImage,
          params: cloneParams(fresh.params),
          past: [...fresh.past],
          future: [...fresh.future],
          compare: false,
          restorationPath: fresh.restorationPath ?? null,
          activePresetId: null,
          zoom: 1
        })
      } catch (err) {
        get().notify(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        set({ openProgress: null })
      }
    },

    toggleLibrarySelected: (id) => {
      set({
        library: get().library.map((item) => (item.id === id ? { ...item, selected: !item.selected } : item))
      })
    },

    setAllLibrarySelected: (selected) => {
      set({ library: get().library.map((item) => ({ ...item, selected })) })
    },

    removeFromLibrary: (id) => {
      syncActiveToLibrary()
      const { library } = get()
      const idx = library.findIndex((item) => item.id === id)
      if (idx < 0) return
      const nextLibrary = library.filter((item) => item.id !== id)
      if (nextLibrary.length === 0) {
        void window.negLift.closeImage()
        set({ library: [], activeId: null, image: null, params: createDefaultParams(), past: [], future: [], restorationPath: null })
        return
      }
      const newActive = nextLibrary[Math.min(idx, nextLibrary.length - 1)]
      set({
        library: nextLibrary,
        activeId: newActive.id,
        image: newActive.image,
        restorationPath: newActive.restorationPath ?? null,
        params: cloneParams(newActive.params),
        past: [...newActive.past],
        future: [...newActive.future]
      })
      // 新激活项若尚未加载完整预览，异步补载
      if (!newActive.image) {
        void get().setActiveLibraryId(newActive.id)
      }
    },

    syncActiveToLibrary,

    update: (mutator, commit = true) => {
      const { params } = get()
      const next = cloneParams(params)
      mutator(next)
      if (commit) commitFrom(params)
      const regionChanged = regionKey(params.transform) !== regionKey(next.transform)
      set({ params: next, activePresetId: null })
      // 裁切 / 有效区域变了：去色罩的统计范围随之改变，按最新范围静默重算
      if (commit && regionChanged) void get().detect(true)
      if (commit && get().activeId) get().refreshLibraryThumb(get().activeId as string)
    },

    beginInteract: () => set({ interacting: true, interactBase: cloneParams(get().params) }),

    endInteract: () => {
      const { interactBase, params } = get()
      if (interactBase && collapsed(interactBase) !== collapsed(params)) {
        commitFrom(interactBase)
        // 拖动裁切框 / 边缘裁除滑块时中间态不提交，这里补一次基于最终范围的检测
        if (regionKey(interactBase.transform) !== regionKey(params.transform)) void get().detect(true)
      }
      set({ interacting: false, interactBase: null })
      if (get().activeId) get().refreshLibraryThumb(get().activeId as string)
    },

    undo: () => {
      const { past, future, params } = get()
      if (past.length === 0) return
      const previous = past[past.length - 1]
      set({ params: previous, past: past.slice(0, -1), future: [params, ...future].slice(0, HISTORY_LIMIT) })
    },

    redo: () => {
      const { past, future, params } = get()
      if (future.length === 0) return
      const next = future[0]
      set({ params: next, past: [...past, params].slice(-HISTORY_LIMIT), future: future.slice(1) })
    },

    resetAll: () => {
      const { params, image } = get()
      const next = createDefaultParams()
      if (image) {
        applyDetected(next, image.detected, image.meta.isFidelityPositive)
        next.transform.validArea = !image.meta.isFidelityPositive && image.detected.validArea ? { ...image.detected.validArea } : null
      }
      commitFrom(params)
      set({ params: next, activePresetId: null })
    },

    setCrop: (crop, commit = true) => {
      get().update((draft) => {
        draft.transform.crop = crop
      }, commit)
    },

    /**
     * 按当前「裁切 ∩ 有效区域 − 排除区域」重新检测去色罩参数。
     * `silent` 用于裁切等操作的连带重算：不提示、不写撤销栈，避免打断用户。
     */
    detect: async (silent = false) => {
      if (get().image?.meta.isFidelityPositive) return
      const result = await window.negLift.detectNegative(get().params.transform)
      if (!result) {
        if (!silent) get().notify('自动检测失败：没有可用的图像数据', 'error')
        return
      }
      get().update((draft) => applyDetected(draft, result), !silent)
      if (!silent) {
        get().notify(
          result.mode === 'align'
            ? '已在有效区域内重新检测：画面中未发现片基，使用通道对齐校正'
            : '已在有效区域内重新检测片基'
        )
      }
    },

    detectHolder: async (direction) => {
      const scan = direction ?? get().params.transform.holderScan
      const rect = await window.negLift.detectHolder(scan)
      if (!rect) {
        get().notify('未识别到片夹边框，请改用「手动框选」或「边缘裁除」', 'error')
        return
      }
      // 更新有效区域会连带触发一次基于新范围的去色罩重算
      get().update((draft) => {
        draft.transform.validArea = { ...rect }
        draft.transform.holderScan = scan
      })
      const dirLabel = scan === 'outward' ? '中心→边缘' : '边缘→中心'
      get().notify(
        `已排除片夹（${dirLabel}）：保留画面 ${(rect.w * 100).toFixed(1)}% × ${(rect.h * 100).toFixed(1)}%`
      )
    },

    setValidArea: (rect, commit = true) => {
      get().update((draft) => {
        draft.transform.validArea = rect ? { ...rect } : null
      }, commit)
    },

    setValidInsets: (insets, commit = true) => {
      const { top, right, bottom, left } = insets
      const t = Math.max(0, Math.min(0.45, top))
      const r = Math.max(0, Math.min(0.45, right))
      const b = Math.max(0, Math.min(0.45, bottom))
      const l = Math.max(0, Math.min(0.45, left))
      const w = 1 - l - r
      const h = 1 - t - b
      get().update((draft) => {
        draft.transform.validArea =
          w > 0.05 && h > 0.05 ? { x: l, y: t, w, h } : null
      }, commit)
    },

    addExcludeArea: (rect) => {
      get().update((draft) => {
        draft.transform.excludeAreas.push({ ...rect })
      })
      void get().detect(true)
    },

    removeExcludeArea: (index) => {
      get().update((draft) => {
        draft.transform.excludeAreas.splice(index, 1)
      })
      void get().detect(true)
    },

    clearExcludeAreas: () => {
      if (get().params.transform.excludeAreas.length === 0) return
      get().update((draft) => {
        draft.transform.excludeAreas = []
      })
      void get().detect(true)
    },

    addRepairStroke: (stroke, commit = true) => {
      if (!stroke.points?.length) return
      get().update((draft) => {
        draft.repairs.push({
          points: stroke.points.map((p) => ({ ...p })),
          r: stroke.r,
          strength: stroke.strength ?? 1
        })
      }, commit)
    },

    removeRepairSpot: (index) => {
      get().update((draft) => {
        draft.repairs.splice(index, 1)
      })
    },

    clearRepairSpots: () => {
      if (get().params.repairs.length === 0) return
      get().update((draft) => {
        draft.repairs = []
      })
    },

    setRepairRadius: (r) => set({ repairRadius: Math.min(0.05, Math.max(0.0005, r)) }),

    setModelPreviewEnabled: async (on) => {
      set({ modelPreviewEnabled: on, modelPreviewUrl: on ? get().modelPreviewUrl : null })
      if (on) await get().refreshModelPreview()
    },

    refreshModelPreview: async () => {
      if (!get().modelPreviewEnabled || !get().image) return
      set({ modelPreviewBusy: true })
      try {
        const result = await window.negLift.previewWithModel(get().params, 1280)
        if (result.ok && result.dataUrl) {
          set({ modelPreviewUrl: result.dataUrl })
        } else if (result.error) {
          set({ modelPreviewUrl: null })
          get().notify(`模型预览失败：${result.error}`, 'error')
        }
      } catch (err) {
        set({ modelPreviewUrl: null })
        get().notify(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        set({ modelPreviewBusy: false })
      }
    },

    pickBase: async (u, v) => {
      const color = await window.negLift.sampleBase(u, v)
      if (!color) {
        get().notify('取样失败', 'error')
        return
      }
      get().update((draft) => {
        draft.negative.base = [...color] as Vec3
      })
      get().notify(
        `片基已取样：R ${color[0].toFixed(3)} / G ${color[1].toFixed(3)} / B ${color[2].toFixed(3)}`
      )
    },

    applyFilmPreset: (preset) => {
      const { params } = get()
      const next = applyPreset(params, preset)
      const before = params
      if (collapsed(before) === collapsed(next)) {
        set({ activePresetId: preset.id })
        return
      }
      commitFrom(before)
      set({ params: next, activePresetId: preset.id })
    },

    applyCustomPreset: (id) => {
      const preset = get().customPresets.find((p) => p.id === id)
      if (!preset) return
      const before = get().params
      // 只套用风格化字段；去色罩 / 降噪 / 几何保持当前状态
      const next = applyCustomPresetParams(before, preset.params)
      if (collapsed(before) === collapsed(next)) {
        set({ activePresetId: `custom:${id}` })
        return
      }
      commitFrom(before)
      set({ params: next, activePresetId: `custom:${id}` })
      get().notify(`已应用预设「${preset.name}」`)
      if (get().activeId) get().refreshLibraryThumb(get().activeId as string)
    },

    saveCustomPreset: (name) => {
      const trimmed = name.trim()
      if (!trimmed) {
        get().notify('请输入预设名称', 'error')
        return
      }
      const preset: CustomPreset = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: trimmed,
        createdAt: Date.now(),
        params: cloneParams(get().params)
      }
      const list = [...get().customPresets, preset]
      saveCustomPresets(list)
      set({ customPresets: list, activePresetId: `custom:${preset.id}` })
      get().notify(`预设「${trimmed}」已保存`)
    },

    deleteCustomPreset: (id) => {
      const list = get().customPresets.filter((p) => p.id !== id)
      saveCustomPresets(list)
      set({ customPresets: list })
    },

    refreshLibraryThumb: (id) => {
      const item = get().library.find((i) => i.id === id)
      if (!item) return
      const params = id === get().activeId ? get().params : item.params
      let thumb = item.thumbUrl
      if (item.linearThumb && item.linearThumbWidth && item.linearThumbHeight) {
        const t = renderProcessedThumb(
          item.linearThumb,
          item.linearThumbWidth,
          item.linearThumbHeight,
          params
        )
        if (t) thumb = t
      } else if (item.image) {
        const { data, w, h } = extractLinearThumb(item.image)
        const t = renderProcessedThumb(data, w, h, params)
        if (t) {
          thumb = t
          set({
            library: get().library.map((i) =>
              i.id === id ? { ...i, linearThumb: data, linearThumbWidth: w, linearThumbHeight: h } : i
            )
          })
        }
      }
      set({ library: get().library.map((i) => (i.id === id ? { ...i, thumbUrl: thumb } : i)) })
    },

    applyWorkflowToLibrary: (presetId, scope) => {
      const preset = get().customPresets.find((p) => p.id === presetId)
      if (!preset) {
        get().notify('未找到预设', 'error')
        return
      }
      const targets = get().library.filter((i) => (scope === 'all' ? true : i.selected))
      if (targets.length === 0) {
        get().notify(scope === 'selected' ? '未勾选任何照片' : '胶片条为空', 'error')
        return
      }
      syncActiveToLibrary()
      let count = 0
      const nextLibrary = get().library.map((item) => {
        const should =
          scope === 'all' ? true : item.selected
        if (!should) return item
        const nextParams = applyWorkflowParams(item.params, preset.params)
        count++
        return { ...item, params: nextParams }
      })
      set({ library: nextLibrary })
      // 刷新勾选项缩略图
      for (const item of nextLibrary) {
        if (scope === 'all' || item.selected) {
          get().refreshLibraryThumb(item.id)
        }
      }
      // 同步当前张到编辑区
      if (get().activeId) {
        const cur = get().library.find((i) => i.id === get().activeId)
        if (cur) {
          set({
            params: cloneParams(cur.params),
            past: [],
            future: [],
            activePresetId: `custom:${presetId}`
          })
        }
      }
      get().notify(`已对 ${count} 张应用工作流预设「${preset.name}」`)
    },

    setTheme: (theme) => {
      localStorage.setItem('neglift.theme', theme)
      set({ theme })
    },
    toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
    setTool: (tool) => set({ tool }),
    setTab: (tab) => set({ tab }),
    setZoom: (zoom) => set({ zoom: Math.min(8, Math.max(0.05, zoom)) }),
    toggleImmersive: () => set({ immersive: !get().immersive }),
    setCompare: (on) => set({ compare: on }),
    setRestorationPath: (path) => set((state) => ({
      restorationPath: path,
      library: state.library.map((item) => item.id === state.activeId ? { ...item, restorationPath: path } : item)
    })),
    setEyedropper: (on) => set({ eyedropper: on }),
    setExportOpen: (open) => set({ exportOpen: open }),
    setExporting: (on) => set({ exporting: on }),
    setBatchOpen: (open) => set({ batchOpen: open }),

    notify: (text, kind = 'info') => {
      const id = ++toastSeq
      set({ toast: { id, text, kind } })
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null })
      }, 3800)
    },

    clearToast: () => set({ toast: null }),

    setOpenProgress: (progress) => set({ openProgress: progress }),

    setFrameInfo: (info) => set({ frameInfo: info })
  }
})
