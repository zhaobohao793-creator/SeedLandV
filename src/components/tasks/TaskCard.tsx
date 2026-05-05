import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Download,
  Image as ImageIcon,
  Loader2,
  Play,
  X,
  XCircle
} from 'lucide-react'
import { motion } from 'framer-motion'
import type { TaskRecord, TaskStatus } from '@shared/types'
import { estimateCost, formatCNY } from '@shared/pricing'
import { useAppStore } from '@/lib/store'
import { cn } from '@/lib/cn'

const MODE_LABEL: Record<TaskRecord['mode'], string> = {
  'text-to-video': '文生视频',
  'image-to-video': '图生视频',
  'first-last-frame': '首尾帧',
  'multi-reference': '多模态参考'
}

export default function TaskCard({
  task,
  onPreview
}: {
  task: TaskRecord
  onPreview: () => void
}) {
  const [errOpen, setErrOpen] = useState(false)
  const isActive =
    task.status === 'submitting' ||
    task.status === 'queued' ||
    task.status === 'running' ||
    task.status === 'mirroring'
  const isSuccess =
    task.status === 'succeeded' ||
    task.status === 'completed' ||
    task.status === 'completed_partial'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isActive) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [isActive])
  const elapsedSec = Math.max(0, Math.floor((now - task.createdAt) / 1000))

  const removeFromStore = useAppStore((s) => s.removeTask)

  const onCancel = async () => {
    if (task.serverId) {
      try {
        await window.seedland.cancelTask(task.serverId)
      } catch {
        // network error / 404 — UI still removes the card so the user
        // isn't stuck staring at a frozen "submitting" state
      }
    }
    removeFromStore(task.localId)
  }
  const onRemove = async () => {
    if (task.serverId) await window.seedland.removeTask(task.serverId)
    removeFromStore(task.localId)
  }
  // Workshop-delivery naming: file goes to the customer/order-keeper as
  // {订单号}.mp4. Same order_id submitted multiple times gets -2, -3 suffix.
  const orderSuffix = task.orderSeq > 1 ? `-${task.orderSeq}` : ''
  const orderBase = `${task.orderId}${orderSuffix}`
  const onDownload = async () => {
    if (!task.videoUrl) return
    await window.seedland.downloadVideo(task.videoUrl, `${orderBase}.mp4`)
  }
  const onDownloadLastFrame = async () => {
    if (!task.lastFrameUrl) return
    await window.seedland.downloadVideo(
      task.lastFrameUrl,
      `${orderBase}-last-frame.png`
    )
  }

  return (
    <div
      className={cn(
        'glass rounded-xl p-3.5 transition-all',
        isSuccess && 'glass-hover cursor-pointer',
        task.status === 'failed' && 'border-[rgba(244,63,94,0.25)]'
      )}
      onClick={() => isSuccess && onPreview()}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusDot status={task.status} />
            <span
              className="truncate font-mono text-xs font-semibold text-neon-cyan"
              title={`订单号 ${task.orderId}`}
            >
              #{task.orderId}
              {task.orderSeq > 1 && (
                <span className="ml-0.5 text-text-dim">-{task.orderSeq}</span>
              )}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
              {MODE_LABEL[task.mode]}
            </span>
            <span className="text-[10px] font-mono text-text-dim">
              · {task.params.resolution} · {task.params.duration}s
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-text">{task.prompt || '(无提示词)'}</p>
        </div>
        {!isActive && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-dim hover:text-neon-rose hover:bg-[rgba(244,63,94,0.08)] transition-colors"
            title="删除"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {isActive ? (
        <div className="mt-3">
          <div className="h-1 overflow-hidden rounded-full bg-[rgba(138,148,184,0.08)]">
            <div className="h-full shimmer-bar" />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] font-mono text-text-dim">
              {statusLabel(task.status)} · {formatElapsed(elapsedSec)}
            </span>
            <div className="flex items-center gap-2 min-w-0">
              {task.id && (
                <span
                  className="truncate text-[10px] font-mono text-text-dim/70 max-w-[120px]"
                  title={task.id}
                >
                  {task.id}
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onCancel()
                }}
                className="text-[10px] text-text-dim hover:text-neon-rose"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isSuccess && task.videoUrl && (
        <div className="mt-3 space-y-2">
          <UsageLine task={task} />
          <div className="relative overflow-hidden rounded-lg border border-[rgba(0,229,255,0.15)]">
            <video
              src={task.videoUrl}
              poster={task.lastFrameUrl}
              className="h-32 w-full object-cover"
              muted
              preload={task.lastFrameUrl ? 'none' : 'metadata'}
            />
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-transparent via-transparent to-black/50">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[rgba(0,229,255,0.2)] backdrop-blur-sm border border-neon-cyan/40">
                <Play className="h-4 w-4 text-neon-cyan" />
              </div>
            </div>
            {task.lastFrameUrl && (
              <span className="absolute left-1.5 top-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-neon-cyan/90">
                尾帧
              </span>
            )}
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation()
                onPreview()
              }}
              className="btn-ghost flex-1 !px-2 !py-1.5 !text-[11px]"
            >
              <Play className="h-3 w-3" />
              预览
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDownload()
              }}
              className="btn-ghost flex-1 !px-2 !py-1.5 !text-[11px]"
            >
              <Download className="h-3 w-3" />
              视频
            </button>
            {task.lastFrameUrl && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onDownloadLastFrame()
                }}
                className="btn-ghost !px-2 !py-1.5 !text-[11px]"
                title="下载尾帧 PNG"
              >
                <ImageIcon className="h-3 w-3" />
                尾帧
              </button>
            )}
          </div>
        </div>
      )}

      {task.status === 'failed' && task.error && (
        <div className="mt-3">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setErrOpen((v) => !v)
            }}
            className="flex w-full items-center justify-between rounded-md bg-[rgba(244,63,94,0.06)] border border-[rgba(244,63,94,0.2)] px-2.5 py-1.5 text-left"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <AlertCircle className="h-3 w-3 shrink-0 text-neon-rose" />
              <span className="truncate text-[11px] text-neon-rose">{task.error.message}</span>
            </div>
            {task.error.raw && (
              <ChevronDown
                className={cn('h-3 w-3 text-neon-rose transition-transform', errOpen && 'rotate-180')}
              />
            )}
          </button>
          {errOpen && task.error.raw && (
            <motion.pre
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              className="mt-1.5 max-h-40 overflow-auto rounded-md bg-[rgba(7,11,20,0.7)] p-2 text-[10px] font-mono text-text-muted"
            >
              {task.error.raw}
            </motion.pre>
          )}
        </div>
      )}
    </div>
  )
}

