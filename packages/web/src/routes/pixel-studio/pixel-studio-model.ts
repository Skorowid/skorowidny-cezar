import type { PixelJob } from '@open-mercato/cezar-api-client'

/**
 * Pure logic of the Pixel Studio page (fork; docs/skorowidny-cezar/pixel-studio.md): reading the
 * Aseprite-style sheet JSON PixelForge writes, playing a tag, and the choices of the forms.
 *
 * Author: Skorowid
 */

export interface SheetFrame {
  x: number
  y: number
  w: number
  h: number
  duration: number
}

export interface SheetTag {
  name: string
  from: number
  to: number
  direction: 'forward' | 'reverse' | 'pingpong'
}

export interface Sheet {
  width: number
  height: number
  frames: SheetFrame[]
  tags: SheetTag[]
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Parse `out/sheet.json` (Aseprite json-array shape); anything malformed is dropped, never thrown. */
export function parseSheet(raw: unknown): Sheet | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { frames?: unknown; meta?: { size?: { w?: unknown; h?: unknown }; frameTags?: unknown } }
  if (!Array.isArray(r.frames)) return null
  const frames: SheetFrame[] = []
  for (const f of r.frames) {
    const rect = (f as { frame?: Record<string, unknown> })?.frame
    if (!rect) continue
    frames.push({ x: num(rect.x), y: num(rect.y), w: num(rect.w), h: num(rect.h), duration: Math.max(10, num((f as { duration?: unknown }).duration, 100)) })
  }
  if (frames.length === 0) return null
  const tags: SheetTag[] = []
  if (Array.isArray(r.meta?.frameTags)) {
    for (const t of r.meta.frameTags as Array<Record<string, unknown>>) {
      const from = num(t.from, -1)
      const to = num(t.to, -1)
      if (typeof t.name !== 'string' || from < 0 || to < from || to >= frames.length) continue
      const direction = t.direction === 'reverse' || t.direction === 'pingpong' ? t.direction : 'forward'
      tags.push({ name: t.name, from, to, direction })
    }
  }
  return { width: num(r.meta?.size?.w), height: num(r.meta?.size?.h), frames, tags }
}

/** Frame indices to play for a tag (null = every frame, forward). */
export function tagSequence(sheet: Sheet, tagName: string | null): number[] {
  const tag = tagName ? sheet.tags.find((t) => t.name === tagName) : undefined
  const from = tag?.from ?? 0
  const to = tag?.to ?? sheet.frames.length - 1
  const forward = Array.from({ length: to - from + 1 }, (_, i) => from + i)
  if (tag?.direction === 'reverse') return forward.reverse()
  if (tag?.direction === 'pingpong' && forward.length > 2) return [...forward, ...forward.slice(1, -1).reverse()]
  return forward
}

/** Which frame of a looping sequence shows at `elapsedMs`. */
export function frameAt(sheet: Sheet, sequence: readonly number[], elapsedMs: number): number {
  if (sequence.length === 0) return 0
  const total = sequence.reduce((sum, i) => sum + (sheet.frames[i]?.duration ?? 100), 0)
  let t = ((elapsedMs % total) + total) % total
  for (const i of sequence) {
    const d = sheet.frames[i]?.duration ?? 100
    if (t < d) return i
    t -= d
  }
  return sequence[sequence.length - 1] ?? 0
}

export const TOOL_LABEL: Record<PixelJob['tool'], string> = {
  character8: '8 directions',
  animate: 'Animation',
  tileset: 'Tileset',
  image: 'Scene / map / object',
  ui: 'UI elements',
  edit: 'Edit / inpaint',
}

export const DIRECTIONS8 = ['south', 'south-west', 'west', 'north-west', 'north', 'north-east', 'east', 'south-east'] as const

export function isBusy(job: Pick<PixelJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'generating' || job.status === 'processing'
}

/** Frames of finished jobs usable as an animation reference: `<jobId>/<frame path>`. */
export function referenceOptions(jobs: readonly PixelJob[]): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = []
  for (const job of jobs) {
    if (job.status !== 'done' || job.tool !== 'character8') continue
    const desc = typeof job.params.description === 'string' ? job.params.description.slice(0, 40) : job.id
    ;(job.outputs.frames ?? []).forEach((frame, i) => {
      out.push({ value: `${job.id}/${frame}`, label: `${desc} — ${DIRECTIONS8[i] ?? `frame ${i + 1}`}` })
    })
  }
  return out
}

/** QA metrics worth showing, in a stable order. */
export function qaSummary(qa: Record<string, unknown>): Array<[string, string]> {
  const keys = ['frames', 'tiles', 'colors', 'anchor_spread_px', 'height_spread_px', 'seam_errors_after', 'pitch']
  return keys.filter((k) => qa[k] !== undefined).map((k) => [k.replace(/_/g, ' '), String(qa[k])])
}

export const PALETTES = ['endesga-32', 'resurrect-64', 'sweetie-16', 'pico-8', 'apollo'] as const

/** Every frame of every finished job, usable as the image to edit: `<jobId>/<frame path>`. */
export function editSourceOptions(jobs: readonly PixelJob[]): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = []
  for (const job of jobs) {
    if (job.status !== 'done') continue
    const desc = typeof job.params.description === 'string' ? job.params.description.slice(0, 32) : TOOL_LABEL[job.tool]
    ;(job.outputs.frames ?? []).forEach((frame, i) => {
      const label = job.tool === 'character8' ? DIRECTIONS8[i] ?? `frame ${i + 1}` : `frame ${i + 1}`
      out.push({ value: `${job.id}/${frame}`, label: `${desc} — ${label}` })
    })
  }
  return out
}

/** UI items typed one per line. */
export function parseItems(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 16)
}
