import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { TaskInfo, TaskKind, TaskProgress } from '../shared/api.ts'

const KEEP_FINISHED = 20

export interface TaskHandle {
  readonly id: string
  readonly signal: AbortSignal
  progress(progress: TaskProgress, detail?: string): void
  succeed(detail?: string): void
  fail(error: unknown): void
}

export class TaskCenter extends EventEmitter {
  private readonly tasks = new Map<string, TaskInfo>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly resources = new Map<string, string[]>()

  list(): TaskInfo[] {
    return [...this.tasks.values()].map((task) => ({ ...task }))
  }

  private put(task: TaskInfo): void {
    this.tasks.set(task.id, task)
    if (task.state !== 'running' && task.state !== 'queued') { this.controllers.delete(task.id); this.resources.delete(task.id) }
    this.prune()
    this.emit('task', { ...task })
  }

  private prune(): void {
    const finished = [...this.tasks.values()].filter((task) => task.state !== 'running' && task.state !== 'queued')
    for (const task of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.tasks.delete(task.id)
  }

  private patch(id: string, patch: Partial<TaskInfo>): void {
    const task = this.tasks.get(id)
    if (!task || (task.state !== 'running' && task.state !== 'queued')) return
    this.put({ ...task, ...patch })
  }

  busyFor(target: string): TaskInfo | undefined {
    const key = (value: string | null): string | null => process.platform === 'win32' ? value?.toLowerCase() ?? null : value
    return [...this.tasks.values()].find((task) => key(task.target) === key(target) && (task.state === 'running' || task.state === 'queued'))
  }

  busyForResource(resource: string): boolean {
    const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
    return [...this.resources.values()].some((values) => values.some((value) => key(value) === key(resource)))
  }

  start(kind: TaskKind, title: string, target: string | null = null, resources: string[] = []): TaskHandle {
    if (target && this.busyFor(target)) throw new Error('这个版本正在执行其他任务，等它结束再试')
    if (resources.some((resource) => this.busyForResource(resource))) throw new Error('这个游戏目录正在执行其他任务，等文件操作结束再试')
    const id = randomUUID()
    const controller = new AbortController()
    this.controllers.set(id, controller)
    this.resources.set(id, resources)
    this.put({ id, kind, title, target, state: 'running', progress: null, detail: null, error: null, startedAt: Date.now(), endedAt: null })
    return {
      id,
      signal: controller.signal,
      progress: (progress, detail) => { if (!controller.signal.aborted) this.patch(id, { progress, ...(detail !== undefined ? { detail } : {}) }) },
      succeed: (detail) => this.patch(id, { state: 'done', endedAt: Date.now(), ...(detail !== undefined ? { detail } : {}) }),
      fail: (error) => {
        const aborted = controller.signal.aborted
        this.patch(id, { state: aborted ? 'cancelled' : 'failed', endedAt: Date.now(), error: aborted ? null : error instanceof Error ? error.message : String(error) })
      }
    }
  }

  cancel(id: string): void {
    const controller = this.controllers.get(id)
    if (!controller) return
    controller.abort()
    // Keep the version locked until the worker has finished rollback/cleanup.
    this.patch(id, { detail: '正在取消，等待文件清理完成' })
  }

  detail(id: string, detail: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    this.put({ ...task, detail })
  }

  clearFinished(): void {
    for (const task of [...this.tasks.values()]) {
      if (task.state !== 'running' && task.state !== 'queued') this.tasks.delete(task.id)
    }
    this.emit('cleared')
  }
}
