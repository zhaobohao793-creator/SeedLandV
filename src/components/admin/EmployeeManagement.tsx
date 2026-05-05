import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Loader2,
  Plus,
  Power,
  Shield,
  ShieldOff,
  UserCircle2,
  X
} from 'lucide-react'
import type {
  CreateEmployeeInput,
  EmployeeRecord,
  UpdateEmployeeInput
} from '@shared/types'
import { useAppStore } from '@/lib/store'
import { cn } from '@/lib/cn'

interface Props {
  onClose: () => void
}

export default function EmployeeManagement({ onClose }: Props) {
  const me = useAppStore((s) => s.authState)
  const [list, setList] = useState<EmployeeRecord[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const refresh = async () => {
    const res = await window.seedland.listEmployees()
    if ('error' in res) {
      setLoadError(res.error)
      return
    }
    setLoadError(null)
    setList(res)
  }

  useEffect(() => {
    refresh()
  }, [])

  const onPatch = async (user: EmployeeRecord, patch: UpdateEmployeeInput) => {
    setPendingId(user.id)
    const res = await window.seedland.updateEmployee(user.id, patch)
    setPendingId(null)
    if ('error' in res) {
      alert(res.error)
      return
    }
    setList((prev) => prev?.map((u) => (u.id === user.id ? res : u)) ?? null)
  }

  const onDeactivate = async (user: EmployeeRecord) => {
    if (!confirm(`确认停用员工 ${user.employeeId} 吗？停用后该工号无法登录，可在此页面重新启用。`))
      return
    setPendingId(user.id)
    const res = await window.seedland.deactivateEmployee(user.id)
    setPendingId(null)
    if ('error' in res) {
      alert(res.error)
      return
    }
    setList((prev) => prev?.map((u) => (u.id === user.id ? res : u)) ?? null)
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/85 backdrop-blur">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass max-h-[80vh] w-[680px] overflow-hidden rounded-2xl"
      >
        <header className="flex items-center justify-between border-b border-[rgba(0,229,255,0.08)] px-5 py-3">
          <div className="flex items-center gap-2">
            <UserCircle2 className="h-4 w-4 text-neon-cyan" />
            <h2 className="text-sm font-semibold">员工管理</h2>
            {list && (
              <span className="chip !bg-[rgba(0,229,255,0.08)] !text-neon-cyan !border-[rgba(0,229,255,0.2)] !px-1.5 !py-0 !text-[10px]">
                {list.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCreate(true)}
              className="btn-primary !h-7 !px-2.5 !text-[11px]"
            >
              <Plus className="h-3 w-3" />
              新建员工
            </button>
            <button
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-dim hover:text-text"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        <div className="max-h-[60vh] overflow-auto p-4">
          {loadError && (
            <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {loadError}
            </div>
          )}
          {!list && !loadError && (
            <div className="flex items-center justify-center py-10 text-text-dim">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
          {list && list.length === 0 && (
            <div className="py-10 text-center text-sm text-text-dim">
              还没有员工，点击右上角「新建员工」添加
            </div>
          )}
          {list && list.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-[rgba(255,255,255,0.05)]">
              <table className="w-full text-xs">
                <thead className="bg-white/[0.02] text-text-dim">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">工号</th>
                    <th className="px-3 py-2 text-left font-medium">显示名</th>
                    <th className="px-3 py-2 text-left font-medium">角色</th>
                    <th className="px-3 py-2 text-left font-medium">状态</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {list.map((u) => {
                    const isMe = me.employeeId === u.employeeId
                    const busy = pendingId === u.id
                    return (
                      <tr key={u.id} className={cn(!u.isActive && 'opacity-50')}>
                        <td className="px-3 py-2 font-mono">
                          {u.employeeId}
                          {isMe && (
                            <span className="ml-1.5 text-[9px] text-neon-cyan">（我）</span>
                          )}
                        </td>
                        <td className="px-3 py-2">{u.displayName ?? '—'}</td>
                        <td className="px-3 py-2">
                          {u.isAdmin ? (
                            <span className="flex items-center gap-1 text-neon-cyan">
                              <Shield className="h-3 w-3" />
                              管理员
                            </span>
                          ) : (
                            <span className="text-text-dim">员工</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {u.isActive ? (
                            <span className="text-neon-teal">在职</span>
                          ) : (
                            <span className="text-text-dim">已停用</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {!isMe && (
                              <button
                                onClick={() => onPatch(u, { isAdmin: !u.isAdmin })}
                                disabled={busy}
                                title={u.isAdmin ? '取消管理员权限' : '授予管理员权限'}
                                className="rounded-md p-1 text-text-dim hover:bg-white/5 hover:text-text disabled:opacity-40"
                              >
                                {u.isAdmin ? (
                                  <ShieldOff className="h-3.5 w-3.5" />
                                ) : (
                                  <Shield className="h-3.5 w-3.5" />
                                )}
                              </button>
                            )}
                            {!isMe && u.isActive && (
                              <button
                                onClick={() => onDeactivate(u)}
                                disabled={busy}
                                title="停用账号"
                                className="rounded-md p-1 text-text-dim hover:bg-[rgba(244,63,94,0.08)] hover:text-neon-rose disabled:opacity-40"
                              >
                                <Power className="h-3.5 w-3.5" />
                              </button>
                            )}
                            {!isMe && !u.isActive && (
                              <button
                                onClick={() => onPatch(u, { isActive: true })}
                                disabled={busy}
                                title="重新启用"
                                className="rounded-md p-1 text-text-dim hover:bg-white/5 hover:text-text disabled:opacity-40"
                              >
                                <Power className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </motion.div>

      {showCreate && (
        <CreateEmployeeDialog
          onClose={() => setShowCreate(false)}
          onCreated={(emp) => {
            setList((prev) => (prev ? [...prev, emp] : [emp]))
            setShowCreate(false)
          }}
        />
      )}
    </div>
  )
}

function CreateEmployeeDialog({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (emp: EmployeeRecord) => void
}) {
  const [employeeId, setEmployeeId] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const input: CreateEmployeeInput = {
      employeeId: employeeId.trim(),
      password,
      displayName: displayName.trim() || undefined,
      isAdmin
    }
    const res = await window.seedland.createEmployee(input)
    setSubmitting(false)
    if ('error' in res) {
      setError(res.error)
      return
    }
    onCreated(res)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/90 backdrop-blur">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass w-[380px] rounded-2xl p-5"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold">新建员工</h3>
          <button onClick={onClose} className="text-text-dim hover:text-text">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <input
            type="text"
            required
            maxLength={64}
            autoFocus
            placeholder="工号"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
          />
          <input
            type="text"
            maxLength={128}
            placeholder="显示名（可选）"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
          />
          <input
            type="text"
            required
            minLength={8}
            maxLength={128}
            placeholder="初始密码（至少 8 位）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
          />
          <label className="flex cursor-pointer items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={(e) => setIsAdmin(e.target.checked)}
              className="h-3.5 w-3.5 accent-neon-cyan"
            />
            授予管理员权限（可管理其他员工）
          </label>
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
            {submitting ? '创建中…' : '创建员工'}
          </button>
        </form>
      </motion.div>
    </div>
  )
}
