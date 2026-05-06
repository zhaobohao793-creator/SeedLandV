import type { AssetKind, AssetSource, LibraryItem } from '@shared/types'

/** Build a renderable URL for a local file using the seedasset:// scheme. */
export function localFileSrc(absPath: string): string {
  // Encode every path segment but keep separators; also handle Windows drive
  // letters by normalising backslashes to forward slashes first.
  const normalised = absPath.replace(/\\/g, '/')
  return `seedasset://local/${encodeURIComponent(normalised)}`
}

export function assetSrc(asset: AssetSource): string {
  return asset.mode === 'url' ? asset.url : localFileSrc(asset.path)
}

export function librarySrc(item: LibraryItem): string {
  return item.mode === 'url' ? item.url : localFileSrc(item.path)
}

/** Whether this kind has a meaningful visual thumbnail. */
export function hasThumbnail(kind: AssetKind): boolean {
  return kind === 'image' || kind === 'video'
}
