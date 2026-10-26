export type Window = { utilization: number | null; resets_at: string | null }
export type Usage = {
  fetchedAt: number
  five: Window
  week: Window
  backoffUntil: number
} | null

export type Todo = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

export type ChangedFile = { path: string; code: string }

export type Workspace = {
  folder: string
  isRepo: boolean
  branch: string
  changed: number
  ahead: number
  behind: number
  files: ChangedFile[]
} | null

export type Context = { percent: number; tokens: number; window: number } | null

export type Turn = {
  startedAt: number | null
  now: number
  lastSeconds: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-pane': { usage: Shaped<Usage>; todos: Shaped<Todo[]>; workspace: Shaped<Workspace>; context: Shaped<Context>; turn: Shaped<Turn>; gitExpanded: Shaped<boolean> }
  }
}
