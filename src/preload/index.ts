import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  BatchProgress,
  BatchRequest,
  EditParams,
  ExportOptions,
  HolderScanDirection,
  NegLiftApi,
  OpenProgress,
  TransformParams
} from '@shared/types'

const CHANNEL = {
  openDialog: 'neglift:open-dialog',
  openPath: 'neglift:open-path',
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
  inpaintStatus: 'neglift:inpaint-status',
  inpaintPickModel: 'neglift:inpaint-pick-model',
  inpaintOpenFolder: 'neglift:inpaint-open-folder',
  previewWithModel: 'neglift:preview-with-model'
} as const

const api: NegLiftApi = {
  openImageDialog: () => ipcRenderer.invoke(CHANNEL.openDialog),
  openImagePath: (filePath: string) => ipcRenderer.invoke(CHANNEL.openPath, filePath),
  // 通过 webUtils 取回拖拽文件的真实磁盘路径，RAW 解码必须依赖路径
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  sampleBase: (u: number, v: number) => ipcRenderer.invoke(CHANNEL.sampleBase, u, v),
  detectNegative: (params: TransformParams) => ipcRenderer.invoke(CHANNEL.detect, params),
  detectHolder: (direction?: HolderScanDirection) =>
    ipcRenderer.invoke(CHANNEL.detectHolder, direction ?? 'inward'),
  chooseExportPath: (defaultName: string) => ipcRenderer.invoke(CHANNEL.chooseExportPath, defaultName),
  exportImage: (options: ExportOptions, params: EditParams) =>
    ipcRenderer.invoke(CHANNEL.exportImage, options, params),
  exportImageFromPath: (
    sourcePath: string,
    destPath: string,
    options: Omit<ExportOptions, 'filePath'>,
    params: EditParams
  ) => ipcRenderer.invoke(CHANNEL.exportImageFromPath, sourcePath, destPath, options, params),
  closeImage: () => ipcRenderer.invoke(CHANNEL.closeImage),
  showInFolder: (filePath: string) => ipcRenderer.invoke(CHANNEL.showInFolder, filePath),
  getPlatform: () => process.platform,
  onMenuCommand: (cb: (command: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: string): void => cb(command)
    ipcRenderer.on(CHANNEL.menuCommand, listener)
    return () => ipcRenderer.removeListener(CHANNEL.menuCommand, listener)
  },
  setImmersiveChrome: (on: boolean) => {
    ipcRenderer.send(CHANNEL.setImmersive, on)
  },
  setTitleTheme: (theme: 'dark' | 'light') => {
    ipcRenderer.send(CHANNEL.setTitleTheme, theme)
  },
  onOpenProgress: (cb: (progress: OpenProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: OpenProgress): void => cb(progress)
    ipcRenderer.on(CHANNEL.openProgress, listener)
    return () => ipcRenderer.removeListener(CHANNEL.openProgress, listener)
  },
  batchChooseFiles: () => ipcRenderer.invoke(CHANNEL.batchChooseFiles),
  batchChooseOutputDir: () => ipcRenderer.invoke(CHANNEL.batchChooseDir),
  batchRun: (request: BatchRequest) => ipcRenderer.invoke(CHANNEL.batchRun, request),
  batchCancel: () => ipcRenderer.invoke(CHANNEL.batchCancel),
  onBatchProgress: (cb: (progress: BatchProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: BatchProgress): void => cb(progress)
    ipcRenderer.on(CHANNEL.batchProgress, listener)
    return () => ipcRenderer.removeListener(CHANNEL.batchProgress, listener)
  },
  importCameraProfile: () => ipcRenderer.invoke(CHANNEL.importCameraProfile),
  openCameraProfileDir: () => ipcRenderer.invoke(CHANNEL.openProfileDir),
  inpaintStatus: () => ipcRenderer.invoke(CHANNEL.inpaintStatus),
  inpaintPickModel: () => ipcRenderer.invoke(CHANNEL.inpaintPickModel),
  inpaintOpenFolder: () => ipcRenderer.invoke(CHANNEL.inpaintOpenFolder),
  previewWithModel: (params: EditParams, maxEdge?: number) =>
    ipcRenderer.invoke(CHANNEL.previewWithModel, params, maxEdge)
}

contextBridge.exposeInMainWorld('negLift', api)
