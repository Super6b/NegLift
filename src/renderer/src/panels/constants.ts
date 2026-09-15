import { createDefaultDenoise, createDefaultGrading, createDefaultParams } from '@shared/defaults'

/** 面板重置按钮的参考值（只读使用，切勿修改这些对象） */
export const DEFAULT_PARAMS = createDefaultParams()
export const DEFAULT_NEGATIVE = DEFAULT_PARAMS.negative
export const DEFAULT_BASIC = DEFAULT_PARAMS.basic
export const DEFAULT_GRADING = createDefaultGrading()
export const DEFAULT_DENOISE = createDefaultDenoise()
export const DEFAULT_TRANSFORM = DEFAULT_PARAMS.transform
