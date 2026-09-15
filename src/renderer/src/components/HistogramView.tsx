import { useEffect, useRef } from 'react'
import type { Histogram } from '@shared/types'

interface Props {
  data: Histogram | null
}

/** 直方图：三通道以加色方式叠加，并绘制亮度轮廓 */
export function HistogramView({ data }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const cssW = canvas.clientWidth || 280
    const cssH = canvas.clientHeight || 78
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    ctx.strokeStyle = 'rgba(128,128,128,0.22)'
    ctx.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      const x = (cssW * i) / 4
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, cssH)
      ctx.stroke()
    }

    if (!data) return

    let peak = 1
    for (const arr of [data.r, data.g, data.b]) {
      for (let i = 1; i < 255; i++) if (arr[i] > peak) peak = arr[i]
    }

    const draw = (arr: number[], color: string, fill: boolean): void => {
      ctx.beginPath()
      ctx.moveTo(0, cssH)
      for (let i = 0; i < 256; i++) {
        const v = Math.min(1, arr[i] / peak)
        // 平方根压缩，让少量高像素的尾部依然可见
        const y = cssH - Math.sqrt(v) * (cssH - 2)
        ctx.lineTo((i / 255) * cssW, y)
      }
      ctx.lineTo(cssW, cssH)
      ctx.closePath()
      ctx.fillStyle = color
      if (fill) ctx.fill()
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.stroke()
    }

    ctx.globalCompositeOperation = 'lighter'
    draw(data.r, 'rgba(230,80,80,0.5)', true)
    draw(data.g, 'rgba(80,210,110,0.5)', true)
    draw(data.b, 'rgba(80,140,240,0.5)', true)
    ctx.globalCompositeOperation = 'source-over'
    draw(data.l, 'rgba(220,220,220,0.55)', false)
  }, [data])

  return <canvas className="histogram" ref={ref} />
}
