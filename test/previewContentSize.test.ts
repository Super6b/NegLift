import { strict as assert } from 'node:assert'
import { previewContentSize } from '../src/renderer/src/components/previewContentSize'

Object.defineProperty(globalThis, 'getComputedStyle', {
  value: () => ({ paddingLeft: '18px', paddingRight: '18px', paddingTop: '18px', paddingBottom: '18px' })
})

assert.deepEqual(previewContentSize({ clientWidth: 688, clientHeight: 558 } as HTMLElement), { w: 652, h: 522 })
assert.deepEqual(previewContentSize({ clientWidth: 20, clientHeight: 20 } as HTMLElement), { w: 0, h: 0 })
