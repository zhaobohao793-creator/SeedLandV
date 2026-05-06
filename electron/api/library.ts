import fs from 'node:fs'
import path from 'node:path'
import type { AddLibraryInput, LibraryItem } from '@shared/types'

export class LibraryStore {
  private file: string
  private items: LibraryItem[] = []
  private loaded = false

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'asset-library.json')
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8')
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed?.items)) {
          this.items = parsed.items.filter((x: unknown) => isLibraryItem(x))
        }
      }
    } catch (err) {
      console.warn('[library] failed to read store, starting empty:', (err as Error).message)
      this.items = []
    }
    this.loaded = true
  }

  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({ items: this.items }, null, 2), 'utf8')
    } catch (err) {
      console.warn('[library] failed to persist store:', (err as Error).message)
    }
  }

  list(): LibraryItem[] {
    this.ensureLoaded()
    return this.items.slice().sort((a, b) => b.addedAt - a.addedAt)
  }

  add(input: AddLibraryInput): LibraryItem {
    this.ensureLoaded()
    const id = `lib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const addedAt = Date.now()
    const src = input.source
    let item: LibraryItem
    if (src.mode === 'local') {
      const name = (input.name?.trim() || src.name || path.basename(src.path)).slice(0, 80)
      item = {
        id,
        kind: input.kind,
        mode: 'local',
        path: src.path,
        name,
        sizeBytes: src.sizeBytes ?? 0,
        addedAt
      }
    } else {
      const fallback = src.url.split('/').pop() || src.url
      const name = (input.name?.trim() || fallback).slice(0, 80)
      item = { id, kind: input.kind, mode: 'url', url: src.url, name, addedAt }
    }
    // Skip exact duplicates: same kind + same path/url.
    const dup = this.items.find((x) => sameSource(x, item))
    if (dup) return dup
    this.items.unshift(item)
    this.flush()
    return item
  }

  remove(id: string): void {
    this.ensureLoaded()
    const before = this.items.length
    this.items = this.items.filter((x) => x.id !== id)
    if (this.items.length !== before) this.flush()
  }

  rename(id: string, name: string): LibraryItem | null {
    this.ensureLoaded()
    const idx = this.items.findIndex((x) => x.id === id)
    if (idx === -1) return null
    const trimmed = name.trim().slice(0, 80) || this.items[idx].name
    this.items[idx] = { ...this.items[idx], name: trimmed }
    this.flush()
    return this.items[idx]
  }
}

function sameSource(a: LibraryItem, b: LibraryItem): boolean {
  if (a.kind !== b.kind || a.mode !== b.mode) return false
  if (a.mode === 'local' && b.mode === 'local') return a.path === b.path
  if (a.mode === 'url' && b.mode === 'url') return a.url === b.url
  return false
}

function isLibraryItem(x: unknown): x is LibraryItem {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return false
  if (o.kind !== 'image' && o.kind !== 'video' && o.kind !== 'audio') return false
  if (o.mode === 'local') return typeof o.path === 'string'
  if (o.mode === 'url') return typeof o.url === 'string'
  return false
}
