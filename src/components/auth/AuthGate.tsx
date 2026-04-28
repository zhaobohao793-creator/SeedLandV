import { useState } from 'react'
import { motion } from 'framer-motion'
import { useAppStore } from '@/lib/store'

type Mode = 'login' | 'register'

export default function AuthGate() {
  const setAuthState = useAppStore((s) => s.setAuthState)
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [tenant, setTenant] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const fn = mode === 'login' ? window.seedland.login : window.seedland.register
    const args =
      mode === 'login'
        ? ([email, password] as const)
        : ([email, password, tenant || email.split('@')[0]] as const)
    const res = await (fn as (...a: unknown[]) => Promise<unknown>)(...args)
    setSubmitting(false)
    if (res && typeof res === 'object' && 'error' in res) {
      setError((res as { error: string }).error)
      return
    }
    setAuthState(res as { loggedIn: boolean; email?: string; tenantId?: string })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/85 backdrop-blur">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass w-[380px] rounded-2xl p-7"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {mode === 'login' ? '登录 SeedLand · V' : '注册账号'}
          </h2>
          <button
            type="button"
            className="text-xs text-text-dim hover:text-text"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login')
              setError(null)
            }}
          >
            {mode === 'login' ? '没账号？注册' : '已有账号？登录'}
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="email"
            autoFocus
            required
            placeholder="邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
          />
          <input
            type="password"
            required
            minLength={6}
            placeholder="密码（至少 6 位）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
          />
          {mode === 'register' && (
            <input
              type="text"
              placeholder="租户名（可选，默认取邮箱前缀）"
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
            />
          )}
          {error && (
            <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="btn-primary w-full disabled:opacity-50"
          >
            {submitting ? '处理中…' : mode === 'login' ? '登录' : '创建账号'}
          </button>
        </form>
      </motion.div>
    </div>
  )
}
