/**
 * Token persistence + login/refresh.
 *
 * Tokens live in `app.getPath('userData')/auth.bin` encrypted with
 * Electron's `safeStorage` (Keychain on macOS, DPAPI on Windows). They never
 * touch the renderer process — only `getAuthState()` (boolean + email)
 * is exposed.
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Http } from './http'
import type { AuthState } from '@shared/types'

export type { AuthState }

interface StoredTokens {
  access: string
  refresh: string
  email: string
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
  email: string
  tenant_id: string
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
        // No keychain → can't decrypt; treat as logged out.
        return { loggedIn: false }
      }
      const json = safeStorage.decryptString(enc)
      this.tokens = JSON.parse(json)
      return {
        loggedIn: true,
        email: this.tokens?.email,
        tenantId: this.tokens?.tenantId
      }
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
      email: this.tokens.email,
      tenantId: this.tokens.tenantId
    }
  }

  async register(email: string, password: string, tenantName?: string): Promise<AuthState> {
    const res = await this.http.post<TokenResponse>(
      '/v1/auth/register',
      { email, password, tenant_name: tenantName ?? email.split('@')[0] },
      { auth: false }
    )
    return this.acceptTokens(res, email)
  }

  async login(email: string, password: string): Promise<AuthState> {
    const res = await this.http.post<TokenResponse>(
      '/v1/auth/login',
      { email, password },
      { auth: false }
    )
    return this.acceptTokens(res, email)
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

  private async acceptTokens(res: TokenResponse, email: string): Promise<AuthState> {
    const me = await this.http.request<UserOut>('/v1/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${res.access_token}` },
      auth: false
    })
    this.tokens = {
      access: res.access_token,
      refresh: res.refresh_token,
      email: me.email,
      tenantId: me.tenant_id
    }
    this.persist()
    return { loggedIn: true, email: me.email, tenantId: me.tenant_id }
  }
}
