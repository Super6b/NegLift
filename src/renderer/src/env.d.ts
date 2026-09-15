/// <reference types="vite/client" />

import type { NegLiftApi } from '@shared/types'

declare global {
  interface Window {
    negLift: NegLiftApi
  }
}

export {}
