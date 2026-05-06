import { useEffect, useMemo, useRef, useState } from 'react'
import { AtSign, Library } from 'lucide-react'
import type {
  AssetKind,
  AssetSource,
  GenerationMode,
  LibraryItem
} from '@shared/types'
import { useAppStore } from '@/lib/store'
import { cn } from '@/lib/cn'
import {
  allowedKindsOf,
  labelForAsset,
  registerPromptInserter
} from '@/lib/assetRefs'
import { assetSrc, librarySrc } from '@/lib/assetUrl'
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

interface MentionItem extends ChipMeta {
  key: string
  hint: string
  fromLibrary: boolean
  source?: AssetSource
}

export default function PromptPanel({
  mode,
  placeholder,
  minRows = 4,
  orderedLabels
}: Props) {
  const prompt = useAppStore((s) => s.forms[mode].prompt)
  const setPrompt = useAppStore((s) => s.setPrompt)
  const assets = useAppStore((s) => s.forms[mode].assets)
  const addAsset = useAppStore((s) => s.addAsset)
  const library = useAppStore((s) => s.library)

  const editorRef = useRef<ChipEditorHandle>(null)
  const [mention, setMention] = useState<MentionState | null>(null)
  const [highlight, setHighlight] = useState(0)

  const allowed = allowedKindsOf(mode)
  const supportsAssets = allowed.length > 0

  // Build the list of recognised mention labels and a resolver from label →
  // ChipMeta. Form assets win over library on label collision (the prompt is
  // about *this* generation).
  const { items, labels, resolve } = useMemo(() => {
    const items: MentionItem[] = []
    const seen = new Set<string>()

    if (supportsAssets) {
      assets.forEach((a, i) => {
        const label = labelForAsset(assets, i, orderedLabels)
        if (seen.has(label)) return
        seen.add(label)
        items.push({
          key: `form-${i}`,
          label,
          kind: a.kind,
          src: assetSrc(a),
          hint: a.mode === 'url' ? a.url : a.name,
          fromLibrary: false
        })
      })
      library
        .filter((x) => allowed.includes(x.kind))
        .forEach((x) => {
          if (seen.has(x.name)) return
          seen.add(x.name)
          items.push({
            key: `lib-${x.id}`,
            label: x.name,
            kind: x.kind,
            src: librarySrc(x),
            hint: x.mode === 'url' ? x.url : '资产库',
            fromLibrary: true,
            source: libraryToSource(x)
          })
        })
    }

    const labels = items.map((i) => i.label)
    const map = new Map(items.map((it) => [it.label, it as ChipMeta]))
    return { items, labels, resolve: (label: string) => map.get(label) ?? null }
  }, [assets, library, allowed, supportsAssets, orderedLabels])

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

  // Register an imperative chip insertion API for AssetPicker / library tile
  // clicks. Always uses the ChipEditor's insertChip path so the visual stays
  // consistent with @-mention commits.
  useEffect(() => {
    return registerPromptInserter({
      mode,
      insertMention: (label) => {
        const meta = resolve(label)
        if (meta) editorRef.current?.insertChip(meta)
        else editorRef.current?.insertChip({ label, kind: 'image' })
      }
    })
  }, [mode, resolve])

  const commit = (item: MentionItem) => {
    if (item.fromLibrary && item.source) {
      addAsset(mode, item.source)
    }
    editorRef.current?.commitMention(item)
  }

  const onSpecialKey = (e: React.KeyboardEvent<HTMLDivElement>): boolean => {
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
          resolveMention={resolve}
          mentionLabels={labels}
          onMentionStateChange={setMention}
          onSpecialKeyDown={onSpecialKey}
          placeholder={
            placeholder ??
            '描述你想生成的画面，例如：一只橘猫在霓虹雨夜的东京街头漫步，电影感，超写实'
          }
          minRows={minRows}
          className="prompt-input"
        />
        {mention && filtered.length > 0 && supportsAssets && (
          <MentionPopover
            items={filtered}
            highlight={highlight}
            onPick={commit}
            onHover={setHighlight}
          />
        )}
      </div>
      {supportsAssets && (
        <div className="mt-2 flex items-center gap-1 text-[11px] text-text-dim">
          <AtSign className="h-3 w-3" />
          输入 <kbd className="rounded bg-[rgba(7,11,20,0.6)] px-1 font-mono">@</kbd> 引用素材或资产库
        </div>
      )}
    </section>
  )
}

function MentionPopover({
  items,
  highlight,
  onPick,
  onHover
}: {
  items: MentionItem[]
  highlight: number
  onPick: (item: MentionItem) => void
  onHover: (i: number) => void
}) {
  return (
    <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-auto rounded-lg border border-[rgba(0,229,255,0.2)] bg-[rgba(7,11,20,0.95)] shadow-card backdrop-blur-xl">
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
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-text">@{it.label}</span>
                {it.fromLibrary && <Library className="h-3 w-3 text-text-dim" />}
              </div>
              <div className="truncate text-[10px] font-mono text-text-dim">{it.hint}</div>
            </div>
            {it.fromLibrary && (
              <span className="shrink-0 rounded bg-[rgba(0,229,255,0.08)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-neon-cyan">
                库
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function libraryToSource(item: LibraryItem): AssetSource {
  if (item.mode === 'local') {
    return {
      kind: item.kind,
      mode: 'local',
      path: item.path,
      name: item.name,
      sizeBytes: item.sizeBytes
    }
  }
  return { kind: item.kind, mode: 'url', url: item.url }
}
