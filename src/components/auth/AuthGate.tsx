import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useAppStore } from '@/lib/store'

type Mode = 'login' | 'bootstrap'

export default function AuthGate() {
  const setAuthState = useAppStore((s) => s.setAuthState)
  // Default to "login" — if the API confirms the system is uninitialised on
  // first launch, we'll flip to the bootstrap form. Showing login first means
  // users with a working install never see a confusing first-run flash.
  const [mode, setMode] = useState<Mode>('login')
  const [employeeId, setEmployeeId] = useState('')
  const [password, setPassword] = useState('')
  const [workshopName, setWorkshopName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.seedland.getBootstrapStatus().then((s) => {
      if (cancelled) return
      if (!s.initialized) setMode('bootstrap')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const res =
      mode === 'login'
        ? await window.seedland.login(employeeId, password)
        : await window.seedland.bootstrap(
            workshopName,
            employeeId,
            password,
            displayName || undefined
          )
    setSubmitting(false)
    if (res && typeof res === 'object' && 'error' in res) {
      setError(res.error)
      return
    }
    setAuthState(res)
  }

  const isBootstrap = mode === 'bootstrap'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/85 backdrop-blur">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass w-[400px] rounded-2xl p-7"
      >
        <div className="mb-5">
          <h2 className="text-lg font-semibold">
            {isBootstrap ? '初始化工作室' : '员工登录'}
          </h2>
          <p className="mt-1 text-xs text-text-dim">
            {isBootstrap
              ? '首次启动：创建工作室并设置首位管理员账号'
              : '使用工号和密码登录 SeedLand · V'}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          {isBootstrap && (
            <input
              type="text"
              required
              maxLength={255}
              autoFocus
              placeholder="工作室名称"
              value={workshopName}
              onChange={(e) => setWorkshopName(e.target.value)}
              className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
            />
          )}
          <input
            type="text"
            required
            autoFocus={!isBootstrap}
            maxLength={64}
            placeholder={isBootstrap ? '管理员工号' : '员工工号'}
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
          />
          <input
            type="password"
            required
            minLength={isBootstrap ? 8 : 6}
            placeholder={`密码${isBootstrap ? '（至少 8 位）' : ''}`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
          />
          {isBootstrap && (
            <input
              type="text"
              maxLength={128}
              placeholder="显示名（可选，默认取工号）"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
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
            {submitting
              ? '处理中…'
              : isBootstrap
                ? '初始化并登录'
                : '登录'}
          </button>
          {!isBootstrap && (
            <p className="pt-1 text-center text-[11px] text-text-dim">
              工号需由管理员预先创建，忘记密码请联系管理员重置
            </p>
          )}
        </form>
      </motion.div>
    </div>
  )
}
