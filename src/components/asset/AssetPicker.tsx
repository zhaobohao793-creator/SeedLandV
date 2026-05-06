import { useEffect, useMemo, useState, type DragEvent } from 'react'
import {
  AtSign,
  BookmarkPlus,
  Film,
  Image as ImageIcon,
  Library,
  Link2,
  Music,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import type {
  AssetKind,
  AssetSource,
  GenerationMode,
  LibraryItem
} from '@shared/types'
import { useAppStore } from '@/lib/store'
import { cn } from '@/lib/cn'
import { insertMention, labelForAsset } from '@/lib/assetRefs'
import { assetSrc, librarySrc } from '@/lib/assetUrl'
import Thumbnail from './Thumbnail'

interface Props {
  mode: GenerationMode
  kinds: AssetKind[]
  max?: number
  hint?: string
  orderedLabels?: string[]
}

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif']
const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'mkv']
const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac']

const KIND_LABEL: Record<AssetKind, string> = { image: '图片', video: '视频', audio: '音频' }
const KIND_ICON: Record<AssetKind, typeof ImageIcon> = {
  image: ImageIcon,
  video: Film,
  audio: Music
}

type Tab = 'local' | 'url' | 'library'

export default function AssetPicker({ mode, kinds, max, hint, orderedLabels }: Props) {
  const assets = useAppStore((s) => s.forms[mode].assets)
  const addAsset = useAppStore((s) => s.addAsset)
  const removeAsset = useAppStore((s) => s.removeAsset)
  const library = useAppStore((s) => s.library)
  const upsertLibraryItem = useAppStore((s) => s.upsertLibraryItem)
  const removeLibraryItem = useAppStore((s) => s.removeLibraryItem)

  const extsOf = (kind: AssetKind): string[] =>
    kind === 'image' ? IMAGE_EXTS : kind === 'video' ? VIDEO_EXTS : AUDIO_EXTS
  const extsHint = (kind: AssetKind) => extsOf(kind).map((e) => `.${e}`).join(',')

  const [tab, setTab] = useState<Tab>('local')
  const [selectedKind, setSelectedKind] = useState<AssetKind>(kinds[0])
  const [urlInput, setUrlInput] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const atLimit = typeof max === 'number' && assets.length >= max

  const handlePick = async () => {
    if (atLimit) return
    const res = await window.seedland.pickFile(selectedKind, extsOf(selectedKind))
    if (res) {
      addAsset(mode, { kind: selectedKind, mode: 'local', ...res })
    }
  }

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (atLimit) return
    const files = Array.from(e.dataTransfer.files)
    for (const f of files) {
      const kind = detectKind(f.name)
      if (!kind || !kinds.includes(kind)) continue
      const p = window.seedland.getDroppedPath(f)
      if (!p) continue
      addAsset(mode, {
        kind,
        mode: 'local',
        path: p,
        name: f.name,
        sizeBytes: f.size
      })
      if (max && assets.length + 1 >= max) break
    }
  }

  const addUrl = () => {
    const v = urlInput.trim()
    if (!/^https?:\/\//i.test(v)) return
    addAsset(mode, { kind: selectedKind, mode: 'url', url: v })
    setUrlInput('')
  }

  const addFromLibrary = (item: LibraryItem) => {
    if (atLimit) return
    if (!kinds.includes(item.kind)) return
    const src: AssetSource =
      item.mode === 'local'
        ? {
            kind: item.kind,
            mode: 'local',
            path: item.path,
            name: item.name,
            sizeBytes: item.sizeBytes
          }
        : { kind: item.kind, mode: 'url', url: item.url }
    addAsset(mode, src)
    const nextIndex = assets.length
    const label = labelForAsset([...assets, src], nextIndex, orderedLabels)
    insertMention(mode, label)
  }

  const saveToLibrary = async (asset: AssetSource) => {
    const out = await window.seedland.addToLibrary({
      kind: asset.kind,
      source: asset
    })
    upsertLibraryItem(out)
  }

  const removeFromLibrary = async (id: string) => {
    await window.seedland.removeFromLibrary(id)
    removeLibraryItem(id)
  }

  const handleChipClick = (i: number) => {
    const label = labelForAsset(assets, i, orderedLabels)
    insertMention(mode, label)
  }

  const visibleLibrary = useMemo(
    () => library.filter((x) => kinds.includes(x.kind)),
    [library, kinds]
  )

  return (
    <section className="glass rounded-2xl p-5">
      <div className="mb-3 flex items-center justify-between">
        <label className="field-label !mb-0">素材</label>
        {hint && <span className="text-[11px] text-text-dim">{hint}</span>}
      </div>

      {kinds.length > 1 && (
        <div className="mb-3 inline-flex rounded-lg bg-[rgba(7,11,20,0.5)] p-1 border border-[rgba(138,148,184,0.1)]">
          {kinds.map((k) => {
            const Icon = KIND_ICON[k]
            const label = KIND_LABEL[k]
            const active = selectedKind === k
            return (
              <button
                key={k}
                onClick={() => setSelectedKind(k)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  active
                    ? 'bg-[rgba(0,229,255,0.1)] text-neon-cyan'
                    : 'text-text-muted hover:text-text'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            )
          })}
        </div>
      )}

      <div className="mb-3 flex gap-1 rounded-lg bg-[rgba(7,11,20,0.5)] p-1 border border-[rgba(138,148,184,0.1)] w-fit">
        <TabButton active={tab === 'local'} onClick={() => setTab('local')} icon={Upload}>
          本地上传
        </TabButton>
        <TabButton active={tab === 'url'} onClick={() => setTab('url')} icon={Link2}>
          URL
        </TabButton>
        <TabButton
          active={tab === 'library'}
          onClick={() => setTab('library')}
          icon={Library}
        >
          资产库
          {visibleLibrary.length > 0 && (
            <span className="ml-1 rounded bg-[rgba(0,229,255,0.15)] px-1 text-[10px] font-mono text-neon-cyan">
              {visibleLibrary.length}
            </span>
          )}
        </TabButton>
      </div>

      {tab === 'local' && (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={handlePick}
          className={cn(
            'group relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 transition-all',
            dragOver
              ? 'border-neon-cyan bg-[rgba(0,229,255,0.06)]'
              : 'border-[rgba(138,148,184,0.18)] hover:border-[rgba(0,229,255,0.35)] hover:bg-[rgba(0,229,255,0.02)]',
            atLimit && 'pointer-events-none opacity-50'
          )}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgba(0,229,255,0.08)] text-neon-cyan group-hover:bg-[rgba(0,229,255,0.14)]">
            <Upload className="h-5 w-5" />
          </div>
          <div className="mt-3 text-sm text-text">
            拖拽 <span className="text-neon-cyan">{KIND_LABEL[selectedKind]}</span> 到这里，或点击选择
          </div>
          <div className="mt-1 font-mono text-[11px] text-text-dim">{extsHint(selectedKind)}</div>
        </div>
      )}

      {tab === 'url' && (
        <div className="flex gap-2">
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addUrl()}
            placeholder={`https://example.com/your-${selectedKind}.${
              selectedKind === 'image' ? 'jpg' : selectedKind === 'video' ? 'mp4' : 'mp3'
            }`}
            className="input-base flex-1"
          />
          <button onClick={addUrl} className="btn-ghost" disabled={atLimit}>
            添加
          </button>
        </div>
      )}

      {tab === 'library' && (
        <LibraryGrid
          items={visibleLibrary}
          atLimit={atLimit}
          onPick={addFromLibrary}
          onRemove={removeFromLibrary}
        />
      )}

      {assets.length > 0 && (
        <div className="mt-4 space-y-2">
          {assets.map((a, i) => (
            <AssetChip
              key={i}
              asset={a}
              label={labelForAsset(assets, i, orderedLabels)}
              onClick={() => handleChipClick(i)}
              onSave={() => saveToLibrary(a)}
              onRemove={() => removeAsset(mode, i)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children
}: {
  active: boolean
  onClick: () => void
  icon: typeof ImageIcon
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
        active ? 'bg-[rgba(0,229,255,0.1)] text-neon-cyan' : 'text-text-muted hover:text-text'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  )
}

function LibraryGrid({
  items,
  atLimit,
  onPick,
  onRemove
}: {
  items: LibraryItem[]
  atLimit: boolean
  onPick: (item: LibraryItem) => void
  onRemove: (id: string) => void
}) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[rgba(138,148,184,0.18)] px-6 py-8 text-center">
        <Library className="h-5 w-5 text-text-dim" />
        <div className="mt-2 text-sm text-text-muted">资产库还是空的</div>
        <div className="mt-1 text-[11px] text-text-dim">
          上传素材后点击 <BookmarkPlus className="inline h-3 w-3" /> 即可保存到资产库，下次直接复用
        </div>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            'group relative overflow-hidden rounded-lg border border-[rgba(138,148,184,0.1)] bg-[rgba(7,11,20,0.4)] transition-all',
            atLimit
              ? 'opacity-50'
              : 'hover:border-[rgba(0,229,255,0.3)] hover:shadow-[0_0_0_1px_rgba(0,229,255,0.18)]'
          )}
        >
          <button
            onClick={() => onPick(item)}
            disabled={atLimit}
            className="flex w-full flex-col text-left disabled:cursor-not-allowed"
            title={item.mode === 'url' ? item.url : item.path}
          >
            <Thumbnail
              kind={item.kind}
              src={librarySrc(item)}
              className="aspect-square w-full"
              iconClassName="h-6 w-6"
              rounded="sm"
            />
            <div className="min-w-0 px-2 py-1.5">
              <div className="truncate text-xs text-text">{item.name}</div>
              <div className="truncate text-[10px] font-mono text-text-dim">
                {item.mode === 'url' ? 'URL' : '本地'}
              </div>
            </div>
          </button>
          <button
            onClick={() => onRemove(item.id)}
            className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-md bg-[rgba(7,11,20,0.7)] text-text-dim opacity-0 backdrop-blur-sm transition-all hover:bg-[rgba(244,63,94,0.2)] hover:text-neon-rose group-hover:opacity-100"
            title="从资产库移除"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )
}

function AssetChip({
  asset,
  label,
  onClick,
  onSave,
  onRemove
}: {
  asset: AssetSource
  label?: string
  onClick: () => void
  onSave: () => void
  onRemove: () => void
}) {
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (!saved) return
    const t = window.setTimeout(() => setSaved(false), 1200)
    return () => window.clearTimeout(t)
  }, [saved])

  const name = asset.mode === 'url' ? asset.url : asset.name
  const size = asset.mode === 'local' ? ` · ${formatSize(asset.sizeBytes)}` : ''
  return (
    <div
      onClick={onClick}
      className="group flex cursor-pointer items-center gap-3 rounded-lg border border-[rgba(138,148,184,0.1)] bg-[rgba(7,11,20,0.4)] px-3 py-2 transition-colors hover:border-[rgba(0,229,255,0.3)] hover:bg-[rgba(0,229,255,0.04)]"
      title="点击插入到提示词"
    >
      <Thumbnail
        kind={asset.kind}
        src={assetSrc(asset)}
        className="h-10 w-10"
        iconClassName="h-4 w-4"
        rounded="md"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {label && <span className="chip !px-1.5 !py-0.5 !text-[10px]">{label}</span>}
          <span className="truncate text-xs text-text">{name}</span>
          <AtSign className="h-3 w-3 shrink-0 text-text-dim opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
        <div className="text-[10px] font-mono text-text-dim">
          {asset.mode === 'url' ? 'URL' : '本地文件'}
          {size}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onSave()
          setSaved(true)
        }}
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
          saved
            ? 'bg-[rgba(0,229,255,0.12)] text-neon-cyan'
            : 'text-text-dim hover:bg-[rgba(0,229,255,0.08)] hover:text-neon-cyan'
        )}
        title={saved ? '已加入资产库' : '保存到资产库'}
      >
        <BookmarkPlus className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        className="flex h-7 w-7 items-center justify-center rounded-md text-text-dim hover:bg-[rgba(244,63,94,0.1)] hover:text-neon-rose transition-colors"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function detectKind(name: string): AssetKind | null {
  const ext = name.split('.').pop()?.toLowerCase()
  if (!ext) return null
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (AUDIO_EXTS.includes(ext)) return 'audio'
  return null
}

function formatSize(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}
