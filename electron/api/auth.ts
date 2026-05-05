/**
 * Token persistence + login/refresh.
 *
 * Workshop-delivery model: employee_id replaces email as login identity, and
 * the public "register" endpoint is gone — the first admin is created via
 * /v1/auth/bootstrap on a fresh DB; all subsequent staff are created by an
 * admin through the EmployeeManagement UI.
 *
 * Tokens live in `app.getPath('userData')/auth.bin` encrypted with
 * Electron's `safeStorage` (Keychain on macOS, DPAPI on Windows). They never
 * touch the renderer process — only `getAuthState()` (boolean + identity)
 * is exposed.
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Http } from './http'
import type { AuthState, BootstrapStatus } from '@shared/types'

export type { AuthState }

interface StoredTokens {
  access: string
  refresh: string
  employeeId: string
  displayName: string | null
  isAdmin: boolean
  tenantId: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

interface UserOut {
  id: string
  tenant_id: string
  employee_id: string
  display_name: string | null
  email: string | null
  is_admin: boolean
  is_active: boolean
}

export class Auth {
  private tokens: StoredTokens | null = null

  constructor(private http: Http) {}

  private storePath(): string {
    return path.join(app.getPath('userData'), 'auth.bin')
  }

  /** Load persisted tokens from disk on startup. */
  bootstrap(): AuthState {
    try {
      const p = this.storePath()
      if (!fs.existsSync(p)) return { loggedIn: false }
      const enc = fs.readFileSync(p)
      if (!safeStorage.isEncryptionAvailable()) {
        return { loggedIn: false }
      }
      const json = safeStorage.decryptString(enc)
      this.tokens = JSON.parse(json)
      return this.state()
    } catch {
      this.tokens = null
      return { loggedIn: false }
    }
  }

  private persist(): void {
    if (!this.tokens) {
      try {
        fs.unlinkSync(this.storePath())
      } catch {
        /* ignore */
      }
      return
    }
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[auth] safeStorage not available; skipping persist')
      return
    }
    const enc = safeStorage.encryptString(JSON.stringify(this.tokens))
    fs.mkdirSync(path.dirname(this.storePath()), { recursive: true })
    fs.writeFileSync(this.storePath(), enc)
  }

  getToken(): string | null {
    return this.tokens?.access ?? null
  }

  state(): AuthState {
    if (!this.tokens) return { loggedIn: false }
    return {
      loggedIn: true,
      employeeId: this.tokens.employeeId,
      displayName: this.tokens.displayName ?? undefined,
      isAdmin: this.tokens.isAdmin,
      tenantId: this.tokens.tenantId
    }
  }

  /** Whether the system has any tenant — drives login vs bootstrap form. */
  async getBootstrapStatus(): Promise<BootstrapStatus> {
    const res = await this.http.request<{ initialized: boolean }>(
      '/v1/auth/bootstrap',
      { method: 'GET', auth: false }
    )
    return { initialized: res.initialized }
  }

  async bootstrapInitial(
    workshopName: string,
    employeeId: string,
    password: string,
    displayName?: string
  ): Promise<AuthState> {
    const res = await this.http.post<TokenResponse>(
      '/v1/auth/bootstrap',
      {
        workshop_name: workshopName,
        employee_id: employeeId,
        password,
        display_name: displayName
      },
      { auth: false }
    )
    return this.acceptTokens(res)
  }

  async login(employeeId: string, password: string): Promise<AuthState> {
    const res = await this.http.post<TokenResponse>(
      '/v1/auth/login',
      { employee_id: employeeId, password },
      { auth: false }
    )
    return this.acceptTokens(res)
  }

  async logout(): Promise<void> {
    this.tokens = null
    this.persist()
  }

  /** Try to renew the access token using the refresh token. */
  async tryRefresh(): Promise<boolean> {
    if (!this.tokens?.refresh) return false
    try {
      const res = await this.http.post<TokenResponse>(
        '/v1/auth/refresh',
        { refresh_token: this.tokens.refresh },
        { auth: false }
      )
      this.tokens = {
        ...this.tokens,
        access: res.access_token,
        refresh: res.refresh_token
      }
      this.persist()
      return true
    } catch {
      this.tokens = null
      this.persist()
      return false
    }
  }

  private async acceptTokens(res: TokenResponse): Promise<AuthState> {
    const me = await this.http.request<UserOut>('/v1/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${res.access_token}` },
      auth: false
    })
    this.tokens = {
      access: res.access_token,
      refresh: res.refresh_token,
      employeeId: me.employee_id,
      displayName: me.display_name,
      isAdmin: me.is_admin,
      tenantId: me.tenant_id
    }
    this.persist()
    return this.state()
  }
}
