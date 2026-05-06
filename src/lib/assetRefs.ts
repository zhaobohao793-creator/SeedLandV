import type { AssetKind, AssetSource, GenerationMode } from '@shared/types'

const KIND_PREFIX: Record<AssetKind, string> = {
  image: '图',
  video: '视频',
  audio: '音频'
}

/**
 * Per-kind index label for an asset chip ("图1", "视频2", ...).
 * `orderedLabels` (e.g. ["首帧","尾帧"]) takes precedence when supplied.
 */
export function labelForAsset(
  assets: AssetSource[],
  index: number,
  orderedLabels?: string[]
): string {
  if (orderedLabels && orderedLabels[index]) return orderedLabels[index]
  const a = assets[index]
  if (!a) return ''
  let n = 0
  for (let i = 0; i <= index; i++) if (assets[i].kind === a.kind) n++
  return `${KIND_PREFIX[a.kind]}${n}`
}

const ALLOWED_KINDS: Record<GenerationMode, AssetKind[]> = {
  'text-to-video': [],
  'image-to-video': ['image'],
  'first-last-frame': ['image'],
  'multi-reference': ['image', 'video', 'audio']
}

export function allowedKindsOf(mode: GenerationMode): AssetKind[] {
  return ALLOWED_KINDS[mode]
}

/**
 * Tiny module-level registry so AssetPicker / library popover can ask the
 * active PromptPanel to mutate at the current caret. We only ever have one
 * prompt input visible per mode, so a single slot is enough.
 */
type Inserter = {
  mode: GenerationMode
  insertMention: (label: string) => void
}
let active: Inserter | null = null

export function registerPromptInserter(entry: Inserter): () => void {
  active = entry
  return () => {
    if (active === entry) active = null
  }
}

export function insertMention(mode: GenerationMode, label: string): boolean {
  if (active && active.mode === mode) {
    active.insertMention(label)
    return true
  }
  return false
}
