import { useEditor } from '../state/store'

/** 面板通用：读取参数 + 提交/交互包装 */
export function useControls() {
  const params = useEditor((s) => s.params)
  const update = useEditor((s) => s.update)
  const begin = useEditor((s) => s.beginInteract)
  const end = useEditor((s) => s.endInteract)
  return { params, update, begin, end }
}
