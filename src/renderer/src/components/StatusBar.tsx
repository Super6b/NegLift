import { useEditor } from '../state/store'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function StatusBar() {
  const image = useEditor((s) => s.image)
  const zoom = useEditor((s) => s.zoom)
  const setZoom = useEditor((s) => s.setZoom)
  const frameInfo = useEditor((s) => s.frameInfo)

  return (
    <footer className="statusbar">
      {image ? (
        <>
          <span title={image.meta.filePath}>{image.meta.fileName}</span>
          <span className="sep" />
          <span>
            原始 {image.meta.width} × {image.meta.height}
          </span>
          <span className="sep" />
          <span title={image.fullSize ? '预览使用原始分辨率' : '图像超出内存上限，预览已降采样'}>
            预览 {image.previewWidth} × {image.previewHeight}
            {image.fullSize ? '（全尺寸）' : '（已降采样）'}
          </span>
          {frameInfo && (
            <>
              <span className="sep" />
              <span>
                输出 {frameInfo.width} × {frameInfo.height}
              </span>
            </>
          )}
          <span className="sep" />
          <span>{formatSize(image.meta.fileSize)}</span>
          {image.meta.camera && (
            <>
              <span className="sep" />
              <span>{image.meta.camera}</span>
            </>
          )}
          {image.meta.profileName && (
            <>
              <span className="sep" />
              <span
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
          {image.meta.iso ? (
            <>
              <span className="sep" />
              <span>ISO {image.meta.iso}</span>
            </>
          ) : null}
        </>
      ) : (
        <span>未打开图片</span>
      )}

      <span className="grow" />

      {image && (
        <>
          {frameInfo && (
            <>
              <span>{frameInfo.elapsed.toFixed(0)} ms</span>
              <span className="sep" />
            </>
          )}
          <button className="btn is-ghost is-icon" title="适应窗口 (Ctrl+0)" onClick={() => setZoom(1)}>
            <span className="zoom-btn">适应</span>
          </button>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
        </>
      )}
    </footer>
  )
}
