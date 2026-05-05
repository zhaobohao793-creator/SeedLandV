import { useState } from 'react'
import { Sparkles, AlertTriangle, X, Hash } from 'lucide-react'
import type { GenerationMode } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { cn } from '@/lib/cn'

interface Props {
  mode: GenerationMode
  canSubmit: boolean
  requireHint?: string
}

export default function GenerateButton({ mode, canSubmit, requireHint }: Props) {
  const form = useAppStore((s) => s.forms[mode])
  const setOrderId = useAppStore((s) => s.setOrderId)
  const apiStatus = useAppStore((s) => s.apiStatus)
  const hasApi = !!apiStatus?.ark.hasKey
  const orderId = form.orderId.trim()
  const orderOk = orderId.length > 0
  const disabled = !hasApi || !canSubmit || !orderOk
  const [submitError, setSubmitError] = useState<string | null>(null)

  const onClick = async () => {
    if (disabled) return
    setSubmitError(null)
    const res = await window.seedland.submitTask({
      mode,
      prompt: form.prompt,
      orderId,
      assets: form.assets,
      params: form.params
    })
    if ('error' in res) setSubmitError(res.error)
  }

  return (
    <div className="space-y-3">
      <section className="glass rounded-2xl p-4">
        <label className="field-label">订单号</label>
        <div className="relative">
          <Hash className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-dim" />
          <input
            value={form.orderId}
            onChange={(e) => setOrderId(mode, e.target.value)}
            maxLength={64}
            placeholder="必填，例如 2026-0508-001"
            className="input-base !pl-9 font-mono text-sm"
          />
        </div>
        <p className="mt-1.5 text-[11px] text-text-dim">
          产出视频文件名将以订单号命名；同订单号多次生成自动追加 -2、-3 后缀
        </p>
      </section>

      <div className="flex items-center gap-3">
        <button onClick={onClick} disabled={disabled} className={cn('btn-primary flex-1 h-12 text-[15px]')}>
          <Sparkles className="h-4 w-4" />
          {!hasApi ? '未配置 ARK Key' : !orderOk ? '请先填写订单号' : '生成视频'}
          {!disabled && (
            <span className="absolute inset-0 rounded-xl bg-accent-gradient opacity-0 hover:opacity-30 blur-xl transition-opacity pointer-events-none" />
          )}
        </button>
        {requireHint && !canSubmit && (
          <span className="text-xs text-text-muted max-w-[180px]">{requireHint}</span>
        )}
      </div>
      {submitError && (
        <div className="flex items-start gap-2 rounded-lg border border-neon-rose/30 bg-neon-rose/5 px-3 py-2 text-xs text-neon-rose">
          <AlertTriangle className="mt-[2px] h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1 break-words">{submitError}</span>
          <button
            onClick={() => setSubmitError(null)}
            className="text-neon-rose/60 hover:text-neon-rose"
            aria-label="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
