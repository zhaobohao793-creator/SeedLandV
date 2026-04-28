import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, ChevronDown, Sparkles, Zap } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import type { ModelId } from '@shared/types'
import { MODELS, metaOf } from '@shared/types'
import { cn } from '@/lib/cn'

const MODEL_ICONS: Record<ModelId, typeof Sparkles> = {
  'doubao-seedance-2-0-260128': Sparkles,
  'doubao-seedance-2-0-fast-260128': Zap
}

export default function Topbar() {
  const apiStatus = useAppStore((s) => s.apiStatus)
  const currentModel = useAppStore((s) => s.forms['text-to-video'].params.model)
  const setModel = useAppStore((s) => s.setModel)
  const setArkKeyPromptOpen = useAppStore((s) => s.setArkKeyPromptOpen)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const meta = metaOf(currentModel)
  const activeReady = !!apiStatus?.ark.hasKey
  const CurrentIcon = MODEL_ICONS[currentModel]

  return (
    <header className="flex h-14 items-center justify-between border-b border-[rgba(0,229,255,0.08)] px-6">
      <div className="flex items-center gap-8">
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <div className="h-7 w-7 rounded-lg bg-accent-gradient shadow-glow" />
            <div className="absolute inset-0 h-7 w-7 rounded-lg bg-accent-gradient blur-md opacity-40" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold tracking-tight">SeedLand</span>
            <span className="text-[11px] font-mono tracking-widest text-neon-cyan">· V</span>
          </div>
        </div>

        <div ref={ref} className="relative">
          <button
            onClick={() => setOpen((v) => !v)}
            className={cn(
              'flex items-center gap-2.5 rounded-lg border px-3 py-1.5 transition-colors',
              open
                ? 'border-[rgba(0,229,255,0.3)] bg-[rgba(0,229,255,0.06)]'
                : 'border-[rgba(138,148,184,0.15)] bg-[rgba(7,11,20,0.5)] hover:border-[rgba(0,229,255,0.2)]'
            )}
          >
            <CurrentIcon className="h-3.5 w-3.5 text-neon-cyan" />
            <div className="flex items-baseline gap-1.5 text-left">
              <span className="text-xs font-medium text-text">{meta.label}</span>
              <span className="text-[10px] font-mono text-text-dim">{meta.sublabel}</span>
            </div>
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 text-text-muted transition-transform',
                open && 'rotate-180'
              )}
            />
          </button>

          <AnimatePresence>
            {open && (
              <motion.div
                initial={{ opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={{ duration: 0.12 }}
                className="absolute left-0 top-[calc(100%+6px)] z-50 w-[300px] rounded-xl border border-[rgba(0,229,255,0.15)] bg-[rgba(10,14,26,0.95)] p-2 shadow-[0_12px_32px_rgba(0,0,0,0.5),0_0_0_1px_rgba(0,229,255,0.06)] backdrop-blur-xl"
              >
                <div className="py-1">
                  <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-dim">
                    视频生成
                  </div>
                  {MODELS.map((m) => {
                    const active = currentModel === m.id
                    const Icon = MODEL_ICONS[m.id]
                    return (
                      <button
                        key={m.id}
                        onClick={() => {
                          setModel(m.id)
                          setOpen(false)
                        }}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
                          active
                            ? 'bg-[rgba(0,229,255,0.08)]'
                            : 'hover:bg-[rgba(255,255,255,0.03)]'
                        )}
                      >
                        <div
                          className={cn(
                            'flex h-7 w-7 items-center justify-center rounded-md',
                            active
                              ? 'bg-[rgba(0,229,255,0.12)] text-neon-cyan'
                              : 'bg-[rgba(255,255,255,0.02)] text-text-muted'
                          )}
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium text-text">{m.label}</span>
                            {!activeReady && (
                              <span
                                className="h-1.5 w-1.5 rounded-full bg-neon-rose"
                                title="缺少 ARK Key"
                              />
                            )}
                          </div>
                          <span className="truncate text-[10px] font-mono text-text-dim">
                            {m.sublabel}
                          </span>
                        </div>
                        {active && <Check className="h-3.5 w-3.5 text-neon-cyan" />}
                      </button>
                    )
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setArkKeyPromptOpen(true)}
          title={activeReady ? '点击重设 Ark Key' : '点击配置 Ark Key'}
          className="flex items-center gap-2 rounded-full border border-[rgba(138,148,184,0.12)] px-3 py-1.5 transition-colors hover:border-[rgba(0,229,255,0.3)] hover:bg-[rgba(0,229,255,0.04)]"
        >
          <motion.span
            animate={{ opacity: activeReady ? [0.4, 1, 0.4] : 1 }}
            transition={{ repeat: Infinity, duration: 2 }}
            className={cn(
              'h-2 w-2 rounded-full',
              activeReady ? 'bg-neon-cyan shadow-[0_0_8px_rgba(0,229,255,0.8)]' : 'bg-neon-rose'
            )}
          />
          <span className="text-[11px] font-medium tracking-wider uppercase text-text-muted">
            {activeReady ? 'ARK Key Ready' : 'Missing ARK Key'}
          </span>
        </button>
      </div>
    </header>
  )
}
