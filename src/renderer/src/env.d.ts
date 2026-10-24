import type { CraftApi } from '../../shared/api.ts'

declare global {
  interface Window {
    craft: CraftApi
  }
}

export {}
