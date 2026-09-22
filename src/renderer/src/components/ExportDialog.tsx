import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, Share2, X } from 'lucide-react'
import type { ExportOptions } from '@shared/types'
import type { FidelityConfiguration } from '@shared/fidelityConfiguration'
import { useEditor } from '../state/store'

type ExportFormat = ExportOptions['format']
type Scope = 'current' | 'selected' | 'all'

const FORMATS: { id: ExportFormat; label: string; ext: string; note: string }[] = [
  { id: 'jpeg', label: 'JPEG', ext: 'jpg', note: '体积小，适合分享与网络发布' },
  { id: 'png', label: 'PNG', ext: 'png', note: '无损压缩，适合需要继续后期的图像' },
  { id: 'tiff', label: 'TIFF', ext: 'tif', note: '无损，可选 8/16 位，适合印刷与归档' },
  { id: 'bmp', label: 'BMP', ext: 'bmp', note: '无压缩位图，兼容性最好' }
]

const LONG_EDGES = [1024, 1920, 2560, 4096]

function splitPath(filePath: string): { dir: string; base: string } {
  const match = /^(.*)[\\/]([^\\/]*)$/.exec(filePath)
  const dir = match ? match[1] : ''
  const name = match ? match[2] : filePath
  return { dir, base: name.replace(/\.[^.]+$/, '') }
}

function baseName(filePath: string): string {
  const m = /[\\/]([^\\/]+)$/.exec(filePath)
  const name = m ? m[1] : filePath
  return name.replace(/\.[^.]+$/, '')
}

