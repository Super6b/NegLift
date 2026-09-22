import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, FolderOpen, Layers, Play, Square, X, XCircle } from 'lucide-react'
import type { BatchFileResult, BatchProgress, BatchRequest, ExportOptions } from '@shared/types'
import type { FidelityConfiguration } from '@shared/fidelityConfiguration'
import { useEditor } from '../state/store'

type ExportFormat = ExportOptions['format']

const FORMATS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: 'jpeg', label: 'JPEG', ext: 'jpg' },
  { id: 'png', label: 'PNG', ext: 'png' },
  { id: 'tiff', label: 'TIFF', ext: 'tif' },
  { id: 'bmp', label: 'BMP', ext: 'bmp' }
]

const LONG_EDGES = [0, 1920, 2560, 4096]

export function BatchDialog() {
  const open = useEditor((s) => s.batchOpen)
  const setOpen = useEditor((s) => s.setBatchOpen)
  const params = useEditor((s) => s.params)
  const hasImage = useEditor((s) => s.image !== null)
  const notify = useEditor((s) => s.notify)

  const [files, setFiles] = useState<string[]>([])
  const [outputDir, setOutputDir] = useState<string | null>(null)
  const [format, setFormat] = useState<ExportFormat>('jpeg')
  const [quality, setQuality] = useState(92)
  const [bitDepth, setBitDepth] = useState<8 | 16>(8)
  const [maxDimension, setMaxDimension] = useState(0)
  const [dpi, setDpi] = useState(300)
  const [autoHolder, setAutoHolder] = useState(true)
  const [autoDetect, setAutoDetect] = useState(true)
  const [useTemplate, setUseTemplate] = useState(true)
  const [fidelity, setFidelity] = useState(false)
  const [configurations, setConfigurations] = useState<FidelityConfiguration[]>([])
  const [configurationId, setConfigurationId] = useState('')

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<BatchProgress | null>(null)
  const [results, setResults] = useState<BatchFileResult[]>([])

  useEffect(() => {
    if (!open) return
    setResults([])
    setProgress(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    void window.negLift.listFidelityConfigurations().then((items) => setConfigurations(items.filter((item) => item.status === 'active')))
  }, [open])

  useEffect(() => window.negLift.onBatchProgress((p) => setProgress(p)), [])

  const okCount = useMemo(() => results.filter((r) => r.ok).length, [results])
  const failCount = results.length - okCount

  if (!open) return null

  const pickFiles = async (): Promise<void> => {
    const chosen = await window.negLift.batchChooseFiles()
    if (chosen) setFiles(chosen)
  }

  const pickDir = async (): Promise<void> => {
    const dir = await window.negLift.batchChooseOutputDir()
    if (dir) setOutputDir(dir)
  }

  const canRun = files.length > 0 && !!outputDir && !running

  const start = async (): Promise<void> => {
    if (!canRun) return
    const request: BatchRequest = {
      files,
      outputDir: outputDir as string,
      template: params,
      export: {
        format: fidelity ? 'tiff' : format,
        quality,
        tiffBitDepth: fidelity ? 16 : bitDepth,
        maxDimension: maxDimension > 0 ? maxDimension : null,
        dpi,
        fidelity: fidelity ? { mode: 'fidelity', configurationId: configurationId || undefined } : undefined
      },
      autoHolder: useTemplate ? autoHolder : true,
      autoDetect: useTemplate ? autoDetect : true
    }
    // 不用模板时：仍用几何（旋转/裁切）来自「当前」若无图则全默认由 main clone
    if (!useTemplate) {
      request.template = { ...params, basic: { ...params.basic, temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, saturation: 0, vibrance: 0 } }
    }

    setRunning(true)
    setResults([])
    setProgress(null)
    try {
      const final = await window.negLift.batchRun(request)
      if (final) {
        setProgress(final)
        setResults(final.results)
        const ok = final.results.filter((r) => r.ok).length
        const bad = final.results.length - ok
        if (final.status === 'cancelled') notify(`批量已取消：完成 ${ok}，失败 ${bad}`, 'error')
        else if (bad > 0) notify(`批量完成：成功 ${ok}，失败 ${bad}`, 'error')
        else notify(`批量完成：共 ${ok} 张已导出到 ${outputDir}`)
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setRunning(false)
    }
  }

  const cancel = async (): Promise<void> => {
    await window.negLift.batchCancel()
  }

  const pct = progress ? Math.round(progress.overall * 100) : 0
  const isTiff = format === 'tiff'
  const isJpeg = format === 'jpeg'

  return (
    <div className="modal-backdrop" onClick={() => !running && setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <div className="modal-head">
          <span className="modal-title">
            <Layers size={15} /> 批量处理
          </span>
          <button className="btn is-ghost is-icon" disabled={running} onClick={() => setOpen(false)}>
            <X size={15} />
          </button>
        </div>

        <div className="modal-body">
          <p className="hint" style={{ marginTop: 0 }}>
            对多张底片依次执行：自动片夹有效区 → 自动去色罩 → 套用当前风格（基础/曲线/HSL/分级）→ 导出。
            每张独立检测，互不影响当前编辑中的图片。
          </p>

          <div className="section">
            <div className="section-head">
              <span className="section-title">源文件</span>
              <span className="spacer" />
              <span className="meta">{files.length} 张</span>
            </div>
            <div className="row">
              <button className="btn" onClick={() => void pickFiles()} disabled={running}>
                <FolderOpen size={14} /> 选择图片…
              </button>
              {files.length > 0 && (
                <button className="btn is-ghost" disabled={running} onClick={() => setFiles([])}>
                  清空
                </button>
              )}
            </div>
            {files.length > 0 && (
              <div className="batch-file-list">
                {files.slice(0, 8).map((f) => (
                  <div key={f} className="batch-file-item" title={f}>
                    {f.split(/[\\/]/).pop()}
                  </div>
                ))}
                {files.length > 8 && <div className="batch-file-item">… 另有 {files.length - 8} 个文件</div>}
              </div>
            )}
          </div>

          <div className="section">
            <div className="section-head"><span className="section-title">整卷保真锁定（预览）</span></div>
            <label className="switch-row"><input type="checkbox" checked={fidelity} disabled={running} onChange={(e) => setFidelity(e.target.checked)} /><span>对本卷使用同一采集配置</span></label>
            {fidelity && <>
              <select className="field" value={configurationId} disabled={running} onChange={(e) => setConfigurationId(e.target.value)}>
                <option value="">未选择采集配置（整卷将标记为未验证）</option>
                {configurations.map((item) => <option key={item.id} value={item.id}>{item.name}（修订版 {item.revision}）</option>)}
              </select>
              <p className="hint">16 位 TIFF；自动反相仅为视觉起点。没有通过相应验证的帧标记为 _unverified，不代表色彩准确。</p>
            </>}
          </div>

          <div className="section">
            <div className="section-head">
              <span className="section-title">输出目录</span>
            </div>
            <div className="row">
              <button className="btn" onClick={() => void pickDir()} disabled={running}>
                <FolderOpen size={14} /> 选择目录…
              </button>
              {outputDir && <span className="meta" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{outputDir}</span>}
            </div>
          </div>

          <div className="section">
            <div className="section-head">
              <span className="section-title">处理选项</span>
            </div>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={useTemplate}
                disabled={running}
                onChange={(e) => setUseTemplate(e.target.checked)}
              />
              <span>套用当前风格调整（基础/曲线/HSL/分级）</span>
            </label>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={autoDetect}
                disabled={running}
                onChange={(e) => setAutoDetect(e.target.checked)}
              />
              <span>每张自动检测去色罩（推荐）</span>
            </label>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={autoHolder}
                disabled={running}
                onChange={(e) => setAutoHolder(e.target.checked)}
              />
              <span>每张自动识别片夹有效区（推荐）</span>
            </label>
            {!hasImage && (
              <p className="hint">当前未打开图片：将只做自动检测，不叠加风格参数。</p>
            )}
          </div>

          <div className="section">
            <div className="section-head">
              <span className="section-title">导出格式</span>
            </div>
            <div className="chips">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  className={`chip${format === f.id ? ' is-active' : ''}`}
                  disabled={running}
                  onClick={() => setFormat(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {isJpeg && (
              <div className="row" style={{ marginTop: 8 }}>
                <span className="slider-label">质量 {quality}</span>
                <input
                  type="range"
                  min={60}
                  max={100}
                  value={quality}
                  disabled={running}
                  onChange={(e) => setQuality(Number(e.target.value))}
                  style={{ flex: 1 }}
                />
              </div>
            )}
            {isTiff && (
              <div className="chips" style={{ marginTop: 8 }}>
                <button className={`chip${bitDepth === 8 ? ' is-active' : ''}`} disabled={running} onClick={() => setBitDepth(8)}>
                  8 位
                </button>
                <button className={`chip${bitDepth === 16 ? ' is-active' : ''}`} disabled={running} onClick={() => setBitDepth(16)}>
                  16 位
                </button>
              </div>
            )}
            <div className="chips" style={{ marginTop: 8 }}>
              {LONG_EDGES.map((e) => (
                <button
                  key={e}
                  className={`chip${maxDimension === e ? ' is-active' : ''}`}
                  disabled={running}
                  onClick={() => setMaxDimension(e)}
                >
                  {e === 0 ? '原始尺寸' : `长边 ${e}`}
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="slider-label">DPI {dpi}</span>
              <input
                type="range"
                min={72}
                max={600}
                step={1}
                value={dpi}
                disabled={running}
                onChange={(e) => setDpi(Number(e.target.value))}
                style={{ flex: 1 }}
              />
            </div>
          </div>

          {running && (
            <div className="section">
              <div className="section-head">
                <span className="section-title">进度</span>
                <span className="spacer" />
                <span className="meta">
                  {Math.min(progress?.index ?? 0, files.length) + (progress?.status === 'running' ? 1 : 0)}/{files.length}
                </span>
              </div>
              <div className="open-progress-track">
                <div className="open-progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <p className="hint" style={{ marginBottom: 0 }}>
                {progress?.fileName ? `${progress.fileName} · ` : ''}
                {progress?.stage ?? ''}
              </p>
            </div>
          )}

          {results.length > 0 && !running && (
            <div className="section">
              <div className="section-head">
                <span className="section-title">结果</span>
                <span className="spacer" />
                <span className="meta">
                  成功 {okCount} · 失败 {failCount}
                </span>
              </div>
              <div className="batch-file-list">
                {results.map((r) => (
                  <div key={r.fileName} className={`batch-file-item${r.ok ? '' : ' is-error'}`}>
                    {r.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.fileName}</span>
                    {!r.ok && r.error && <span className="batch-err">{r.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          {running ? (
            <button className="btn" onClick={() => void cancel()}>
              <Square size={13} /> 取消
            </button>
          ) : (
            <button className="btn is-primary" disabled={!canRun} onClick={() => void start()}>
              <Play size={13} /> 开始批量（{files.length}）
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
