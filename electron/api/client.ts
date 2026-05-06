/**
 * Backend task/tenant API. Translates between renderer's TaskRecord shape
 * and server's TaskOut, and auto-retries once on 401 (refresh).
 */
import type {
  AssetSource,
  CreateEmployeeInput,
  EmployeeRecord,
  ListOrdersFilters,
  OrderRecord,
  SubmitTaskInput,
  TaskRecord,
  TaskStatus,
  UpdateEmployeeInput
} from '@shared/types'
import type { Auth } from './auth'
import type { Http } from './http'
import { AssetUploader } from './upload'
import { validateByMode } from '@shared/validate'

interface ServerTaskOut {
  server_id: string
  id: string | null
  localId: string
  orderId: string
  orderSeq: number
  mode: TaskRecord['mode']
  prompt: string
  params: TaskRecord['params']
  assetsPreview: TaskRecord['assetsPreview']
  status: TaskStatus
  videoUrl?: string | null
  lastFrameUrl?: string | null
  error?: { message: string; raw?: string | null; code?: string | null } | null
  createdAt: number
  updatedAt: number
  usage?: TaskRecord['usage'] | null
}

interface ServerEmployeeOut {
  id: string
  tenant_id: string
  employee_id: string
  display_name: string | null
  email: string | null
  is_admin: boolean
  is_active: boolean
}

function fromServer(t: ServerTaskOut): TaskRecord {
  return {
    serverId: t.server_id,
    id: t.id ?? '',
    localId: t.localId,
    orderId: t.orderId,
    orderSeq: t.orderSeq,
    mode: t.mode,
    prompt: t.prompt,
    params: t.params,
    assetsPreview: t.assetsPreview,
    status: t.status,
    videoUrl: t.videoUrl ?? undefined,
    lastFrameUrl: t.lastFrameUrl ?? undefined,
    error: t.error
      ? { message: t.error.message, raw: t.error.raw ?? undefined }
      : undefined,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    usage: t.usage ?? undefined
  }
}

function employeeFromServer(e: ServerEmployeeOut): EmployeeRecord {
  return {
    id: e.id,
    tenantId: e.tenant_id,
    employeeId: e.employee_id,
    displayName: e.display_name,
    email: e.email,
    isAdmin: e.is_admin,
    isActive: e.is_active
  }
}

export class ApiClient {
  private uploader: AssetUploader

  constructor(
    private http: Http,
    private auth: Auth
  ) {
    this.uploader = new AssetUploader(http)
  }

  /** Wraps a request with one auto-refresh on 401. */
  private async withRefresh<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if ((err as { status?: number })?.status !== 401) throw err
      const ok = await this.auth.tryRefresh()
      if (!ok) throw err
      return await fn()
    }
  }

  async listTasks(): Promise<TaskRecord[]> {
    const out = await this.withRefresh(() => this.http.get<ServerTaskOut[]>('/v1/tasks'))
    return out.map(fromServer)
  }

  async submitTask(
    input: SubmitTaskInput
  ): Promise<{ localId: string; orderId: string; orderSeq: number }> {
    validateByMode(input.mode, input.assets)
    const orderId = input.orderId.trim()
    if (!orderId) throw new Error('订单号不能为空')

    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Resolve any local-file assets up to TOS first; server only sees `url`/`upload`.
    const assets = await Promise.all(
      input.assets.map(async (a: AssetSource) => {
        if (a.mode === 'url') {
          return { kind: a.kind, mode: 'url' as const, url: a.url }
        }
        // mode === 'local' — upload now, hand back the opaque token.
        const out = await this.withRefresh(() => this.uploader.uploadFile(a.path, a.kind))
        return { kind: a.kind, mode: 'upload' as const, asset_token: out.asset_token }
      })
    )

    const res = await this.withRefresh(() =>
      this.http.post<{
        server_id: string
        localId: string
        orderId: string
        orderSeq: number
        status: TaskStatus
      }>('/v1/tasks', {
        localId,
        orderId,
        mode: input.mode,
        prompt: input.prompt,
        assets,
        params: input.params
      })
    )
    return { localId, orderId: res.orderId, orderSeq: res.orderSeq }
  }

  async listOrders(filters: ListOrdersFilters = {}): Promise<OrderRecord[]> {
    const qs = new URLSearchParams()
    if (filters.employeeId) qs.set('employee_id', filters.employeeId)
    if (filters.orderId) qs.set('order_id', filters.orderId)
    if (filters.status) qs.set('status', filters.status)
    if (filters.from) qs.set('from', filters.from)
    if (filters.to) qs.set('to', filters.to)
    if (filters.limit !== undefined) qs.set('limit', String(filters.limit))
    if (filters.offset !== undefined) qs.set('offset', String(filters.offset))
    const path = qs.toString() ? `/v1/admin/orders?${qs}` : '/v1/admin/orders'
    type ServerOrderOut = ServerTaskOut & {
      employeeId: string | null
      employeeDisplayName: string | null
    }
    const out = await this.withRefresh(() => this.http.get<ServerOrderOut[]>(path))
    return out.map((o) => ({
      ...fromServer(o),
      employeeId: o.employeeId,
      employeeDisplayName: o.employeeDisplayName
    }))
  }

  async listEmployees(): Promise<EmployeeRecord[]> {
    const out = await this.withRefresh(() =>
      this.http.get<ServerEmployeeOut[]>('/v1/admin/employees')
    )
    return out.map(employeeFromServer)
  }

  async createEmployee(input: CreateEmployeeInput): Promise<EmployeeRecord> {
    const out = await this.withRefresh(() =>
      this.http.post<ServerEmployeeOut>('/v1/admin/employees', {
        employee_id: input.employeeId,
        password: input.password,
        display_name: input.displayName,
        email: input.email,
        is_admin: input.isAdmin ?? false
      })
    )
    return employeeFromServer(out)
  }

  async updateEmployee(
    userId: string,
    patch: UpdateEmployeeInput
  ): Promise<EmployeeRecord> {
    const out = await this.withRefresh(() =>
      this.http.request<ServerEmployeeOut>(`/v1/admin/employees/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          display_name: patch.displayName,
          password: patch.password,
          is_admin: patch.isAdmin,
          is_active: patch.isActive
        })
      })
    )
    return employeeFromServer(out)
  }

  async deactivateEmployee(userId: string): Promise<EmployeeRecord> {
    const out = await this.withRefresh(() =>
      this.http.delete<ServerEmployeeOut>(`/v1/admin/employees/${userId}`)
    )
    return employeeFromServer(out)
  }

  async cancelTask(serverId: string): Promise<void> {
    await this.withRefresh(() => this.http.delete(`/v1/tasks/${serverId}`))
  }

  async setArkKey(arkKey: string): Promise<void> {
    await this.withRefresh(() =>
      this.http.put('/v1/tenants/me/ark-key', { api_key: arkKey })
    )
  }

  async getArkKeyStatus(): Promise<{ hasKey: boolean }> {
    return await this.withRefresh(() =>
      this.http.get<{ hasKey: boolean }>('/v1/tenants/me/ark-key')
    )
  }
}
