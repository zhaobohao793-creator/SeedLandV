import { useEffect } from 'react'
import { Copy, Download, ExternalLink, Image as ImageIcon, X } from 'lucide-react'
import { motion } from 'framer-motion'
import type { TaskRecord } from '@shared/types'
import { estimateCost, formatCNY } from '@shared/pricing'

export default function VideoPreviewModal({
  task,
  onClose
}: {
  task: TaskRecord
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!task.videoUrl) return null

  const onDownload = () =>
    window.seedland.downloadVideo(task.videoUrl!, `seedland-${task.localId}.mp4`)
  const onDownloadLastFrame = () =>
    task.lastFrameUrl &&
    window.seedland.downloadVideo(
      task.lastFrameUrl,
      `seedland-${task.localId}-last-frame.png`
    )
  const onCopyLink = () => navigator.clipboard.writeText(task.videoUrl!)
  const onOpenExternal = () => window.seedland.openExternal(task.videoUrl!)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-8"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="glass relative w-full max-w-4xl rounded-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between border-b border-[rgba(0,229,255,0.1)] px-5 py-3">
          <div className="min-w-0">
            <div className="text-xs font-mono uppercase tracking-wider text-neon-cyan">
              {task.params.resolution} · {task.params.ratio} · {task.params.duration}s
            </div>
            <p className="mt-0.5 truncate text-sm text-text">{task.prompt || '(无提示词)'}</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:text-text hover:bg-[rgba(255,255,255,0.05)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="bg-black">
          <video
            src={task.videoUrl}
            controls
            autoPlay
            className="w-full max-h-[70vh] object-contain"
          />
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-3">
          <div className="flex items-center gap-3 text-[11px] font-mono text-text-dim">
            {task.usage?.total_tokens && (
              <span>tokens: {task.usage.total_tokens.toLocaleString()}</span>
            )}
            {(() => {
              const c = estimateCost(task)
              if (!c) return null
              return (
                <span
                  className="text-neon-cyan"
                  title={`${c.ratePerMillion} 元/百万 tokens · ${c.hasVideoInput ? '含视频输入' : '不含视频输入'}`}
                >
                  成本 {formatCNY(c.cny)}
                </span>
              )
            })()}
          </div>
          <div className="flex gap-2">
            <button onClick={onCopyLink} className="btn-ghost !text-xs">
              <Copy className="h-3.5 w-3.5" />
              复制链接
            </button>
            <button onClick={onOpenExternal} className="btn-ghost !text-xs">
              <ExternalLink className="h-3.5 w-3.5" />
              浏览器打开
            </button>
            {task.lastFrameUrl && (
              <button onClick={onDownloadLastFrame} className="btn-ghost !text-xs">
                <ImageIcon className="h-3.5 w-3.5" />
                下载尾帧
              </button>
            )}
            <button onClick={onDownload} className="btn-primary !text-xs !py-2 !px-4">
              <Download className="h-3.5 w-3.5" />
              下载视频
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
