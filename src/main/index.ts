import { join, basename as pathBasename } from 'node:path'
import { promises as fs } from 'node:fs'
import { cpus } from 'node:os'
import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type SaveDialogOptions
} from 'electron'
import sharp from 'sharp'
import type {
  BatchProgress,
  BatchRequest,
  ExportOptions,
  ExportResult,
  EditParams,
  OpenProgress,
  TransformParams,
  OpenedImage,
  OpenBatchResult,
  LibraryOpenEntry
} from '@shared/types'
import { computeGeometry, renderLinear, sourceToRegion } from '@shared/pipeline'
import { migrateExportOptions } from '@shared/exportFormat'
import { decideFidelityExport, fidelityOutputPath, isRestorationParams, restorationParentReference, type FidelityDecision } from '@shared/fidelityDecision'
import type { CanvasRepairStroke } from '@shared/pipeline/repair'
import { RAW_EXTENSIONS, RASTER_EXTENSIONS, BMP_EXTENSIONS, decodeImage, type DecodeResult } from './decode'
import { cancelBatch, runBatch } from './batch'
import { encodeAndWrite, writeFidelityProvenance } from './export'
import { hashFile, verifiedParent } from './verifiedParent'
import {
  applyModelRepairs,
  ensureModelsDir,
  getModelStatus,
  listModelFiles,
  loadModel,
  modelsDir
} from './inpaint/model'
import {
  clearSession,
  detectHolder,
  detectOnFull,
  getSession,
  makeLibraryThumb,
  openSession,
  sampleBase
} from './session'
import { FidelityConfigurationStore, fidelityConfigurationFile } from './fidelityConfigurations'
import type { FidelityConfiguration } from '@shared/fidelityConfiguration'

const CHANNEL = {
  openDialog: 'neglift:open-dialog',
  openPath: 'neglift:open-path',
  restorationComparison: 'neglift:restoration-comparison',
  openProgress: 'neglift:open-progress',
  sampleBase: 'neglift:sample-base',
  detect: 'neglift:detect',
  detectHolder: 'neglift:detect-holder',
  chooseExportPath: 'neglift:choose-export-path',
  exportImage: 'neglift:export-image',
  exportImageFromPath: 'neglift:export-image-from-path',
  closeImage: 'neglift:close-image',
  showInFolder: 'neglift:show-in-folder',
  menuCommand: 'neglift:menu-command',
  setImmersive: 'neglift:set-immersive',
  setTitleTheme: 'neglift:set-title-theme',
  batchChooseFiles: 'neglift:batch-choose-files',
  batchChooseDir: 'neglift:batch-choose-dir',
  batchRun: 'neglift:batch-run',
  batchCancel: 'neglift:batch-cancel',
  batchProgress: 'neglift:batch-progress',
  importCameraProfile: 'neglift:import-camera-profile',
  openProfileDir: 'neglift:open-profile-dir',
  fidelityList: 'neglift:fidelity-list',
  fidelitySaveDraft: 'neglift:fidelity-save-draft',
  fidelityActivate: 'neglift:fidelity-activate',
  fidelityRevise: 'neglift:fidelity-revise',
  fidelityImport: 'neglift:fidelity-import',
  fidelityExport: 'neglift:fidelity-export',
  inpaintStatus: 'neglift:inpaint-status',
  inpaintPickModel: 'neglift:inpaint-pick-model',
  inpaintOpenFolder: 'neglift:inpaint-open-folder',
  previewWithModel: 'neglift:preview-with-model'
} as const

let mainWindow: BrowserWindow | null = null

function sendMenuCommand(command: string): void {
  mainWindow?.webContents.send(CHANNEL.menuCommand, command)
}

function reportOpenProgress(progress: OpenProgress): void {
  mainWindow?.webContents.send(CHANNEL.openProgress, progress)
}

function stripDots(exts: string[]): string[] {
  return exts.map((e) => e.replace(/^\./, ''))
}

const ALL_IMAGE_EXTENSIONS = stripDots([...RAW_EXTENSIONS, ...RASTER_EXTENSIONS, ...BMP_EXTENSIONS])

