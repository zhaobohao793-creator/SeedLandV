/**
 * HTTP client for SeedLandV backend. Lives in main process so the bearer
 * token never leaves Electron's safeStorage.
 */
export interface HttpError extends Error {
  status: number
  body: unknown
}

function makeError(status: number, body: unknown, fallback: string): HttpError {
  const message =
    (body && typeof body === 'object' && 'detail' in body
      ? String((body as { detail: unknown }).detail)
      : null) ?? fallback
  const err = new Error(message) as HttpError
  err.status = status
  err.body = body
  return err
}

export class Http {
  constructor(
    private baseUrl: string,
    private getToken: () => string | null
  ) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, '')
  }

  async request<T = unknown>(
    path: string,
    init: RequestInit & { auth?: boolean } = {}
  ): Promise<T> {
    const headers = new Headers(init.headers)
    if (init.body && !headers.has('Content-Type') && typeof init.body === 'string') {
      headers.set('Content-Type', 'application/json')
    }
    if (init.auth !== false) {
      const tok = this.getToken()
      if (tok) headers.set('Authorization', `Bearer ${tok}`)
    }

    const res = await fetch(this.baseUrl + path, { ...init, headers })
    const text = await res.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }

    if (!res.ok) {
      throw makeError(res.status, body, `HTTP ${res.status} ${res.statusText}`)
    }
    return body as T
  }

  get<T>(path: string, opts?: { auth?: boolean }) {
    return this.request<T>(path, { method: 'GET', ...opts })
  }
  post<T>(path: string, json: unknown, opts?: { auth?: boolean }) {
    return this.request<T>(path, {
      method: 'POST',
      body: JSON.stringify(json),
      ...opts
    })
  }
  put<T>(path: string, json: unknown, opts?: { auth?: boolean }) {
    return this.request<T>(path, {
      method: 'PUT',
      body: JSON.stringify(json),
      ...opts
    })
  }
  delete<T>(path: string, opts?: { auth?: boolean }) {
    return this.request<T>(path, { method: 'DELETE', ...opts })
  }
}
