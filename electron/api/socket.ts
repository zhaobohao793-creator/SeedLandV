/**
 * WebSocket client to /ws/tasks with exponential reconnect. Emits parsed
 * `task:update` envelopes via the supplied callback. Rebinds with a fresh
 * token after refresh.
 */
import WebSocket from 'ws'
import type { Auth } from './auth'
import type { TaskRecord } from '@shared/types'

interface Envelope {
  type: 'task:update'
  data: TaskRecord
}

const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000

export class TaskSocket {
  private ws: WebSocket | null = null
  private backoff = BACKOFF_MIN_MS
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    private baseHttpUrl: string,
    private auth: Auth,
    private onTask: (t: TaskRecord) => void
  ) {}

  setBaseUrl(url: string): void {
    this.baseHttpUrl = url.replace(/\/+$/, '')
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.ws) {
      this.ws.removeAllListeners()
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  /** Hot-restart the connection — call after login or token refresh. */
  rebind(): void {
    if (this.stopped) {
      this.start()
      return
    }
    if (this.ws) {
      this.ws.removeAllListeners()
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.backoff = BACKOFF_MIN_MS
    this.connect()
  }

  private wsUrl(): string {
    const u = new URL(this.baseHttpUrl)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    u.pathname = '/ws/tasks'
    const tok = this.auth.getToken()
    if (tok) u.searchParams.set('token', tok)
    return u.toString()
  }

  private connect(): void {
    if (this.stopped) return
    const tok = this.auth.getToken()
    if (!tok) {
      // Not logged in — don't dial; caller will rebind() after login.
      return
    }
    const ws = new WebSocket(this.wsUrl())
    this.ws = ws

    ws.on('open', () => {
      this.backoff = BACKOFF_MIN_MS
    })

    ws.on('message', (buf) => {
      try {
        const env = JSON.parse(buf.toString()) as Envelope
        if (env?.type === 'task:update' && env.data?.localId) {
          this.onTask(env.data)
        }
      } catch (err) {
        console.warn('[socket] bad frame', err)
      }
    })

    const onClose = async (code: number) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.stopped) return
      // 1008 = policy violation (bad/expired token) → try one refresh, then reconnect.
      if (code === 1008) {
        const ok = await this.auth.tryRefresh()
        if (!ok) return // logged out; caller will rebind on next login
      }
      this.scheduleReconnect()
    }

    ws.on('close', (code) => {
      void onClose(code)
    })
    ws.on('error', (err) => {
      console.warn('[socket] error', err.message)
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const wait = this.backoff
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS)
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, wait)
  }
}
