import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * On-disk thumbnail cache: keyed by an arbitrary string (typically the
 * renderable src URL) hashed to sha1. Bytes are stored as JPEG; renderer
 * reconstructs a data URL on read.
 */
export class ThumbCache {
  private dir: string

  constructor(userDataDir: string) {
    this.dir = path.join(userDataDir, 'asset-thumbs')
    try {
      fs.mkdirSync(this.dir, { recursive: true })
    } catch {
      /* ignore */
    }
  }

  private fileFor(key: string): string {
    const hash = crypto.createHash('sha1').update(key).digest('hex')
    return path.join(this.dir, `${hash}.jpg`)
  }

  async get(key: string): Promise<string | null> {
    try {
      const buf = await fs.promises.readFile(this.fileFor(key))
      return `data:image/jpeg;base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  }

  async put(key: string, dataUrl: string): Promise<void> {
    const m = /^data:image\/[a-z]+;base64,(.+)$/i.exec(dataUrl)
    if (!m) return
    const buf = Buffer.from(m[1], 'base64')
    if (buf.byteLength === 0) return
    try {
      await fs.promises.writeFile(this.fileFor(key), buf)
    } catch (err) {
      console.warn('[thumbcache] write failed:', (err as Error).message)
    }
  }

  async clear(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.dir)
      await Promise.all(
        files
          .filter((f) => f.endsWith('.jpg'))
          .map((f) => fs.promises.unlink(path.join(this.dir, f)).catch(() => {}))
      )
    } catch {
      /* ignore */
    }
  }
}