export function ExportDialog() {
  const image = useEditor((s) => s.image)
  const open = useEditor((s) => s.exportOpen)
  const exporting = useEditor((s) => s.exporting)
  const params = useEditor((s) => s.params)
  const library = useEditor((s) => s.library)
  const syncActiveToLibrary = useEditor((s) => s.syncActiveToLibrary)
  const setExportOpen = useEditor((s) => s.setExportOpen)
  const setExporting = useEditor((s) => s.setExporting)
  const notify = useEditor((s) => s.notify)

  const [format, setFormat] = useState<ExportFormat>('jpeg')
  const [quality, setQuality] = useState(92)
  const [bitDepth, setBitDepth] = useState<8 | 16>(8)
  const [maxDimension, setMaxDimension] = useState<number | null>(null)
  const [dpi, setDpi] = useState(300)
  const [customLongEdge, setCustomLongEdge] = useState('')
  const [target, setTarget] = useState<string | null>(null)
  const [scope, setScope] = useState<Scope>('current')
  const [fidelity, setFidelity] = useState(false)
  const [configurations, setConfigurations] = useState<FidelityConfiguration[]>([])
  const [configurationId, setConfigurationId] = useState('')

  const meta = useMemo(() => {
    if (!image) return null
    return splitPath(image.meta.filePath)
  }, [image])

  const selectedCount = useMemo(() => library.filter((i) => i.selected).length, [library])

  useEffect(() => {
    setTarget(null)
    if (library.length <= 1) setScope('current')
  }, [format, image, library.length])

  useEffect(() => {
    if (!open) return
    void window.negLift.listFidelityConfigurations().then((items) => setConfigurations(items.filter((item) => item.status === 'active')))
  }, [open])

  if (!open || !image || !meta) return null

  const spec = FORMATS.find((f) => f.id === format) ?? FORMATS[0]
  const isJpeg = format === 'jpeg'
  const isTiff = format === 'tiff'
  const multi = library.length > 1
  const exportCount =
    scope === 'current' ? 1 : scope === 'selected' ? selectedCount : library.length

  const defaultName = `${meta.dir ? `${meta.dir}/` : ''}${meta.base}_neglift.${spec.ext}`

  const choosePath = async (): Promise<string | null> => {
    const chosen = await window.negLift.chooseExportPath(target ?? defaultName)
    if (chosen) setTarget(chosen)
    return chosen
  }

  const runExport = async (): Promise<void> => {
    setExporting(true)
    try {
      if (!multi || scope === 'current') {
        const filePath = target ?? (await choosePath())
        if (!filePath) return
        const result = await window.negLift.exportImage(
          { filePath, format: fidelity ? 'tiff' : format, quality, tiffBitDepth: fidelity ? 16 : bitDepth, maxDimension, dpi, fidelity: fidelity ? { mode: 'fidelity', configurationId: configurationId || undefined } : undefined },
          params
        )
        if (!result.ok) {
          notify(result.error ?? '导出失败', 'error')
          return
        }
        if (result.fidelityStatus === 'restoration' && result.filePath) useEditor.getState().setRestorationPath(result.filePath)
        const size = result.fileSize ? `${(result.fileSize / 1024).toFixed(0)} KB` : ''
        const fidelityNote = result.fidelityStatus && result.fidelityStatus !== 'practical'
          ? ` · ${result.fidelityStatus === 'verified-user-attested' ? '用户确认的验证' : result.fidelityStatus === 'restoration' ? '修复派生文件' : '未验证'}${result.fidelityReasons?.length ? `：${result.fidelityReasons.join('；')}` : ''}` : ''
        notify(`${result.notice ? `${result.notice} ` : ''}已导出 ${result.width} × ${result.height} ${size}${fidelityNote}`)
        setTarget(result.filePath ?? filePath)
        return
      }

      // 多张：选输出目录
      syncActiveToLibrary()
      const snap = useEditor.getState().library
      const items =
        scope === 'selected' ? snap.filter((i) => i.selected) : snap
      if (items.length === 0) {
        notify('没有可导出的照片', 'error')
        return
      }
      const dir = await window.negLift.batchChooseOutputDir()
      if (!dir) return

      let ok = 0
      let fail = 0
      for (const item of items) {
        const src = item.meta?.filePath ?? item.image?.meta.filePath
        if (!src) continue
        const destPath = `${dir}\\${baseName(src)}_neglift.${spec.ext}`
        const result = await window.negLift.exportImageFromPath(
          src,
          destPath,
          { format: fidelity ? 'tiff' : format, quality, tiffBitDepth: fidelity ? 16 : bitDepth, maxDimension, dpi, fidelity: fidelity ? { mode: 'fidelity', configurationId: configurationId || undefined } : undefined },
          item.params
        )
        if (result.ok) {
          ok++
          if (result.notice) notify(result.notice)
        } else fail++
      }
      if (fail > 0) notify(`批量导出完成：成功 ${ok}，失败 ${fail}`, 'error')
      else notify(`已导出 ${ok} 张到 ${dir}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="modal-backdrop" onPointerDown={() => !exporting && setExportOpen(false)}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>导出图片</span>
          <span className="spacer" />
          <button className="btn is-ghost is-icon" onClick={() => setExportOpen(false)} disabled={exporting}>
            <X size={15} />
          </button>
        </div>

        <div className="modal-body">
          {multi && (
            <div className="section">
              <div className="section-head">
                <span className="section-title">导出范围</span>
              </div>
              <div className="chips">
                <button
                  className={`chip${scope === 'current' ? ' is-active' : ''}`}
                  onClick={() => setScope('current')}
                >
                  仅当前
                </button>
                <button
                  className={`chip${scope === 'selected' ? ' is-active' : ''}`}
                  onClick={() => setScope('selected')}
                  disabled={selectedCount === 0}
                >
                  选中（{selectedCount}）
                </button>
                <button
                  className={`chip${scope === 'all' ? ' is-active' : ''}`}
                  onClick={() => setScope('all')}
                >
                  全部（{library.length}）
                </button>
              </div>
              <p className="hint">在底部胶片条勾选需要导出的照片；多张时使用各自的调色参数。</p>
            </div>
          )}

          <div className="section">
            <div className="section-head">
              <span className="section-title">格式</span>
            </div>
            <div className="chips">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  className={`chip${f.id === format ? ' is-active' : ''}`}
                  onClick={() => setFormat(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <p className="hint">{spec.note}</p>
          </div>

          <div className="section">
            <div className="section-head"><span className="section-title">保真模式预览</span></div>
            <label className="switch-row"><input type="checkbox" checked={fidelity} onChange={(e) => setFidelity(e.target.checked)} /><span>生成可追溯保真派生文件</span></label>
            {fidelity && <>
              <select className="field" value={configurationId} onChange={(e) => setConfigurationId(e.target.value)}>
                <option value="">未选择采集配置（将导出未验证文件）</option>
                {configurations.map((item) => <option key={item.id} value={item.id}>{item.name}（修订版 {item.revision}）</option>)}
              </select>
              <p className="hint">保真模式固定导出 16 位 TIFF；缺少或未通过证据会自动加 `_unverified` 后缀，并写入配套谱系记录文件。</p>
            </>}
          </div>

          {isJpeg && (
            <div className="section">
              <div className="section-head">
                <span className="section-title">压缩质量</span>
                <span className="spacer" />
                <span className="meta">{quality}</span>
              </div>
              <input
                className="slider-input"
                type="range"
                min={1}
                max={100}
                value={quality}
                onChange={(e) => setQuality(Number.parseInt(e.target.value, 10))}
              />
              <p className="hint">质量 ≥ 90 时使用 4:4:4 无色度抽样，最大限度保留色彩细节。</p>
            </div>
          )}

          {isTiff && (
            <div className="section">
              <div className="section-head">
                <span className="section-title">位深</span>
              </div>
              <div className="chips">
                {([8, 16] as const).map((depth) => (
                  <button
                    key={depth}
                    className={`chip${depth === bitDepth ? ' is-active' : ''}`}
                    onClick={() => setBitDepth(depth)}
                  >
                    {depth} 位
                  </button>
                ))}
              </div>
              <p className="hint">
                16 位导出保留完整影调层次，文件更大；8 位兼容性更好。
              </p>
            </div>
          )}

          <div className="section">
            <div className="section-head">
              <span className="section-title">输出尺寸</span>
            </div>
            <div className="chips">
              <button
                className={`chip${maxDimension === null ? ' is-active' : ''}`}
                onClick={() => {
                  setMaxDimension(null)
                  setCustomLongEdge('')
                }}
              >
                原始尺寸
              </button>
              {LONG_EDGES.map((edge) => (
                <button
                  key={edge}
                  className={`chip${maxDimension === edge ? ' is-active' : ''}`}
                  onClick={() => {
                    setMaxDimension(edge)
                    setCustomLongEdge('')
                  }}
                >
                  长边 {edge}
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="row-label">自定义长边</span>
              <input
                className="field is-num"
                type="number"
                min={64}
                placeholder="像素"
                value={customLongEdge}
                onChange={(e) => {
                  setCustomLongEdge(e.target.value)
                  const parsed = Number.parseInt(e.target.value, 10)
                  setMaxDimension(Number.isFinite(parsed) && parsed > 0 ? parsed : null)
                }}
              />
            </div>
            <div className="row">
              <span className="row-label">分辨率（DPI）</span>
              <input
                className="field is-num"
                type="number"
                min={36}
                max={2400}
                value={dpi}
                onChange={(e) => setDpi(Math.max(36, Math.min(2400, Number.parseInt(e.target.value, 10) || 300)))}
              />
            </div>
          </div>

          <div className="section">
            <div className="section-head">
              <span className="section-title">保存位置</span>
            </div>
            {multi && scope !== 'current' ? (
              <p className="hint" style={{ marginTop: 0 }}>
                多张导出时将选择输出目录，文件名为「原名_neglift.扩展名」。
              </p>
            ) : (
              <div className="row">
                <input className="field" style={{ flex: 1 }} readOnly value={target ?? defaultName} />
                <button className="btn" onClick={() => void choosePath()}>
                  <FolderOpen size={14} /> 浏览
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <button
            className="btn"
            onClick={() => {
              if (target) void window.negLift.showInFolder(target)
            }}
            disabled={!target || exporting || (multi && scope !== 'current')}
            title="在文件管理器中显示已导出的文件"
          >
            <Share2 size={14} /> 打开所在文件夹
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn" onClick={() => setExportOpen(false)} disabled={exporting}>
            取消
          </button>
          <button className="btn is-primary" onClick={() => void runExport()} disabled={exporting || (multi && scope === 'selected' && selectedCount === 0)}>
            {exporting
              ? '正在导出…'
              : multi && scope !== 'current'
                ? `导出 ${exportCount} 张`
                : '导出'}
          </button>
        </div>
      </div>
    </div>
  )
}
