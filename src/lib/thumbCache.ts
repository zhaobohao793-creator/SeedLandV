/**
 * Renderer-side thumbnail cache. Wraps the main-process disk cache with an
 * in-memory layer + per-key promise dedup so concurrent components don't
 * race the IPC.
 */

const memory = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()
/** Tracks which keys we've extracted in this session, to avoid re-extracting. */
const extracted = new Set<string>()

/** Sync read — null if not in memory yet. */
export function getCachedThumb(key: string): string | null {
  return memory.get(key) ?? null
}

/** Async read: memory → IPC. Result is also pinned to memory. */
export async function loadThumb(key: string): Promise<string | null> {
  const hit = memory.get(key)
  if (hit !== undefined) return hit
  const pending = inflight.get(key)
  if (pending) return pending
  const promise = window.seedland
    .getThumb(key)
    .then((res) => {
      if (res) memory.set(key, res)
      inflight.delete(key)
      return res
    })
    .catch((err) => {
      console.warn('[thumbCache] read failed', err)
      inflight.delete(key)
      return null
    })
  inflight.set(key, promise)
  return promise
}

/** Persist a freshly extracted thumbnail (memory + disk). */
export function saveThumb(key: string, dataUrl: string): void {
  memory.set(key, dataUrl)
  extracted.add(key)
  void window.seedland.putThumb(key, dataUrl).catch((err) => {
    console.warn('[thumbCache] write failed', err)
  })
}

export function markExtracted(key: string): void {
  extracted.add(key)
}

export function wasExtracted(key: string): boolean {
  return extracted.has(key)
}

/**
 * Extract a canvas-rendered JPEG dataURL from a video element. Returns null
 * when the canvas is tainted (cross-origin without CORS) or the video has no
 * dimensions yet.
 */
export function extractVideoFrame(
  video: HTMLVideoElement,
  maxWidth = 256,
  quality = 0.7
): string | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null
  const w = Math.min(maxWidth, vw)
  const h = Math.max(1, Math.round(w * (vh / vw)))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  try {
    ctx.drawImage(video, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return null
  }
}
