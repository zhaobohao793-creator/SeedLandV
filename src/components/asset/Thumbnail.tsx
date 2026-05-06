import { useState } from 'react'
import { Film, Image as ImageIcon, Music } from 'lucide-react'
import type { AssetKind } from '@shared/types'
import { cn } from '@/lib/cn'

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
  const showVisual = !!src && !errored && (kind === 'image' || kind === 'video')

  return (
    <div
      className={cn(
        'relative shrink-0 overflow-hidden bg-[rgba(0,229,255,0.08)] text-neon-cyan',
        ROUND[rounded],
        className
      )}
    >
      {showVisual && kind === 'image' && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setErrored(true)}
          className="h-full w-full object-cover"
        />
      )}
      {showVisual && kind === 'video' && (
        <video
          src={src}
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => {
            // Nudge to frame ~0.1s so most codecs paint a poster frame.
            try {
              e.currentTarget.currentTime = 0.1
            } catch {
              /* ignore */
            }
          }}
          onError={() => setErrored(true)}
          className="h-full w-full object-cover"
        />
      )}
      {!showVisual && (
        <div className="flex h-full w-full items-center justify-center">
          <Icon className={iconClassName} />
        </div>
      )}
    </div>
  )
}
