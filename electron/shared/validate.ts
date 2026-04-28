import type { AssetSource, GenerationMode } from './types'

const ORDER: Record<GenerationMode, string> = {
  'text-to-video': 'text-only',
  'image-to-video': 'text + image',
  'first-last-frame': 'text + first image + last image',
  'multi-reference': 'text + multi ref'
}

/** Throws on invalid combinations. Used by renderer pre-submit and main-side guard. */
export function validateByMode(mode: GenerationMode, assets: AssetSource[]): void {
  const imgs = assets.filter((a) => a.kind === 'image').length
  const vids = assets.filter((a) => a.kind === 'video').length
  const auds = assets.filter((a) => a.kind === 'audio').length

  if (imgs > 9) throw new Error('图片最多 9 张')
  if (vids > 3) throw new Error('视频参考最多 3 段')
  if (auds > 3) throw new Error('音频参考最多 3 段')

  if (mode === 'text-to-video' && (imgs || vids || auds)) {
    throw new Error(`文生视频不接受素材（当前 ${ORDER[mode]}）`)
  }
  if (mode === 'image-to-video' && imgs !== 1) {
    throw new Error('图生视频需要且仅需要 1 张参考图')
  }
  if (mode === 'first-last-frame' && imgs !== 2) {
    throw new Error('首尾帧需要 2 张图（首帧在前、尾帧在后）')
  }
}