function fidelityConfigurations(): FidelityConfigurationStore {
  return new FidelityConfigurationStore(fidelityConfigurationFile(app.getPath('userData')))
}

function applyTitleBarTheme(theme: 'dark' | 'light'): void {
  if (!mainWindow) return
  const dark = {
    color: '#17181b',
    symbolColor: '#e6e8ea',
    height: 48
  }
  const light = {
    color: '#f7f8fa',
    symbolColor: '#1d2025',
    height: 48
  }
  try {
    // Windows/macOS：系统标题栏配色跟随应用主题
    mainWindow.setTitleBarOverlay(theme === 'light' ? light : dark)
  } catch {
    /* 部分平台不支持 */
  }
  mainWindow.setBackgroundColor(theme === 'light' ? '#eceef1' : '#0e0f11')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#17181b',
    title: 'NegLift',
    autoHideMenuBar: false,
    // 隐藏系统原生标题栏，由应用顶栏承担；最小化/最大化/关闭用 overlay
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#17181b',
      symbolColor: '#e6e8ea',
      height: 48
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    if (/^https?:/.test(url)) void shell.openExternal(url)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about', label: '关于 NegLift' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '显示全部' },
              { type: 'separator' },
              { role: 'quit', label: '退出' }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: '文件',
      submenu: [
        { label: '打开图片…', accelerator: 'CmdOrCtrl+O', click: () => sendMenuCommand('open') },
        { label: '批量处理…', accelerator: 'CmdOrCtrl+Shift+B', click: () => sendMenuCommand('batch') },
        { label: '导出图片…', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendMenuCommand('export') },
        { type: 'separator' },
        { label: '关闭当前图片', accelerator: 'CmdOrCtrl+W', click: () => sendMenuCommand('close-image') },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => sendMenuCommand('undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendMenuCommand('redo') },
        { type: 'separator' },
        { label: '重置全部调整', accelerator: 'CmdOrCtrl+Shift+R', click: () => sendMenuCommand('reset') },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '适应窗口', accelerator: 'CmdOrCtrl+0', click: () => sendMenuCommand('zoom-fit') },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => sendMenuCommand('zoom-in') },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => sendMenuCommand('zoom-out') },
        { type: 'separator' },
        { label: '沉浸预览', accelerator: 'CmdOrCtrl+B', click: () => sendMenuCommand('immersive') },
        { label: '对比原片', accelerator: 'CmdOrCtrl+P', click: () => sendMenuCommand('compare') },
        { type: 'separator' },
        { label: '切换深浅主题', accelerator: 'CmdOrCtrl+D', click: () => sendMenuCommand('toggle-theme') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function applyRepairAndEncode(
  decode: { linear: Uint16Array; width: number; height: number },
  params: EditParams,
  options: ExportOptions,
  provenanceSummary?: string,
  exclusive = false
): Promise<number> {
  const geo = computeGeometry(decode.width, decode.height, params.transform)
  const longEdge = Math.max(geo.outputWidth, geo.outputHeight)
  const scale = options.maxDimension ? Math.min(1, options.maxDimension / longEdge) : 1
  const rendered = renderLinear(decode.linear, decode.width, decode.height, params, {
    applyCrop: true,
    scale
  })
  if (params.repairs?.length) {
    const strokes: CanvasRepairStroke[] = []
    const srcLong = Math.max(decode.width, decode.height)
    for (const st of params.repairs) {
      if (!st.points?.length || st.r <= 0) continue
      const pts: { x: number; y: number }[] = []
      for (const p of st.points) {
        const [u, v] = sourceToRegion(p.x, p.y, decode.width, decode.height, params.transform, true)
        pts.push({ x: u * rendered.width, y: v * rendered.height })
      }
      if (!pts.length) continue
      strokes.push({
        points: pts,
        r: Math.max(2, st.r * srcLong * scale),
        strength: st.strength ?? 1
      })
    }
    await applyModelRepairs(rendered.data, rendered.width, rendered.height, strokes)
  }
  return encodeAndWrite({
    display: rendered.data,
    width: rendered.width,
    height: rendered.height,
    options,
    provenanceSummary,
    exclusive
  })
}

async function fidelityExport(
  sourcePath: string,
  decode: DecodeResult,
  params: EditParams,
  options: ExportOptions
): Promise<{ decision: FidelityDecision; options: ExportOptions; provenance: string }> {
  const requested = options.fidelity
  const configuration = requested?.configurationId
    ? (await fidelityConfigurations().list()).find((item) => item.id === requested.configurationId) ?? null
    : null
  const sourceSha256 = requested?.mode === 'fidelity' ? await hashFile(sourcePath) : null
  let parent: { sourcePath: string; sourceSha256: string; fidelity: { status: 'verified-user-attested' } } | null = null
  let changes: Partial<EditParams> | null = null
  if (requested?.mode === 'fidelity' && isRestorationParams(params) && sourceSha256) {
    const prior = await verifiedParent(sourcePath, sourceSha256)
    if (prior) {
      parent = { sourcePath, sourceSha256, fidelity: { status: 'verified-user-attested' } }
      changes = Object.fromEntries(Object.entries(params).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(prior.params[key as keyof EditParams]))) as Partial<EditParams>
    }
  }
  const decision = decideFidelityExport({
    mode: requested?.mode ?? 'practical', configuration, params,
    source: { path: sourcePath, isRaw: decode.isRaw, sha256: sourceSha256, camera: decode.camera, lens: decode.lens, degraded: decode.degraded },
    now: new Date().toISOString(), shortCheckPassed: requested?.shortCheckPassed, shortCheckAt: requested?.shortCheckAt, rollLock: requested?.rollLock,
    parent: parent ? { sourcePath, sourceSha256: parent.sourceSha256, status: 'verified-user-attested' } : null
  })
  if (requested?.mode === 'fidelity' && isRestorationParams(params) && !parent) {
    throw new Error('修复派生文件需要已验证的父版及其完整谱系记录；请重新导出父版，或使用实用转换。')
  }
  const output = { ...options, filePath: fidelityOutputPath(options.filePath, decision) }
  if (decision.requiresTiff16) { output.format = 'tiff'; output.tiffBitDepth = 16 }
  const provenance = JSON.stringify({
    schemaVersion: 1, sourcePath, sourceSha256,
    fidelity: { status: decision.status, reasons: decision.reasons, configuration, requested, parent, changes }, params
  })
  return { decision, options: output, provenance }
}

