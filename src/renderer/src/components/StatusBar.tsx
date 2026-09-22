import { Maximize2, Minus, Plus } from 'lucide-react'
import { useEditor } from '../state/store'

export function StatusBar() {
  const image = useEditor((s) => s.image)
  const zoom = useEditor((s) => s.zoom)
  const setZoom = useEditor((s) => s.setZoom)
  const frameInfo = useEditor((s) => s.frameInfo)

  return (
    <footer className="statusbar">
      {image ? (
        <>
          <span className="status-file" title={image.meta.filePath}>{image.meta.fileName}</span>
          <span className="sep" />
          <span className="status-dim" title={`原始 ${image.meta.width} × ${image.meta.height} · 预览 ${image.previewWidth} × ${image.previewHeight}${image.fullSize ? '' : '（已降采样）'}`}>
            {frameInfo ? `${frameInfo.width} × ${frameInfo.height}` : `${image.meta.width} × ${image.meta.height}`}
          </span>
          {image.meta.profileName && (
            <>
              <span className="sep" />
              <span className="status-profile"
                title={
                  image.meta.profileSource === 'user'
                    ? '用户导入的机型优化配置'
                    : '内置机型优化配置'
                }
              >
                配置：{image.meta.profileName}
              </span>
            </>
          )}
        </>
      ) : null}

      <span className="grow" />

      {image && (
        <div className="zoom-controls" role="group" aria-label="预览缩放">
          <button aria-label="缩小" title="缩小" disabled={zoom <= 0.05} onClick={() => setZoom(zoom / 1.25)}><Minus size={14} /></button>
          <output className="zoom-value" title="相对适应窗口的缩放比例">{Math.round(zoom * 100)}%</output>
          <button aria-label="放大" title="放大" disabled={zoom >= 8} onClick={() => setZoom(zoom * 1.25)}><Plus size={14} /></button>
          <button className={zoom === 1 ? 'is-fit' : ''} aria-label="适应窗口" title="适应窗口 (Ctrl+0)" onClick={() => setZoom(1)}><Maximize2 size={14} /></button>
        </div>
      )}
    </footer>
  )
}
