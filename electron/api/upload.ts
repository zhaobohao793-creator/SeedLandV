/**
 * Server-proxied asset upload. Renderer ships local files as `mode: 'local'`;
 * main process resolves them to `asset_token`s here, immediately before /v1/tasks.
 *
 * Phase 4 keeps it simple: load file into a Buffer (size-capped) and post a
 * single multipart request. Phase 6 can switch to streaming + progress.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AssetKind } from '@shared/types'
import type { Http } from './http'

interface AssetUploadResponse {
  asset_token: string
  kind: AssetKind
  mime: string
  size_bytes: number
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac'
}

function guessMime(filePath: string, kind: AssetKind): string {
  const ext = path.extname(filePath).toLowerCase()
  const mime = MIME_BY_EXT[ext]
  if (mime) return mime
  // Fall back to a kind-correct generic — server validates by `kind/` prefix.
  return kind === 'image'
    ? 'application/octet-stream'
    : kind === 'video'
      ? 'video/mp4'
      : 'audio/mpeg'
}

export class AssetUploader {
  constructor(private http: Http) {}

  /** Upload one local file to /v1/assets, returning the opaque token. */
  async uploadFile(filePath: string, kind: AssetKind): Promise<AssetUploadResponse> {
    const buf = await fs.promises.readFile(filePath)
    const mime = guessMime(filePath, kind)
    const form = new FormData()
    form.append('kind', kind)
    // FormData in Node 20 supports Blob; this avoids streaming complexity for v1.
    form.append('file', new Blob([buf], { type: mime }), path.basename(filePath))

    return await this.http.request<AssetUploadResponse>('/v1/assets', {
      method: 'POST',
      body: form
      // No Content-Type header — fetch fills in multipart boundary.
    })
  }
}