function registerIpc(): void {
  ipcMain.on(CHANNEL.setImmersive, (_event, on: boolean) => {
    if (!mainWindow) return
    mainWindow.setAutoHideMenuBar(!!on)
    mainWindow.setMenuBarVisibility(!on)
  })

  ipcMain.on(CHANNEL.setTitleTheme, (_event, theme: 'dark' | 'light') => {
    applyTitleBarTheme(theme === 'light' ? 'light' : 'dark')
  })

  ipcMain.handle(CHANNEL.openDialog, async (): Promise<OpenBatchResult | null> => {
    const owner = mainWindow
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title: '打开图片（可多选）',
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: '所有支持的图像', extensions: ALL_IMAGE_EXTENSIONS },
            { name: 'RAW 原始文件', extensions: stripDots(RAW_EXTENSIONS) },
            { name: '常见图像', extensions: stripDots([...RASTER_EXTENSIONS, ...BMP_EXTENSIONS]) }
          ]
        })
      : await dialog.showOpenDialog({
          title: '打开图片',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '所有支持的图像', extensions: ALL_IMAGE_EXTENSIONS }]
        })

    if (result.canceled || result.filePaths.length === 0) return null

    const files = result.filePaths
    const entries: LibraryOpenEntry[] = []
    let active: OpenedImage | null = null

    // 逐张打开：除最后一张外只回传缩略图，避免多张全尺寸预览经 IPC 崩溃
    for (let i = 0; i < files.length; i++) {
      const isLast = i === files.length - 1
      reportOpenProgress({
        stage: 'open',
        progress: i / files.length,
        label: `打开 ${i + 1}/${files.length}：${files[i].split(/[\\/]/).pop()}`
      })
      const opened = await openSession(files[i], reportOpenProgress)
      if (isLast) {
        active = opened
        const entry = await makeLibraryThumb(opened)
        entries.push(entry)
      } else {
        const entry = await makeLibraryThumb(opened)
        entries.push(entry)
        // 释放主进程会话中的全尺寸缓冲，降低峰值内存
        clearSession()
      }
    }
    reportOpenProgress({ stage: 'ready', progress: 1, label: '完成' })
    return { entries, active }
  })

  ipcMain.handle(CHANNEL.openPath, async (_event, filePath: string) => {
    return openSession(filePath, reportOpenProgress)
  })

  ipcMain.handle(CHANNEL.restorationComparison, async (_event, filePath: string) => {
    try {
      const parent = restorationParentReference(await fs.readFile(`${filePath}.provenance.json`, 'utf8'))
      if (!parent || (await hashFile(parent.path))?.toLowerCase() !== parent.sha256.toLowerCase() ||
        (await hashFile(filePath))?.toLowerCase() !== parent.childSha256.toLowerCase()) return null
      const preview = async (path: string): Promise<string> =>
        `data:image/jpeg;base64,${(await sharp(path).rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).toColourspace('srgb').jpeg({ quality: 85 }).toBuffer()).toString('base64')}`
      return { parent: await preview(parent.path), child: await preview(filePath) }
    } catch {
      return null
    }
  })

  ipcMain.handle(CHANNEL.sampleBase, (_event, u: number, v: number) => {
    return sampleBase(u, v)
  })

  ipcMain.handle(CHANNEL.detect, (_event, transform?: TransformParams) => detectOnFull(transform))

  ipcMain.handle(CHANNEL.detectHolder, (_event, direction?: 'inward' | 'outward') =>
    detectHolder(direction === 'outward' ? 'outward' : 'inward')
  )

  ipcMain.handle(CHANNEL.chooseExportPath, async (_event, defaultName: string) => {
    const owner = mainWindow
    const options = {
      title: '导出图片',
      defaultPath: defaultName,
      filters: [
        { name: 'JPEG 图片', extensions: ['jpg'] },
        { name: 'PNG 图片', extensions: ['png'] },
        { name: 'TIFF 图片', extensions: ['tif', 'tiff'] },
        { name: 'BMP 图片', extensions: ['bmp'] }
      ]
    }
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle(CHANNEL.exportImage, async (_event, options: ExportOptions, params: EditParams): Promise<ExportResult> => {
    const session = getSession()
    if (!session) return { ok: false, error: '没有已打开的图片' }
    try {
      const legacyDng = (options as { format?: unknown }).format === 'dng'
      const migrated = migrateExportOptions(options)
      const prepared = await fidelityExport(session.sourcePath, session.decode, params, migrated)
      const size = await applyRepairAndEncode(session.decode, params, prepared.options, prepared.provenance, prepared.decision.status !== 'practical')
      if (prepared.decision.status !== 'practical') await writeFidelityProvenance(prepared.options.filePath, prepared.provenance)
      return {
        ok: true,
        filePath: prepared.options.filePath,
        fileSize: size,
        width: computeGeometry(session.decode.width, session.decode.height, params.transform).outputWidth,
        height: computeGeometry(session.decode.width, session.decode.height, params.transform).outputHeight,
        ...(legacyDng ? { notice: '旧版 DNG 导出已迁移为 16 位 TIFF。' } : {}),
        fidelityStatus: prepared.decision.status,
        fidelityReasons: prepared.decision.reasons
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    CHANNEL.exportImageFromPath,
    async (
      _event,
      sourcePath: string,
      destPath: string,
      options: Omit<ExportOptions, 'filePath'>,
      params: EditParams
    ): Promise<ExportResult> => {
      try {
        const decode = await decodeImage(sourcePath)
        const legacyDng = (options as { format?: unknown }).format === 'dng'
        const migrated = migrateExportOptions({ ...options, filePath: destPath })
        const prepared = await fidelityExport(sourcePath, decode, params, migrated)
        const size = await applyRepairAndEncode(decode, params, prepared.options, prepared.provenance, prepared.decision.status !== 'practical')
        if (prepared.decision.status !== 'practical') await writeFidelityProvenance(prepared.options.filePath, prepared.provenance)
        const geo = computeGeometry(decode.width, decode.height, params.transform)
        return {
          ok: true,
          filePath: prepared.options.filePath,
          fileSize: size,
          width: geo.outputWidth,
          height: geo.outputHeight,
          ...(legacyDng ? { notice: '旧版 DNG 导出已迁移为 16 位 TIFF。' } : {}),
          fidelityStatus: prepared.decision.status,
          fidelityReasons: prepared.decision.reasons
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(CHANNEL.closeImage, () => {
    clearSession()
  })

  ipcMain.handle(CHANNEL.showInFolder, (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle(CHANNEL.batchChooseFiles, async () => {
    const owner = mainWindow
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title: '选择批量处理的图片',
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: '所有支持的图像', extensions: ALL_IMAGE_EXTENSIONS },
            { name: 'RAW 原始文件', extensions: stripDots(RAW_EXTENSIONS) },
            { name: '常见图像', extensions: stripDots([...RASTER_EXTENSIONS, ...BMP_EXTENSIONS]) }
          ]
        })
      : await dialog.showOpenDialog({
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '所有支持的图像', extensions: ALL_IMAGE_EXTENSIONS }]
        })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })

  ipcMain.handle(CHANNEL.batchChooseDir, async () => {
    const owner = mainWindow
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title: '选择批量输出目录',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(CHANNEL.batchCancel, () => {
    cancelBatch()
  })

  ipcMain.handle(CHANNEL.batchRun, async (_event, request: BatchRequest): Promise<BatchProgress | null> => {
    if (!request?.files?.length || !request.outputDir) return null
    try {
      const configuration = request.export.fidelity?.configurationId
        ? (await fidelityConfigurations().list()).find((item) => item.id === request.export.fidelity?.configurationId) ?? null
        : null
      return await runBatch(request, (p) => {
        mainWindow?.webContents.send(CHANNEL.batchProgress, p)
      }, configuration)
    } catch (err) {
      return {
        index: 0,
        total: request.files.length,
        fileName: '',
        stage: err instanceof Error ? err.message : String(err),
        progress: 0,
        overall: 0,
        status: 'finished',
        results: []
      }
    }
  })

  ipcMain.handle(CHANNEL.importCameraProfile, async () => {
    const owner = mainWindow
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title: '导入机型优化配置（JSON）',
          properties: ['openFile'],
          filters: [{ name: 'JSON 配置', extensions: ['json'] }]
        })
      : await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [{ name: 'JSON 配置', extensions: ['json'] }]
        })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const text = await fs.readFile(filePath, 'utf8')
    const { importCameraProfilesJson } = await import('./cameraProfiles')
    const saved = await importCameraProfilesJson(text, pathBasename(filePath))
    return { ok: true as const, path: saved.path, count: saved.count }
  })

  ipcMain.handle(CHANNEL.openProfileDir, async () => {
    const { loadUserProfiles } = await import('./cameraProfiles')
    await loadUserProfiles(true)
    const dir = join(app.getPath('userData'), 'neglift-camera-profiles')
    await fs.mkdir(dir, { recursive: true })
    shell.openPath(dir)
  })

  ipcMain.handle(CHANNEL.fidelityList, () => fidelityConfigurations().list())
  ipcMain.handle(CHANNEL.fidelitySaveDraft, (_event, configuration: FidelityConfiguration) =>
    fidelityConfigurations().saveDraft(configuration)
  )
  ipcMain.handle(CHANNEL.fidelityActivate, (_event, id: string) => fidelityConfigurations().activate(id))
  ipcMain.handle(
    CHANNEL.fidelityRevise,
    (_event, id: string, nextId: string, createdAt: string, changes: Parameters<FidelityConfigurationStore['revise']>[3]) =>
      fidelityConfigurations().revise(id, nextId, createdAt, changes)
  )
  ipcMain.handle(CHANNEL.fidelityImport, async () => {
    const options: OpenDialogOptions = {
      title: '导入保真采集配置（JSON）', properties: ['openFile'] as const, filters: [{ name: 'JSON 配置', extensions: ['json'] }]
    }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return fidelityConfigurations().importJson(await fs.readFile(result.filePaths[0], 'utf8'))
  })
  ipcMain.handle(CHANNEL.fidelityExport, async () => {
    const options: SaveDialogOptions = {
      title: '导出保真采集配置（JSON）', defaultPath: 'neglift-fidelity-configurations.json', filters: [{ name: 'JSON 配置', extensions: ['json'] }]
    }
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, await fidelityConfigurations().exportJson(), 'utf8')
    return result.filePath
  })

  ipcMain.handle(CHANNEL.inpaintStatus, () => getModelStatus())

  ipcMain.handle(CHANNEL.inpaintPickModel, async () => {
    const owner = mainWindow
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title: '选择修补 ONNX 模型（如 LaMa）',
          properties: ['openFile'],
          filters: [{ name: 'ONNX', extensions: ['onnx'] }]
        })
      : await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [{ name: 'ONNX', extensions: ['onnx'] }]
        })
    if (result.canceled || !result.filePaths[0]) return getModelStatus()
    return loadModel(result.filePaths[0])
  })

  ipcMain.handle(CHANNEL.inpaintOpenFolder, async () => {
    await ensureModelsDir()
    shell.openPath(modelsDir())
    return listModelFiles()
  })

  ipcMain.handle(
    CHANNEL.previewWithModel,
    async (
      _event,
      params: EditParams,
      maxEdge = 1280
    ): Promise<{ ok: boolean; dataUrl?: string; width?: number; height?: number; error?: string }> => {
      try {
        const session = getSession()
        if (!session) return { ok: false, error: '没有已打开的图片' }
        const decode = session.decode
        const geo = computeGeometry(decode.width, decode.height, params.transform)
        const longEdge = Math.max(geo.outputWidth, geo.outputHeight, 1)
        const scale = Math.min(1, maxEdge / longEdge)
        const rendered = renderLinear(decode.linear, decode.width, decode.height, params, {
          applyCrop: true,
          scale
        })
        if (params.repairs?.length) {
          const strokes: CanvasRepairStroke[] = []
          const srcLong = Math.max(decode.width, decode.height)
          for (const st of params.repairs) {
            if (!st.points?.length || st.r <= 0) continue
            const pts: { x: number; y: number }[] = []
            for (const p of st.points) {
              const [u, v] = sourceToRegion(p.x, p.y, decode.width, decode.height, params.transform, true)
              pts.push({ x: u * rendered.width, y: v * rendered.height })
            }
            if (!pts.length) continue
            strokes.push({
              points: pts,
              r: Math.max(2, st.r * srcLong * scale),
              strength: st.strength ?? 1
            })
          }
          await applyModelRepairs(rendered.data, rendered.width, rendered.height, strokes)
        }
        const rgb8 = Buffer.allocUnsafe(rendered.width * rendered.height * 3)
        for (let i = 0; i < rendered.data.length; i++) rgb8[i] = rendered.data[i] >> 8
        const buf = await sharp(rgb8, {
          raw: { width: rendered.width, height: rendered.height, channels: 3 }
        })
          .jpeg({ quality: 88 })
          .toBuffer()
        return {
          ok: true,
          dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
          width: rendered.width,
          height: rendered.height
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

void app.whenReady().then(() => {
  app.setName('NegLift')
  try {
    const cores = Math.max(1, cpus().length)
    sharp.concurrency(Math.max(1, Math.min(8, cores)))
  } catch {
    /* ignore */
  }
  registerIpc()
  buildMenu()
  createWindow()
  // 本地 ONNX 修补已停用，不再自动加载模型

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

process.on('uncaughtException', (err) => {
  console.error('[NegLift] uncaughtException', err)
  try {
    dialog.showErrorBox('NegLift 错误', err?.stack || err?.message || String(err))
  } catch {
    /* ignore */
  }
})

process.on('unhandledRejection', (err) => {
  console.error('[NegLift] unhandledRejection', err)
})
