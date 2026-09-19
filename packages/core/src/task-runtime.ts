import type { Database } from './database.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRunnerOptions, TaskOverrides } from './task-runner.js'
import { TaskScheduler } from './task-scheduler.js'
import type { TaskSchedulerOptions } from './task-scheduler.js'
import type { ProviderConfig } from './provider-config.js'
import type { Task, CreateTaskInput, UpdateTaskInput, TaskListFilters } from './task-store.js'
import type { ScheduledTask, CreateScheduledTaskInput, UpdateScheduledTaskInput } from './scheduled-task-store.js'

export interface TaskRuntimeTaskBoundary {
  create(input: CreateTaskInput): Task
  getById(id: string): Task | null
  list(filters?: TaskListFilters): Task[]
  update(id: string, updates: UpdateTaskInput): Task | null
  start(task: Task, provider: ProviderConfig, overrides?: TaskOverrides, parentSessionId?: string | null): Promise<string>
  resume(taskId: string, message: string): Promise<boolean>
  abort(taskId: string, reason?: string): void
  isRunning(taskId: string): boolean
  getRunningIds(): string[]
  isPaused(taskId: string): boolean
  getPausedIds(): string[]
  cleanupStalePaused(): number
  recover(
    getProvider: (name: string) => ProviderConfig | null,
    defaultProvider: ProviderConfig,
  ): Promise<{ resumed: number; failed: number }>
}

export interface TaskRuntimeScheduleBoundary {
  create(input: CreateScheduledTaskInput): ScheduledTask
  getById(id: string): ScheduledTask | null
  list(): ScheduledTask[]
  listEnabled(): ScheduledTask[]
  update(id: string, updates: UpdateScheduledTaskInput): ScheduledTask | null
  delete(id: string): boolean
  register(scheduledTask: ScheduledTask): void
  unregister(id: string): void
  triggerNow(scheduledTaskId: string): Promise<string | null>
  getActiveSchedules(): Array<{ id: string; nextRunTime: Date }>
  start(): void
  stop(): void
  restart(): void
}

export interface TaskRuntimeBoundary {
  tasks: TaskRuntimeTaskBoundary
  schedules: TaskRuntimeScheduleBoundary
  dispose(): void
}

export interface TaskRuntimeOptions {
  db: Database
  runner: Omit<TaskRunnerOptions, 'db'>
  scheduler: Omit<TaskSchedulerOptions, 'db' | 'taskStore' | 'taskRunner'>
}

class PiTaskRuntime implements TaskRuntimeBoundary {
  readonly tasks: TaskRuntimeTaskBoundary
  readonly schedules: TaskRuntimeScheduleBoundary

  private readonly runner: TaskRunner
  private readonly scheduler: TaskScheduler

  constructor(options: TaskRuntimeOptions) {
    this.runner = new TaskRunner({
      ...options.runner,
      db: options.db,
    })

    this.scheduler = new TaskScheduler({
      ...options.scheduler,
      db: options.db,
      taskStore: this.runner.getStore(),
      taskRunner: this.runner,
    })

    const taskStore = this.runner.getStore()
    const scheduledTaskStore = this.scheduler.getStore()

    this.tasks = {
      create: (input) => taskStore.create(input),
      getById: (id) => taskStore.getById(id),
      list: (filters) => taskStore.list(filters),
      update: (id, updates) => taskStore.update(id, updates),
      start: (task, provider, overrides, parentSessionId) => this.runner.startTask(task, provider, overrides, parentSessionId),
      resume: (taskId, message) => this.runner.resumeTask(taskId, message),
      abort: (taskId, reason) => this.runner.abortTask(taskId, reason),
      isRunning: (taskId) => this.runner.isRunning(taskId),
      getRunningIds: () => this.runner.getRunningTaskIds(),
      isPaused: (taskId) => this.runner.isPaused(taskId),
      getPausedIds: () => this.runner.getPausedTaskIds(),
      cleanupStalePaused: () => this.runner.cleanupStalePausedTasks(),
      recover: (getProvider, defaultProvider) => this.runner.recoverTasks(getProvider, defaultProvider),
    }

    this.schedules = {
      create: (input) => scheduledTaskStore.create(input),
      getById: (id) => scheduledTaskStore.getById(id),
      list: () => scheduledTaskStore.list(),
      listEnabled: () => scheduledTaskStore.listEnabled(),
      update: (id, updates) => scheduledTaskStore.update(id, updates),
      delete: (id) => scheduledTaskStore.delete(id),
      register: (scheduledTask) => this.scheduler.registerSchedule(scheduledTask),
      unregister: (id) => this.scheduler.unregisterSchedule(id),
      triggerNow: (scheduledTaskId) => this.scheduler.triggerNow(scheduledTaskId),
      getActiveSchedules: () => this.scheduler.getActiveSchedules(),
      start: () => this.scheduler.start(),
      stop: () => this.scheduler.stop(),
      restart: () => this.scheduler.restart(),
    }
  }

  dispose(): void {
    this.scheduler.dispose()
    this.runner.dispose()
  }
}

export function createTaskRuntime(options: TaskRuntimeOptions): TaskRuntimeBoundary {
  return new PiTaskRuntime(options)
}
