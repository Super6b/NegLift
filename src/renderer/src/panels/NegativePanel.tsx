import { useEffect, useState } from 'react'
import { Ban, ChevronDown, Pipette, RefreshCw, Sparkles } from 'lucide-react'
import { useControls } from '../hooks/useControls'
import { Slider } from '../components/Slider'
import { useEditor } from '../state/store'
import { DEFAULT_NEGATIVE } from './constants'

const BLACK_LABELS = ['黑场 R', '黑场 G', '黑场 B']
const WHITE_LABELS = ['白场 R', '白场 G', '白场 B']

export function NegativePanel() {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const { params, update, begin, end } = useControls()
  const eyedropper = useEditor((s) => s.eyedropper)
  const setEyedropper = useEditor((s) => s.setEyedropper)
  const detect = useEditor((s) => s.detect)
  const tool = useEditor((s) => s.tool)
  const setTool = useEditor((s) => s.setTool)
  const clearExcludeAreas = useEditor((s) => s.clearExcludeAreas)
  const validArea = params.transform.validArea
  const excludeAreas = params.transform.excludeAreas
  const n = params.negative
  const areaPercent = validArea ? validArea.w * validArea.h * 100 : 100
  const resultText = n.mode === 'align'
    ? '需要检查：未检测到片基，已改用通道对齐；请确认肤色和中性色是否自然。'
    : '自动结果已就绪：已检测片基并完成初始去色罩。'

  useEffect(() => {
    if (n.mode === 'align') setAdvancedOpen(true)
  }, [n.mode])

  return (
    <>
      <div className="section">
        <div className="section-head">
          <span className="section-title">去色罩</span>
          <span className="spacer" />
          <label className="switch">
            <input
              type="checkbox"
              checked={n.enabled}
              onChange={(e) => update((d) => void (d.negative.enabled = e.target.checked))}
            />
            <span className="switch-track" />
          </label>
        </div>
        <div className="row">
          <button className="btn" onClick={() => void detect()}>
            <Sparkles size={14} /> 自动检测
          </button>
          <button
            className={`btn${eyedropper ? ' is-on' : ''}`}
            onClick={() => setEyedropper(!eyedropper)}
            title="在预览画面中点选未曝光的胶片边缘"
          >
            <Pipette size={14} /> 吸管
          </button>
        </div>
        <p className={`workflow-result${n.mode === 'align' ? ' is-review' : ''}`} role="status" aria-live="polite">
          <strong>{resultText}</strong>
          <span>统计区域 {areaPercent.toFixed(1)}%{excludeAreas.length ? ` · 已排除 ${excludeAreas.length} 处特殊区域` : ''}</span>
        </p>
        <p className="hint">
          【步骤 2 / 3】在有效区域上还原标准正片色：自动检测按「裁切 → 有效区域 → 排除区」统计片基/黑场/白场。
          颜色正常后再进「风格调色」；偏色时可切换校正方式或用吸管取样片基。
          {validArea
            ? ` 有效区域：${(validArea.w * 100).toFixed(1)}% × ${(validArea.h * 100).toFixed(1)}%。`
            : ' 有效区域为整幅画面。'}
        </p>
      </div>

      <section className="advanced-section">
        <button
          className="advanced-toggle"
          type="button"
          aria-expanded={advancedOpen}
          aria-controls="negative-advanced"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span>
            <strong>高级微调</strong>
            <small>自动结果偏色、包含齿孔或需要保留更多后期余量时使用</small>
          </span>
          <ChevronDown className={advancedOpen ? 'is-open' : ''} size={16} aria-hidden />
        </button>

        {advancedOpen && <div id="negative-advanced" className="advanced-content">
          <div className="section">
            <div className="section-head">
              <span className="section-title">特殊区域排除</span>
              <span className="spacer" />
              <button
                className="btn is-ghost is-icon"
                title="清空排除区域"
                disabled={excludeAreas.length === 0}
                onClick={clearExcludeAreas}
              >
                <RefreshCw size={13} />
              </button>
            </div>
            <div className="row">
              <button
                className={`btn${tool === 'exclude' ? ' is-on' : ''}`}
                onClick={() => {
                  setEyedropper(false)
                  setTool(tool === 'exclude' ? 'adjust' : 'exclude')
                }}
              >
                <Ban size={14} /> {tool === 'exclude' ? '退出框选' : '框选排除区域'}
              </button>
              {excludeAreas.length > 0 && <span className="meta">已标记 {excludeAreas.length} 处</span>}
            </div>
            <p className="hint">齿孔、漏光边等纯黑区域会污染统计；标记后只从去色罩统计中剔除。</p>
          </div>

          <div className="section">
            <div className="section-head"><span className="section-title">校正方式</span></div>
            <div className="chips"><button className="chip is-active" disabled>通道对齐</button></div>
            <p className="hint">统一使用通道对齐；片基反相模式已停用（多数翻拍样片上效果更差）。</p>
          </div>

          <div className="section">
        <div className="section-head">
          <span className="section-title">通道对齐</span>
          <span className="spacer" />
          <button
            className="btn is-ghost is-icon"
            title="重置通道对齐"
            onClick={() =>
              update((d) => {
                d.negative.alignBlack = [0, 0, 0]
                d.negative.alignWhite = [1, 1, 1]
              })
            }
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="row">
          <button className="btn" onClick={() => void detect()}>
            <Sparkles size={14} /> 自动对齐三通道
          </button>
        </div>
        {([0, 1, 2] as const).map((i) => (
          <Slider
            key={`b${i}`}
            label={BLACK_LABELS[i]}
            value={n.alignBlack[i]}
            min={0}
            max={0.5}
            step={0.001}
            precision={3}
            resetValue={0}
            onInteractStart={begin}
            onInteractEnd={end}
            onChange={(v, c) =>
              update((d) => {
                d.negative.alignBlack[i] = v
              }, c)
            }
          />
        ))}
        {([0, 1, 2] as const).map((i) => (
          <Slider
            key={`w${i}`}
            label={WHITE_LABELS[i]}
            value={n.alignWhite[i]}
            min={0.05}
            max={1}
              step={0.001}
              precision={3}
              resetValue={1}
              onInteractStart={begin}
              onInteractEnd={end}
              onChange={(v, c) =>
                update((d) => {
                  d.negative.alignWhite[i] = v
                }, c)
              }
            />
          ))}
          <p className="hint">
            黑场 / 白场取自有效区域内的低分位与高分位。若反色后整体偏色，可微调对应
            通道的黑场或白场：黑场调低或白场调高都会让该通道变亮。
          </p>
          <Slider
            label="两端保留（后期余量）"
            value={(n.alignHeadroom ?? 0) * 100}
            min={0}
            max={25}
            step={0.5}
            precision={1}
            suffix="%"
            resetValue={5}
            onInteractStart={begin}
            onInteractEnd={end}
            onChange={(v, c) =>
              update((d) => {
                d.negative.alignHeadroom = v / 100
              }, c)
            }
          />
          <p className="hint">
            在显示编码（直方图）域映射到 [保留, 1−保留]，暗部与亮部较均匀回缩，
            便于曲线/分级再往两端拉。默认 5%。
          </p>
          </div>

          <div className="section">
        <div className="section-head">
          <span className="section-title">反相</span>
          <span className="spacer" />
          <button
            className="btn is-ghost is-icon"
            title="重置反相参数"
            onClick={() =>
              update((d) => {
                d.negative.strength = DEFAULT_NEGATIVE.strength
                d.negative.tRef = DEFAULT_NEGATIVE.tRef
                d.negative.highlightRolloff = DEFAULT_NEGATIVE.highlightRolloff
              })
            }
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <Slider
          label="反相强度"
          value={n.strength}
          min={0.15}
          max={3}
          step={0.01}
          precision={2}
          resetValue={DEFAULT_NEGATIVE.strength}
          onInteractStart={begin}
          onInteractEnd={end}
          onChange={(v, c) =>
            update((d) => {
              d.negative.strength = v
            }, c)
          }
        />
        <Slider
          label="白场参考（最密处）"
          value={n.tRef}
          min={0.004}
          max={0.4}
          step={0.001}
          precision={3}
          resetValue={DEFAULT_NEGATIVE.tRef}
          onInteractStart={begin}
          onInteractEnd={end}
          onChange={(v, c) =>
            update((d) => {
              d.negative.tRef = v
            }, c)
          }
        />
        <Slider
          label="高光滚降"
          value={n.highlightRolloff}
          min={0}
          max={1}
          step={0.01}
          precision={2}
          resetValue={DEFAULT_NEGATIVE.highlightRolloff}
          onInteractStart={begin}
          onInteractEnd={end}
          onChange={(v, c) =>
            update((d) => {
              d.negative.highlightRolloff = v
            }, c)
          }
        />
          </div>
        </div>}
      </section>
    </>
  )
}
