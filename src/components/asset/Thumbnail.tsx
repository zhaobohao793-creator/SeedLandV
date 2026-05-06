import { useEffect, useState } from 'react'
import { Film, Image as ImageIcon, Music } from 'lucide-react'
import type { AssetKind } from '@shared/types'
import { cn } from '@/lib/cn'
import {
  extractVideoFrame,
  getCachedThumb,
  loadThumb,
  saveThumb,
  wasExtracted
} from '@/lib/thumbCache'

interface Props {
  kind: AssetKind
  /** Renderable URL — http(s) or seedasset:// (built via lib/assetUrl). */
  src?: string
  /** Tailwind size class, e.g. "h-8 w-8". */
  className?: string
  /** Inner icon size class for the fallback icon, e.g. "h-4 w-4". */
  iconClassName?: string
  /** Square corner radius — match surrounding chip/card. */
  rounded?: 'sm' | 'md' | 'lg'
}

const KIND_ICON: Record<AssetKind, typeof ImageIcon> = {
  image: ImageIcon,
  video: Film,
  audio: Music
}

const ROUND: Record<NonNullable<Props['rounded']>, string> = {
  sm: 'rounded-md',
  md: 'rounded-lg',
  lg: 'rounded-xl'
}

export default function Thumbnail({
  kind,
  src,
  className = 'h-8 w-8',
  iconClassName = 'h-4 w-4',
  rounded = 'sm'
}: Props) {
  const Icon = KIND_ICON[kind]
  const [errored, setErrored] = useState(false)
  // For videos: prefer a cached extracted frame (sync hit) over rendering the
  // <video> element. Async hits update via useEffect.
  const [cachedFrame, setCachedFrame] = useState<string | null>(() =>
    src && kind === 'video' ? getCachedThumb(src) : null
  )

  useEffect(() => {
    setErrored(false)
    if (!src || kind !== 'video') {
      setCachedFrame(null)
      return
    }
    const sync = getCachedThumb(src)
    if (sync) {
      setCachedFrame(sync)
      return
    }
    let alive = true
    loadThumb(src).then((d) => {
      if (alive && d) setCachedFrame(d)
    })
    return () => {
      alive = false
    }
  }, [src, kind])

  const showCachedVideoFrame = !!src && !errored && kind === 'video' && !!cachedFrame
  const showLiveVideo = !!src && !errored && kind === 'video' && !cachedFrame
  const showImage = !!src && !errored && kind === 'image'
  const showFallback = !showCachedVideoFrame && !showLiveVideo && !showImage

  const onSeeked = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!src || cachedFrame || wasExtracted(src)) return
    const frame = extractVideoFrame(e.currentTarget)
    if (frame) {
      saveThumb(src, frame)
      setCachedFrame(frame)
    }
  }

  return (
    <div
      className={cn(
        'relative shrink-0 overflow-hidden bg-[rgba(0,229,255,0.08)] text-neon-cyan',
        ROUND[rounded],
        className
      )}
    >
      {showImage && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setErrored(true)}
          className="h-full w-full object-cover"
        />
      )}
      {showCachedVideoFrame && (
        <img
          src={cachedFrame ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      )}
      {showLiveVideo && (
        <video
          src={src}
          muted
          playsInline
          preload="metadata"
          crossOrigin="anonymous"
          onLoadedMetadata={(e) => {
            try {
              e.currentTarget.currentTime = 0.1
            } catch {
              /* ignore */
            }
          }}
          onSeeked={onSeeked}
          onError={() => setErrored(true)}
          className="h-full w-full object-cover"
        />
      )}
      {showFallback && (
        <div className="flex h-full w-full items-center justify-center">
          <Icon className={iconClassName} />
        </div>
      )}
    </div>
  )
}
