import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  Loader2,
  RotateCw,
  Search,
  X
} from 'lucide-react'
import type {
  ListOrdersFilters,
  OrderRecord,
  TaskStatus
} from '@shared/types'
import { cn } from '@/lib/cn'

interface Props {
  onClose: () => void
}

const PAGE_SIZE = 50

const STATUS_OPTIONS: { value: TaskStatus | ''; label: string }[] = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '待处理' },
  { value: 'submitting', label: '提交中' },
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '生成中' },
  { value: 'mirroring', label: '保存中' },
  { value: 'succeeded', label: '生成完成' },
  { value: 'completed', label: '已完成' },
  { value: 'completed_partial', label: '部分完成' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
  { value: 'expired', label: '已过期' }
]

function statusLabel(s: TaskStatus): string {
  return STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s
}

function statusClass(s: TaskStatus): string {
  if (s === 'completed' || s === 'succeeded') return 'text-neon-teal'
  if (s === 'completed_partial') return 'text-yellow-300'
  if (s === 'failed' || s === 'expired') return 'text-neon-rose'
  if (s === 'cancelled') return 'text-text-dim'
  return 'text-neon-cyan'
}

function fmtDate(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function dateInputToISO(value: string, endOfDay = false): string | undefined {
  if (!value) return undefined
  const suffix = endOfDay ? 'T23:59:59' : 'T00:00:00'
  return new Date(value + suffix).toISOString()
}

export default function OrderHistory({ onClose }: Props) {
  const [filters, setFilters] = useState<{
    employeeId: string
    orderId: string
    status: TaskStatus | ''
    from: string
    to: string
  }>({ employeeId: '', orderId: '', status: '', from: '', to: '' })
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<OrderRecord[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const fetchPage = async (newOffset = offset): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    const payload: ListOrdersFilters = {
      employeeId: filters.employeeId.trim() || undefined,
      orderId: filters.orderId.trim() || undefined,
      status: filters.status || undefined,
      from: dateInputToISO(filters.from),
      to: dateInputToISO(filters.to, true),
      limit: PAGE_SIZE,
      offset: newOffset
    }
    try {
      if (typeof window.seedland.listOrders !== 'function') {
        throw new Error('订单历史接口未加载;请重启 Electron 让 preload 生效')
      }
      const res = await window.seedland.listOrders(payload)
      if ('error' in res) {
        setLoadError(res.error)
        setList(null)
        return
      }
      setList(res)
      setOffset(newOffset)
    } catch (err) {
      setLoadError((err as Error).message || String(err))
      setList(null)
    } finally {
      setLoading(false)
    }
  }

  // Initial load (filters reset triggers a new fetch via the apply button).
  useEffect(() => {
    void fetchPage(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onApply = (e?: React.FormEvent): void => {
    e?.preventDefault()
    void fetchPage(0)
  }

  const onReset = (): void => {
    setFilters({ employeeId: '', orderId: '', status: '', from: '', to: '' })
    setOffset(0)
    setTimeout(() => void fetchPage(0), 0)
  }

  const hasNext = (list?.length ?? 0) === PAGE_SIZE
  const hasPrev = offset > 0

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/85 backdrop-blur">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass max-h-[88vh] w-[1080px] overflow-hidden rounded-2xl"
      >
        <header className="flex items-center justify-between border-b border-[rgba(0,229,255,0.08)] px-5 py-3">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-neon-cyan" />
            <h2 className="text-sm font-semibold">订单历史</h2>
            {list && (
              <span className="chip !bg-[rgba(0,229,255,0.08)] !text-neon-cyan !border-[rgba(0,229,255,0.2)] !px-1.5 !py-0 !text-[10px]">
                {list.length}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-dim hover:text-text"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <form
          onSubmit={onApply}
          className="grid grid-cols-12 gap-2 border-b border-[rgba(0,229,255,0.08)] px-5 py-3 text-xs"
        >
          <input
            type="text"
            placeholder="工号"
            maxLength={64}
            value={filters.employeeId}
            onChange={(e) => setFilters((f) => ({ ...f, employeeId: e.target.value }))}
            className="col-span-2 rounded-md bg-white/5 px-2 py-1.5 outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
          />
          <input
            type="text"
            placeholder="订单号"
            maxLength={64}
            value={filters.orderId}
            onChange={(e) => setFilters((f) => ({ ...f, orderId: e.target.value }))}
            className="col-span-2 rounded-md bg-white/5 px-2 py-1.5 outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
          />
          <select
            value={filters.status}
            onChange={(e) =>
              setFilters((f) => ({ ...f, status: e.target.value as TaskStatus | '' }))
            }
            className="col-span-2 rounded-md bg-white/5 px-2 py-1.5 outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value || 'all'} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
            title="起始日期"
            className="col-span-2 rounded-md bg-white/5 px-2 py-1.5 outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
          />
          <input
            type="date"
            value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            title="结束日期"
            className="col-span-2 rounded-md bg-white/5 px-2 py-1.5 outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
          />
          <div className="col-span-2 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={onReset}
              className="flex h-7 items-center gap-1 rounded-md px-2 text-text-dim hover:bg-white/5 hover:text-text"
            >
              <RotateCw className="h-3 w-3" />
              重置
            </button>
            <button
              type="submit"
              disabled={loading}
              className="btn-primary !h-7 !px-2.5 !text-[11px] disabled:opacity-50"
            >
              <Search className="h-3 w-3" />
              查询
            </button>
          </div>
        </form>

        <div className="max-h-[60vh] overflow-auto px-5 py-3">
          {loadError && (
            <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {loadError}
            </div>
          )}
          {loading && !list && (
            <div className="flex items-center justify-center py-10 text-text-dim">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
          {list && list.length === 0 && !loading && (
            <div className="py-10 text-center text-sm text-text-dim">
              没有匹配的订单
            </div>
          )}
          {list && list.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-[rgba(255,255,255,0.05)]">
              <table className="w-full text-xs">
                <thead className="bg-white/[0.02] text-text-dim">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">创建时间</th>
                    <th className="px-3 py-2 text-left font-medium">订单号</th>
                    <th className="px-3 py-2 text-left font-medium">工号</th>
                    <th className="px-3 py-2 text-left font-medium">模式</th>
                    <th className="px-3 py-2 text-left font-medium">状态</th>
                    <th className="px-3 py-2 text-left font-medium">提示词</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {list.map((o) => (
                    <tr key={o.serverId} className="hover:bg-white/[0.02]">
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-text-muted">
                        {fmtDate(o.createdAt)}
                      </td>
                      <td className="px-3 py-2 font-mono">{o.orderId}</td>
                      <td className="px-3 py-2 font-mono">
                        {o.employeeId ?? '—'}
                        {o.employeeDisplayName && (
                          <span className="ml-1 text-text-dim">
                            ({o.employeeDisplayName})
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-text-muted">{o.mode}</td>
                      <td className={cn('px-3 py-2', statusClass(o.status))}>
                        {statusLabel(o.status)}
                      </td>
                      <td
                        className="max-w-[220px] truncate px-3 py-2 text-text-muted"
                        title={o.prompt}
                      >
                        {o.prompt}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {o.videoUrl ? (
                          <button
                            onClick={() =>
                              window.seedland.downloadVideo(
                                o.videoUrl!,
                                `${o.orderId}.mp4`
                              )
                            }
                            title="下载视频"
                            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-neon-cyan hover:bg-[rgba(0,229,255,0.06)]"
                          >
                            <Download className="h-3 w-3" />
                            下载
                          </button>
                        ) : (
                          <span className="text-text-dim">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-[rgba(0,229,255,0.08)] px-5 py-2.5 text-[11px] text-text-dim">
          <div>
            {list && (
              <>
                显示 {offset + 1}–{offset + list.length} 条
                {loading && (
                  <Loader2 className="ml-2 inline h-3 w-3 animate-spin text-neon-cyan" />
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => void fetchPage(Math.max(0, offset - PAGE_SIZE))}
              disabled={!hasPrev || loading}
              className="flex h-6 items-center gap-0.5 rounded-md px-2 hover:bg-white/5 disabled:opacity-40"
            >
              <ChevronLeft className="h-3 w-3" />
              上一页
            </button>
            <button
              onClick={() => void fetchPage(offset + PAGE_SIZE)}
              disabled={!hasNext || loading}
              className="flex h-6 items-center gap-0.5 rounded-md px-2 hover:bg-white/5 disabled:opacity-40"
            >
              下一页
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        </footer>
      </motion.div>
    </div>
  )
}
