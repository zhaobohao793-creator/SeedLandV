import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AssetKind,
  AuthState,
  BootstrapStatus,
  CreateEmployeeInput,
  EmployeeRecord,
  ListOrdersFilters,
  OrderRecord,
  SubmitTaskInput,
  TaskRecord,
  UpdateEmployeeInput
} from './shared/types'

const api = {
  // Auth — main process holds tokens via safeStorage; renderer only sees state.
  getAuthState: (): Promise<AuthState> => ipcRenderer.invoke('auth:state'),
  getBootstrapStatus: (): Promise<BootstrapStatus> =>
    ipcRenderer.invoke('auth:bootstrapStatus'),
  login: (employeeId: string, password: string) =>
    ipcRenderer.invoke('auth:login', employeeId, password) as Promise<
      AuthState | { error: string }
    >,
  bootstrap: (
    workshopName: string,
    employeeId: string,
    password: string,
    displayName?: string
  ) =>
    ipcRenderer.invoke(
      'auth:bootstrap',
      workshopName,
      employeeId,
      password,
      displayName
    ) as Promise<AuthState | { error: string }>,
  logout: () => ipcRenderer.invoke('auth:logout') as Promise<void>,

  // Admin — employee CRUD (server enforces is_admin)
  listEmployees: () =>
    ipcRenderer.invoke('admin:listEmployees') as Promise<
      EmployeeRecord[] | { error: string }
    >,
  createEmployee: (input: CreateEmployeeInput) =>
    ipcRenderer.invoke('admin:createEmployee', input) as Promise<
      EmployeeRecord | { error: string }
    >,
  updateEmployee: (userId: string, patch: UpdateEmployeeInput) =>
    ipcRenderer.invoke('admin:updateEmployee', userId, patch) as Promise<
      EmployeeRecord | { error: string }
    >,
  deactivateEmployee: (userId: string) =>
    ipcRenderer.invoke('admin:deactivateEmployee', userId) as Promise<
      EmployeeRecord | { error: string }
    >,
  listOrders: (filters?: ListOrdersFilters) =>
    ipcRenderer.invoke('admin:listOrders', filters) as Promise<
      OrderRecord[] | { error: string }
    >,

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
