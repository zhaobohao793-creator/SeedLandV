import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AtSign } from 'lucide-react'
import type { AssetKind, GenerationMode } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { cn } from '@/lib/cn'
import {
  allowedKindsOf,
  labelForAsset,
  registerPromptInserter
} from '@/lib/assetRefs'
import { assetSrc } from '@/lib/assetUrl'
import Thumbnail from './asset/Thumbnail'
import ChipEditor, {
  type ChipEditorHandle,
  type ChipMeta,
  type MentionState
} from './asset/ChipEditor'

interface Props {
  mode: GenerationMode
  placeholder?: string
  minRows?: number
  /** Optional ordered labels for fixed-position assets (e.g. ['首帧','尾帧']). */
  orderedLabels?: string[]
}

interface MentionItem {
  key: string
  label: string
  hint: string
  kind: AssetKind
  src?: string
}

export default function PromptPanel({ mode, placeholder, minRows = 4, orderedLabels }: Props) {
  const prompt = useAppStore((s) => s.forms[mode].prompt)
  const setPrompt = useAppStore((s) => s.setPrompt)
  const assets = useAppStore((s) => s.forms[mode].assets)

  const editorRef = useRef<ChipEditorHandle>(null)
  const [mention, setMention] = useState<MentionState | null>(null)
  const [highlight, setHighlight] = useState(0)

  const allowed = allowedKindsOf(mode)
  const supportsAssets = allowed.length > 0

  /**
   * Resolve a label to chip meta. Only the current form's uploaded assets
   * are considered — library items are reachable through the AssetPicker's
   * library tab, not via @-mention.
   */
  const resolveMention = (label: string): ChipMeta | null => {
    const st = useAppStore.getState()
    const formAssets = st.forms[mode].assets
    for (let i = 0; i < formAssets.length; i++) {
      const lbl = labelForAsset(formAssets, i, orderedLabels)
      if (lbl === label) {
        const a = formAssets[i]
        return { label, kind: a.kind, src: assetSrc(a) }
      }
    }
    return null
  }

  const mentionLabels = useMemo(
    () => assets.map((_, i) => labelForAsset(assets, i, orderedLabels)),
    [assets, orderedLabels]
  )

  // Register the imperative inserter so AssetPicker / library can drive us.
  useEffect(() => {
    return registerPromptInserter({
      mode,
      insertMention: (label) => {
        const meta = resolveMention(label)
        if (!meta) return
        editorRef.current?.insertChip(meta)
        editorRef.current?.focus()
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // Popover only lists the current form's uploaded assets.
  const items: MentionItem[] = useMemo(() => {
    if (!supportsAssets) return []
    return assets.map((a, i) => ({
      key: `form-${i}`,
      label: labelForAsset(assets, i, orderedLabels),
      hint: a.mode === 'url' ? a.url : a.name,
      kind: a.kind,
      src: assetSrc(a)
    }))
  }, [assets, supportsAssets, orderedLabels])

  const filtered = useMemo(() => {
    if (!mention) return items
    const q = mention.query.toLowerCase()
    if (!q) return items
    return items.filter(
      (it) => it.label.toLowerCase().includes(q) || it.hint.toLowerCase().includes(q)
    )
  }, [items, mention])

  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  const commit = (item: MentionItem) => {
    editorRef.current?.commitMention({ label: item.label, kind: item.kind, src: item.src })
    editorRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): boolean => {
    if (!mention || filtered.length === 0) return false
    if (e.key === 'ArrowDown') {
      setHighlight((h) => (h + 1) % filtered.length)
      return true
    }
    if (e.key === 'ArrowUp') {
      setHighlight((h) => (h - 1 + filtered.length) % filtered.length)
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      commit(filtered[highlight])
      return true
    }
    if (e.key === 'Escape') {
      setMention(null)
      return true
    }
    return false
  }

  return (
    <section className="glass rounded-2xl p-5">
      <div className="flex items-center justify-between mb-2">
        <label className="field-label !mb-0">提示词</label>
        <span className="text-[11px] font-mono text-text-dim">{prompt.length} chars</span>
      </div>
      <div className="relative">
        <ChipEditor
          ref={editorRef}
          value={prompt}
          onChange={(v) => setPrompt(mode, v)}
          resolveMention={resolveMention}
          mentionLabels={mentionLabels}
          onMentionStateChange={(s) => setMention(supportsAssets ? s : null)}
          onSpecialKeyDown={handleKeyDown}
          placeholder={
            placeholder ??
            '描述你想生成的画面，例如：一只橘猫在霓虹雨夜的东京街头漫步，电影感，超写实'
          }
          minRows={minRows}
          className="input-base resize-none text-sm leading-relaxed"
        />
        {mention && filtered.length > 0 && supportsAssets && (
          <MentionPopover
            items={filtered}
            highlight={highlight}
            anchorRect={mention.rect}
            onPick={commit}
            onHover={setHighlight}
          />
        )}
      </div>
      {supportsAssets && (
        <div className="mt-2 flex items-center gap-1 text-[11px] text-text-dim">
          <AtSign className="h-3 w-3" />
          输入 <kbd className="rounded bg-[rgba(7,11,20,0.6)] px-1 font-mono">@</kbd>
          引用已上传素材 · 点击下方资产卡片也会插入
        </div>
      )}
    </section>
  )
}

function MentionPopover({
  items,
  highlight,
  anchorRect,
  onPick,
  onHover
}: {
  items: MentionItem[]
  highlight: number
  anchorRect: DOMRect
  onPick: (item: MentionItem) => void
  onHover: (i: number) => void
}) {
  // Estimate width / height; the popover clamps inside the viewport.
  const POPOVER_W = 320
  const POPOVER_MAX_H = 256
  const margin = 8
  const vw = window.innerWidth
  const vh = window.innerHeight

  let left = anchorRect.left
  if (left + POPOVER_W + margin > vw) left = vw - POPOVER_W - margin
  if (left < margin) left = margin

  // Prefer below caret; flip above when clipped.
  const spaceBelow = vh - anchorRect.bottom - margin
  const flip = spaceBelow < 160 && anchorRect.top > spaceBelow
  const top = flip
    ? Math.max(margin, anchorRect.top - POPOVER_MAX_H - 4)
    : anchorRect.bottom + 4

  return createPortal(
    <div
      style={{
        position: 'fixed',
        left,
        top,
        width: POPOVER_W,
        maxHeight: POPOVER_MAX_H,
        zIndex: 1000
      }}
      className="overflow-auto rounded-lg border border-[rgba(0,229,255,0.25)] bg-[rgba(7,11,20,0.97)] shadow-card backdrop-blur-xl"
    >
      {items.map((it, i) => {
        const active = i === highlight
        return (
          <button
            key={it.key}
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(it)
            }}
            onMouseEnter={() => onHover(i)}
            className={cn(
              'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
              active ? 'bg-[rgba(0,229,255,0.08)]' : 'hover:bg-[rgba(255,255,255,0.02)]'
            )}
          >
            <Thumbnail
              kind={it.kind}
              src={it.src}
              className="h-8 w-8"
              iconClassName="h-3.5 w-3.5"
              rounded="sm"
            />
            <div className="min-w-0 flex-1">
              <span className="text-xs font-medium text-text">@{it.label}</span>
              <div className="truncate text-[10px] font-mono text-text-dim">{it.hint}</div>
            </div>
          </button>
        )
      })}
    </div>,
    document.body
  )
}
