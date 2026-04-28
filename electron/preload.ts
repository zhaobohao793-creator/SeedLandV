import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { SubmitTaskInput, TaskRecord, AssetKind } from './shared/types'
import type { AuthState } from './api/auth'

const api = {
  // Auth — main process holds tokens via safeStorage; renderer only sees state.
  getAuthState: (): Promise<AuthState> => ipcRenderer.invoke('auth:state'),
  login: (email: string, password: string) =>
    ipcRenderer.invoke('auth:login', email, password) as Promise<AuthState | { error: string }>,
  register: (email: string, password: string, tenantName?: string) =>
    ipcRenderer.invoke('auth:register', email, password, tenantName) as Promise<
      AuthState | { error: string }
    >,
  logout: () => ipcRenderer.invoke('auth:logout') as Promise<void>,

  // Tenant Ark Key
  setArkKey: (key: string) =>
    ipcRenderer.invoke('tenant:setArkKey', key) as Promise<{ ok: true } | { error: string }>,
  getArkKeyStatus: () =>
    ipcRenderer.invoke('tenant:arkKeyStatus') as Promise<{ hasKey: boolean }>,

  // Existing surface — kept intact for renderer compatibility.
  getApiStatus: () => ipcRenderer.invoke('api:status'),
  submitTask: (input: SubmitTaskInput) => ipcRenderer.invoke('api:submit', input),
  cancelTask: (serverId: string) => ipcRenderer.invoke('api:cancel', serverId),
  removeTask: (serverId: string) => ipcRenderer.invoke('api:removeTask', serverId),
  listTasks: () => ipcRenderer.invoke('api:listTasks'),
  clearTasks: () => ipcRenderer.invoke('api:clearTasks'),
  pickFile: (kind: AssetKind, allowedExts?: string[]) =>
    ipcRenderer.invoke('api:pickFile', kind, allowedExts),
  getDroppedPath: (file: File) => webUtils.getPathForFile(file),
  downloadVideo: (url: string, suggestedName: string) =>
    ipcRenderer.invoke('api:downloadVideo', url, suggestedName),
  openExternal: (url: string) => ipcRenderer.invoke('api:openExternal', url),
  onTaskUpdate: (cb: (task: TaskRecord) => void) => {
    const listener = (_: unknown, task: TaskRecord) => cb(task)
    ipcRenderer.on('task:update', listener)
    return () => ipcRenderer.removeListener('task:update', listener)
  }
}

contextBridge.exposeInMainWorld('seedland', api)
