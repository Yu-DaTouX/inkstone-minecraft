export interface PerformanceReport {
  totalMemoryMb: number
  freeMemoryMb: number
  currentMemoryMb: number
  recommendedMemoryMb: number
  canRestore: boolean
  sharedDirectory: boolean
  note: string
  automaticJvmArgs: string[]
  customJvmArgs: string
  jvmDescription: string
  jvmIssues: Array<{ level: 'warn' | 'block'; message: string }>
  memoryControlledByJvm: boolean
}

export interface PerformanceResult {
  message: string
  report: PerformanceReport
}
