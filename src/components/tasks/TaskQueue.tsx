import { useMemo, useState } from 'react'
import { Inbox, Search, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { useAppStore } from '@/lib/store'
import TaskCard from './TaskCard'
import VideoPreviewModal from './VideoPreviewModal'
import type { TaskRecord } from '@shared/types'

export default function TaskQueue() {
  const tasks = useAppStore((s) => s.tasks)
  const clearTasks = useAppStore((s) => s.clearTasks)
  const [previewing, setPreviewing] = useState<TaskRecord | null>(null)
  const [query, setQuery] = useState('')

  const sorted = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
    if (!q) return base
    return base.filter(
      (t) =>
        t.orderId.toLowerCase().includes(q) ||
        t.prompt.toLowerCase().includes(q)
    )
  }, [tasks, query])

  const onClear = async () => {
    await window.seedland.clearTasks()
    clearTasks()
  }

  return (
    <>
      <aside className="flex w-80 flex-col border-l border-[rgba(0,229,255,0.08)]">
        <header className="flex h-14 items-center justify-between border-b border-[rgba(0,229,255,0.08)] px-5">
          <div className="flex items-center gap-2">
            <Inbox className="h-4 w-4 text-neon-cyan" />
            <span className="text-sm font-medium">任务队列</span>
            {tasks.length > 0 && (
              <span className="chip !bg-[rgba(168,85,247,0.08)] !text-neon-violet !border-[rgba(168,85,247,0.2)] !px-1.5 !py-0 !text-[10px]">
                {query ? `${sorted.length}/${tasks.length}` : tasks.length}
              </span>
            )}
          </div>
          {tasks.length > 0 && (
            <button
              onClick={onClear}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-dim hover:text-neon-rose hover:bg-[rgba(244,63,94,0.08)] transition-colors"
              title="清空"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </header>

        {tasks.length > 0 && (
          <div className="border-b border-[rgba(0,229,255,0.06)] px-4 py-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-dim" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索订单号或提示词"
                className="w-full rounded-md bg-white/5 py-1.5 pl-8 pr-2 text-xs outline-none ring-1 ring-white/10 placeholder:text-text-dim focus:ring-neon-cyan/30"
              />
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto p-4 space-y-3">
          {sorted.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[rgba(0,229,255,0.04)] border border-[rgba(0,229,255,0.1)]">
                <Inbox className="h-6 w-6 text-text-dim" />
              </div>
              <p className="mt-3 text-sm text-text-muted">
                {tasks.length === 0 ? '还没有任务' : '没有匹配的任务'}
              </p>
              <p className="mt-1 text-[11px] text-text-dim">
                {tasks.length === 0 ? '提交后会在这里显示进度' : '换个订单号或关键词试试'}
              </p>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {sorted.map((t) => (
                <motion.div
                  key={t.localId}
                  layout
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                >
                  <TaskCard task={t} onPreview={() => setPreviewing(t)} />
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        </div>
      </aside>

      {previewing && <VideoPreviewModal task={previewing} onClose={() => setPreviewing(null)} />}
    </>
  )
}
