import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef
} from 'react'
import type { AssetKind } from '@shared/types'

export interface ChipMeta {
  label: string
  kind: AssetKind
  src?: string
}

export interface MentionState {
  query: string
  rect: DOMRect
}

export interface ChipEditorHandle {
  insertText: (text: string) => void
  insertChip: (chip: ChipMeta) => void
  /** Replace the open @-trigger range (from "@" to caret) with a chip. */
  commitMention: (chip: ChipMeta) => void
  focus: () => void
}

interface Props {
  value: string
  onChange: (v: string) => void
  /** Resolve a mention label to ChipMeta for parsing. Return null = treat as plain text. */
  resolveMention: (label: string) => ChipMeta | null
  /** All recognised mention labels — used by the parser to find chip boundaries. */
  mentionLabels: string[]
  /** Notified whenever the @-trigger state changes. null = no popover. */
  onMentionStateChange: (state: MentionState | null) => void
  /** Optional intercept for keys; return true to swallow (preventDefault). */
  onSpecialKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => boolean
  placeholder?: string
  minRows?: number
  className?: string
}

const ChipEditor = forwardRef<ChipEditorHandle, Props>(function ChipEditor(props, ref) {
  const {
    value,
    onChange,
    resolveMention,
    mentionLabels,
    onMentionStateChange,
    onSpecialKeyDown,
    placeholder,
    minRows = 4,
    className
  } = props
  const rootRef = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const lastValue = useRef('')
  // Stash for commitMention — set by detectMention when an @-token is active.
  const mentionAnchor = useRef<{ node: Node; start: number; end: number } | null>(null)

  // Sync DOM from external value when it differs from the live serialization.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const cur = serialize(root)
    if (cur === value) {
      lastValue.current = value
      updateEmptyAttr(root)
      return
    }
    lastValue.current = value
    renderInto(root, value, resolveMention, mentionLabels)
    updateEmptyAttr(root)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const fireChange = () => {
    const root = rootRef.current
    if (!root) return
    const v = serialize(root)
    updateEmptyAttr(root)
    if (v !== lastValue.current) {
      lastValue.current = v
      onChange(v)
    }
  }

  const detectMention = () => {
    const root = rootRef.current
    if (!root) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) {
      mentionAnchor.current = null
      onMentionStateChange(null)
      return
    }
    const range = sel.getRangeAt(0)
    if (!range.collapsed || !root.contains(range.startContainer)) {
      mentionAnchor.current = null
      onMentionStateChange(null)
      return
    }
    const node = range.startContainer
    if (node.nodeType !== Node.TEXT_NODE) {
      mentionAnchor.current = null
      onMentionStateChange(null)
      return
    }
    const text = (node.nodeValue ?? '')
    const offset = range.startOffset
    let i = offset - 1
    while (i >= 0) {
      const ch = text[i]
      if (ch === '@') break
      if (ch === ' ' || ch === '\n' || ch === '\t') {
        mentionAnchor.current = null
        onMentionStateChange(null)
        return
      }
      i--
    }
    if (i < 0) {
      mentionAnchor.current = null
      onMentionStateChange(null)
      return
    }
    const prev = i > 0 ? text[i - 1] : ''
    if (prev && /[\w一-鿿]/.test(prev)) {
      mentionAnchor.current = null
      onMentionStateChange(null)
      return
    }
    const query = text.slice(i + 1, offset)
    mentionAnchor.current = { node, start: i, end: offset }
    // Caret rect: collapse a temporary range at the caret position to read its rect.
    const probe = document.createRange()
    probe.setStart(node, offset)
    probe.collapse(true)
    let rect = probe.getBoundingClientRect()
    // Empty-text-node ranges return zero-sized rects; fall back to root.
    if (rect.width === 0 && rect.height === 0) {
      rect = root.getBoundingClientRect()
    }
    onMentionStateChange({ query, rect })
  }

  const handleInput = () => {
    if (composing.current) return
    fireChange()
    detectMention()
  }

  const insertNodeAtCaret = (...nodes: Node[]) => {
    const sel = window.getSelection()
    const root = rootRef.current
    if (!sel || !root) return
    let range: Range
    if (sel.rangeCount > 0 && root.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0)
      range.deleteContents()
    } else {
      range = document.createRange()
      range.selectNodeContents(root)
      range.collapse(false)
    }
    const frag = document.createDocumentFragment()
    nodes.forEach((n) => frag.appendChild(n))
    const last = frag.lastChild
    range.insertNode(frag)
    if (last) {
      range.setStartAfter(last)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }

  const insertText = (text: string) => {
    const segs = parseSegments(text, resolveMention, mentionLabels)
    const nodes: Node[] = []
    for (const s of segs) {
      if (s.type === 'text') {
        // Preserve newlines via <br>.
        const parts = s.value.split('\n')
        parts.forEach((p, idx) => {
          if (p) nodes.push(document.createTextNode(p))
          if (idx < parts.length - 1) nodes.push(document.createElement('br'))
        })
      } else {
        nodes.push(makeChipElement(s.meta))
      }
    }
    insertNodeAtCaret(...nodes)
    fireChange()
    detectMention()
  }

  const insertChip = (chip: ChipMeta) => {
    const el = makeChipElement(chip)
    const space = document.createTextNode(' ')
    insertNodeAtCaret(el, space)
    mentionAnchor.current = null
    onMentionStateChange(null)
    fireChange()
  }

  const commitMention = (chip: ChipMeta) => {
    const anchor = mentionAnchor.current
    const root = rootRef.current
    if (!anchor || !root || !root.contains(anchor.node)) {
      insertChip(chip)
      return
    }
    const r = document.createRange()
    r.setStart(anchor.node, anchor.start)
    r.setEnd(anchor.node, anchor.end)
    r.deleteContents()
    const el = makeChipElement(chip)
    const space = document.createTextNode(' ')
    r.insertNode(space)
    r.insertNode(el)
    const sel = window.getSelection()
    if (sel) {
      const after = document.createRange()
      after.setStartAfter(space)
      after.collapse(true)
      sel.removeAllRanges()
      sel.addRange(after)
    }
    mentionAnchor.current = null
    onMentionStateChange(null)
    fireChange()
  }

  useImperativeHandle(
    ref,
    () => ({
      insertText,
      insertChip,
      commitMention,
      focus: () => rootRef.current?.focus()
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // Re-attach popover position when caret moves (no input — e.g. arrow keys).
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onKeyUp = () => {
      if (!composing.current) detectMention()
    }
    const onMouseUp = () => detectMention()
    root.addEventListener('keyup', onKeyUp)
    root.addEventListener('mouseup', onMouseUp)
    return () => {
      root.removeEventListener('keyup', onKeyUp)
      root.removeEventListener('mouseup', onMouseUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={rootRef}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      data-placeholder={placeholder ?? ''}
      onInput={handleInput}
      onCompositionStart={() => {
        composing.current = true
      }}
      onCompositionEnd={() => {
        composing.current = false
        handleInput()
      }}
      onKeyDown={(e) => {
        if (onSpecialKeyDown?.(e)) {
          e.preventDefault()
        }
      }}
      onPaste={(e) => {
        e.preventDefault()
        const t = e.clipboardData.getData('text/plain')
        if (t) insertText(t)
      }}
      onBlur={() => {
        // Defer so a click on the popover (handled via mousedown/preventDefault) wins.
        setTimeout(() => onMentionStateChange(null), 100)
      }}
      className={`chip-editor ${className ?? ''}`}
      style={{ minHeight: `${minRows * 1.6}em` }}
    />
  )
})

export default ChipEditor

// ---------------- helpers ----------------

interface Segment {
  type: 'text' | 'chip'
  value: string
  meta?: ChipMeta
}

export function parseSegments(
  text: string,
  resolveMention: (label: string) => ChipMeta | null,
  mentionLabels: string[]
): { type: 'text'; value: string }[] | { type: 'chip'; meta: ChipMeta; value: string }[] {
  const sortedLabels = [...mentionLabels].sort((a, b) => b.length - a.length)
  const out: Segment[] = []
  let buf = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '@') {
      let matched: string | null = null
      for (const label of sortedLabels) {
        if (text.startsWith(label, i + 1)) {
          matched = label
          break
        }
      }
      if (matched) {
        const meta = resolveMention(matched)
        if (meta) {
          if (buf) {
            out.push({ type: 'text', value: buf })
            buf = ''
          }
          out.push({ type: 'chip', value: matched, meta })
          i += 1 + matched.length
          continue
        }
      }
    }
    buf += text[i]
    i++
  }
  if (buf) out.push({ type: 'text', value: buf })
  // The caller does narrowing via discriminated union — return as plain Segment[].
  // (Loose return type to keep the call-site simple.)
  return out as never
}

function makeChipElement(meta: ChipMeta): HTMLElement {
  const el = document.createElement('span')
  el.className = 'mention-chip'
  el.contentEditable = 'false'
  el.dataset.label = meta.label
  el.dataset.kind = meta.kind
  if (meta.src) el.dataset.src = meta.src
  el.setAttribute('role', 'img')
  el.setAttribute('aria-label', `@${meta.label}`)
  // thumbnail
  const thumb = document.createElement('span')
  thumb.className = 'mention-chip-thumb'
  if (meta.src && meta.kind === 'image') {
    const img = document.createElement('img')
    img.src = meta.src
    img.alt = ''
    img.draggable = false
    img.onerror = () => {
      img.remove()
      thumb.appendChild(makeKindGlyph(meta.kind))
    }
    thumb.appendChild(img)
  } else if (meta.src && meta.kind === 'video') {
    const v = document.createElement('video')
    v.src = meta.src
    v.muted = true
    v.playsInline = true
    v.preload = 'metadata'
    v.onloadedmetadata = () => {
      try {
        v.currentTime = 0.1
      } catch {
        /* ignore */
      }
    }
    v.onerror = () => {
      v.remove()
      thumb.appendChild(makeKindGlyph(meta.kind))
    }
    thumb.appendChild(v)
  } else {
    thumb.appendChild(makeKindGlyph(meta.kind))
  }
  el.appendChild(thumb)
  const label = document.createElement('span')
  label.className = 'mention-chip-label'
  label.textContent = meta.label
  el.appendChild(label)
  return el
}

function makeKindGlyph(kind: AssetKind): SVGElement {
  // Tiny lucide-style glyph — image: square+circle, video: triangle, audio: notes.
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  if (kind === 'image') {
    addPath(svg, 'M3 5h18v14H3z')
    addPath(svg, 'M3 17l5-5 4 4 3-3 6 6')
  } else if (kind === 'video') {
    addPath(svg, 'M8 5l11 7-11 7z')
  } else {
    addPath(svg, 'M9 18V5l12-2v13')
    addPath(svg, 'M6 18a3 3 0 1 0 0 .01')
    addPath(svg, 'M18 16a3 3 0 1 0 0 .01')
  }
  return svg
}

function addPath(svg: SVGElement, d: string) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('d', d)
  svg.appendChild(p)
}

