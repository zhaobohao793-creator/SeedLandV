/**
 * Backend task/tenant API. Translates between renderer's TaskRecord shape
 * and server's TaskOut, and auto-retries once on 401 (refresh).
 */
import type { SubmitTaskInput, TaskRecord, TaskStatus, AssetSource } from '@shared/types'
import type { Auth } from './auth'
import type { Http } from './http'
import { validateByMode } from '@shared/validate'

interface ServerTaskOut {
  server_id: string
  id: string | null
  localId: string
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

function fromServer(t: ServerTaskOut): TaskRecord {
  return {
    serverId: t.server_id,
    id: t.id ?? '',
    localId: t.localId,
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

export class ApiClient {
  constructor(
    private http: Http,
    private auth: Auth
  ) {}

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

  async submitTask(input: SubmitTaskInput): Promise<{ localId: string }> {
    validateByMode(input.mode, input.assets)

    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const assets = input.assets.map((a: AssetSource) => {
      if (a.mode === 'url') {
        return { kind: a.kind, mode: 'url' as const, url: a.url }
      }
      // Phase 4 will accept asset_token from a prior /v1/assets upload.
      throw new Error('本地文件上传将在 Phase 4 接通；当前只接受 URL 素材')
    })

    await this.withRefresh(() =>
      this.http.post<{ server_id: string; localId: string; status: TaskStatus }>(
        '/v1/tasks',
        {
          localId,
          mode: input.mode,
          prompt: input.prompt,
          assets,
          params: input.params
        }
      )
    )
    return { localId }
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
