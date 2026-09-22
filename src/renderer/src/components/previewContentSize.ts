export function previewContentSize(el: HTMLElement): { w: number; h: number } {
  const style = getComputedStyle(el)
  return {
    w: Math.max(0, el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
    h: Math.max(0, el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))
  }
}