function StatusDot({ status }: { status: TaskStatus }) {
  if (status === 'succeeded' || status === 'completed' || status === 'completed_partial')
    return <CheckCircle2 className="h-3.5 w-3.5 text-neon-teal" />
  if (status === 'failed' || status === 'expired')
    return <XCircle className="h-3.5 w-3.5 text-neon-rose" />
  if (status === 'cancelled') return <XCircle className="h-3.5 w-3.5 text-text-dim" />
  return <Loader2 className="h-3.5 w-3.5 text-neon-cyan animate-spin" />
}

function statusLabel(s: TaskStatus) {
  switch (s) {
    case 'submitting':
      return '提交中…'
    case 'queued':
      return '排队中…'
    case 'running':
      return '生成中…'
    case 'mirroring':
      return '保存中…'
    case 'succeeded':
    case 'completed':
      return '已完成'
    case 'completed_partial':
      return '部分完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    case 'expired':
      return '已过期'
  }
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${s.toString().padStart(2, '0')}s`
}

function UsageLine({ task }: { task: TaskRecord }) {
  const tokens = task.usage?.total_tokens
  if (!tokens) return null
  const cost = estimateCost(task)
  return (
    <div className="flex items-center justify-between text-[10px] font-mono text-text-dim">
      <span>{tokens.toLocaleString()} tokens</span>
      {cost ? (
        <span className="text-neon-cyan" title={`${cost.ratePerMillion}元/百万 tokens`}>
          {formatCNY(cost.cny)}
        </span>
      ) : (
        <span className="text-text-dim/60" title="该模型/分辨率暂无费率">—</span>
      )}
    </div>
  )
}
