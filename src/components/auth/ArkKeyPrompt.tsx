import { useState } from 'react'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useAppStore } from '@/lib/store'

export default function ArkKeyPrompt() {
  const apiStatus = useAppStore((s) => s.apiStatus)
  const setApiStatus = useAppStore((s) => s.setApiStatus)
  const setArkKeyPromptOpen = useAppStore((s) => s.setArkKeyPromptOpen)
  const [key, setKey] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Allow dismissal only when a key is already configured (this is a reset, not initial setup).
  const canClose = !!apiStatus?.ark.hasKey

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const res = await window.seedland.setArkKey(key.trim())
    setSubmitting(false)
    if ('error' in res) {
      setError(res.error)
      return
    }
    setApiStatus({ ark: { hasKey: true } })
    setArkKeyPromptOpen(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/85 backdrop-blur">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass relative w-[440px] rounded-2xl p-7"
      >
        {canClose && (
          <button
            type="button"
            onClick={() => setArkKeyPromptOpen(false)}
            className="absolute right-4 top-4 text-text-dim hover:text-text"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <h2 className="mb-2 text-lg font-semibold">
          {canClose ? '重设 Ark API Key' : '配置 Ark API Key'}
        </h2>
        <p className="mb-5 text-xs text-text-dim leading-relaxed">
          Seedance 2.0 需要火山方舟 Ark Key 才能调用模型。Key 仅在你的租户下加密存储（Fernet），不会发送给其他人。
          <br />
          控制台：
          <button
            type="button"
            onClick={() => window.seedland.openExternal('https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey')}
            className="ml-1 text-neon-cyan hover:underline"
          >
            console.volcengine.com/ark
          </button>
        </p>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="password"
            autoFocus
            required
            minLength={10}
            placeholder="ark_..."
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm font-mono outline-none ring-1 ring-white/10 focus:ring-neon-cyan/40"
          />
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
            {submitting ? '保存中…' : '保存'}
          </button>
        </form>
      </motion.div>
    </div>
  )
}