function serialize(root: HTMLElement): string {
  let out = ''
  walk(root, 0)
  return out
  function walk(n: Node, depth: number) {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.nodeValue ?? ''
      return
    }
    if (!(n instanceof HTMLElement)) return
    if (n.tagName === 'BR') {
      out += '\n'
      return
    }
    if (n.classList.contains('mention-chip')) {
      out += '@' + (n.dataset.label ?? '')
      return
    }
    const block = depth > 0 && (n.tagName === 'DIV' || n.tagName === 'P')
    if (block && out && !out.endsWith('\n')) out += '\n'
    for (const c of Array.from(n.childNodes)) walk(c, depth + 1)
  }
}

function renderInto(
  root: HTMLElement,
  text: string,
  resolveMention: (label: string) => ChipMeta | null,
  mentionLabels: string[]
) {
  root.innerHTML = ''
  const segs = parseSegments(text, resolveMention, mentionLabels) as unknown as Segment[]
  for (const s of segs) {
    if (s.type === 'chip' && s.meta) {
      root.appendChild(makeChipElement(s.meta))
    } else if (s.type === 'text') {
      const parts = s.value.split('\n')
      parts.forEach((p, idx) => {
        if (p) root.appendChild(document.createTextNode(p))
        if (idx < parts.length - 1) root.appendChild(document.createElement('br'))
      })
    }
  }
}

function updateEmptyAttr(root: HTMLElement) {
  const isEmpty =
    root.textContent === '' && root.querySelector('.mention-chip') === null
  if (isEmpty) root.dataset.empty = 'true'
  else delete root.dataset.empty
}
