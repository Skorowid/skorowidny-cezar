import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DownloadIcon, GridIcon, PauseIcon, PlayIcon, RefreshCwIcon, SparklesIcon, UploadCloudIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'

import { collectPixelJob, createPixelJob, exportPixelJob, pixelJobFileUrl, reprocessPixelJob, syncPixelGpuQueue, uploadPixelImage } from '@/api/client'
import { queryKeys, usePixelGpuQueue, usePixelJobs } from '@/api/queries'
import type { CreatePixelJobInput, PixelJob } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

import {
  PALETTES,
  TOOL_LABEL,
  editSourceOptions,
  frameAt,
  isBusy,
  parseItems,
  parseSheet,
  qaSummary,
  referenceOptions,
  tagSequence,
  type Sheet,
} from './pixel-studio-model'

/**
 * `/pixel-studio` (fork; docs/skorowidny-cezar/pixel-studio.md) — the project's PixelForge library:
 * every 8-direction character, animation and tileset job with a pixel-exact player, the panel that
 * starts new jobs (Codex image_gen or the GPU cezar) and the GPU queue.
 *
 * Author: Skorowid
 */
type Tab = 'library' | 'generate' | 'gpu'

const CHECKER =
  'repeating-conic-gradient(var(--color-muted) 0% 25%, transparent 0% 50%) 50% / 16px 16px'

export function PixelStudioRoute() {
  const [tab, setTab] = useState<Tab>('library')
  const [selected, setSelected] = useState<string | null>(null)
  const jobs = usePixelJobs()
  return (
    <div data-route="pixel-studio" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Pixel Studio</h1>
        <p className="text-ui text-soft-foreground">PixelForge characters, animations and tilesets of this project.</p>
      </header>
      <div className="flex flex-1 flex-col gap-3 p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        <div role="tablist" aria-label="Pixel Studio" className="flex w-fit gap-0.5 rounded-lg bg-muted p-0.5">
          {(['library', 'generate', 'gpu'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={tab === t}
              data-slot={`pixel-tab-${t}`}
              onClick={() => setTab(t)}
              className={cn('rounded-md px-3 py-1 text-ui', tab === t ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground')}
            >
              {t === 'library' ? 'Library' : t === 'generate' ? 'Generate' : 'GPU queue'}
            </button>
          ))}
        </div>
        {jobs.isPending ? (
          <p className="py-6 text-center text-xs text-soft-foreground">Loading jobs…</p>
        ) : jobs.isError ? (
          <p role="alert" className="py-6 text-center text-xs text-destructive">
            Could not load Pixel Studio: {jobs.error instanceof Error ? jobs.error.message : String(jobs.error)}
          </p>
        ) : tab === 'library' ? (
          <Library jobs={jobs.data.jobs} problems={jobs.data.problems} selected={selected} onSelect={setSelected} />
        ) : tab === 'generate' ? (
          <Generate jobs={jobs.data.jobs} onStarted={(id) => { setSelected(id); setTab('library') }} />
        ) : (
          <GpuQueue />
        )}
      </div>
    </div>
  )
}

function statusTone(job: PixelJob) {
  if (job.status === 'done') return 'border-primary text-primary'
  if (job.status === 'failed') return 'border-destructive text-destructive'
  return undefined
}

function Library({ jobs, problems, selected, onSelect }: { jobs: PixelJob[]; problems: string[]; selected: string | null; onSelect: (id: string) => void }) {
  const current = jobs.find((j) => j.id === selected) ?? jobs[0]
  if (jobs.length === 0) {
    return (
      <CenteredState
        icon={<SparklesIcon />}
        title="No pixel art yet"
        subtitle="Start a character, an animation or a tileset in Generate, or ask an agent of a connected project to use the PixelForge tools."
      />
    )
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <ul data-slot="pixel-library" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {jobs.map((job) => {
          const thumb = job.outputs.frames?.[0] ?? job.outputs.preview ?? job.outputs.sheet
          return (
            <li key={job.id}>
              <button
                type="button"
                data-slot="pixel-job"
                data-job-id={job.id}
                aria-pressed={current?.id === job.id}
                onClick={() => onSelect(job.id)}
                className={cn('flex w-full flex-col gap-1 rounded-md border border-border p-2 text-left', current?.id === job.id && 'ring-2 ring-primary')}
              >
                <div className="flex aspect-square items-center justify-center overflow-hidden rounded-sm" style={{ background: CHECKER }}>
                  {thumb ? (
                    <img src={pixelJobFileUrl(job.id, thumb)} alt="" className="max-h-full max-w-full" style={{ imageRendering: 'pixelated', width: '80%', objectFit: 'contain' }} />
                  ) : (
                    <span className="text-xs text-soft-foreground">{job.status}</span>
                  )}
                </div>
                <span className="truncate text-xs font-medium">{TOOL_LABEL[job.tool]}</span>
                <Badge variant="outline" className={cn('w-fit', statusTone(job))}>
                  {job.status}
                  {job.backend === 'gpu' ? ' · GPU' : ''}
                </Badge>
              </button>
            </li>
          )
        })}
      </ul>
      {problems.length > 0 && <p className="text-xs text-warning lg:col-span-2">{problems.join(' · ')}</p>}
      {current && <JobViewer key={current.id} job={current} />}
    </div>
  )
}

function useSheet(job: PixelJob) {
  const path = job.outputs.json
  return useQuery({
    queryKey: [...queryKeys.pixelStudio.jobs(), job.id, 'sheet', job.updated],
    enabled: Boolean(path) && job.status === 'done',
    queryFn: async ({ signal }) => {
      const res = await fetch(pixelJobFileUrl(job.id, path ?? ''), { signal })
      if (!res.ok) throw new Error(`sheet.json: HTTP ${res.status}`)
      return parseSheet(await res.json())
    },
  })
}

export function JobViewer({ job }: { job: PixelJob }) {
  const queryClient = useQueryClient()
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.pixelStudio.jobs() })
  const reprocess = useMutation({ mutationFn: () => reprocessPixelJob(job.id), onSuccess: refresh, onError: (e: Error) => toast(e.message, { tone: 'danger' }) })
  const collect = useMutation({ mutationFn: () => collectPixelJob(job.id), onSuccess: refresh, onError: (e: Error) => toast(e.message, { tone: 'danger' }) })
  const sheet = useSheet(job)
  const [format, setFormat] = useState<'web' | 'tiled' | 'godot' | 'unity'>('web')
  const [exported, setExported] = useState<Record<string, string> | null>(null)
  const exportJob = useMutation({ mutationFn: () => exportPixelJob(job.id, format), onSuccess: (r) => setExported(r.paths), onError: (e: Error) => toast(e.message, { tone: 'danger' }) })
  const [showRaw, setShowRaw] = useState(false)
  const sheetPath = job.tool === 'character8' || job.tool === 'animate' ? job.outputs.sheet : (job.outputs.preview ?? job.outputs.sheet ?? job.outputs.frames?.[0])
  return (
    <section data-slot="pixel-viewer" className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{TOOL_LABEL[job.tool]}</h2>
        <Badge variant="outline" className={statusTone(job)}>{job.status}</Badge>
        <span className="truncate text-xs text-soft-foreground">{job.id}</span>
      </div>
      {typeof job.params.description === 'string' && <p className="text-ui text-muted-foreground">{job.params.description}</p>}
      {job.error && <p role="alert" className="text-ui text-destructive">{job.error}</p>}
      {isBusy(job) && <p className="text-ui text-soft-foreground">Working… Codex draws in 1–3 minutes per step; this page refreshes by itself.</p>}

      {job.status === 'done' && sheet.data && job.outputs.sheet && (job.tool === 'character8' || job.tool === 'animate') && (
        <SpritePlayer sheet={sheet.data} src={pixelJobFileUrl(job.id, job.outputs.sheet)} />
      )}
      {job.status === 'done' && job.tool !== 'character8' && job.tool !== 'animate' && sheetPath && (
        <div className="overflow-auto rounded-sm" style={{ background: CHECKER }}>
          <img src={pixelJobFileUrl(job.id, sheetPath)} alt={`${TOOL_LABEL[job.tool]} preview`} style={{ imageRendering: 'pixelated' }} />
        </div>
      )}

      {Object.keys(job.qa).length > 0 && (
        <dl data-slot="pixel-qa" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
          {qaSummary(job.qa).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="flex flex-wrap gap-2">
        {(['aseprite', 'sheet', 'json', 'palette'] as const).map((k) =>
          job.outputs[k] ? (
            <Button key={k} asChild variant="outline" size="xs">
              <a href={pixelJobFileUrl(job.id, job.outputs[k] ?? '')} download>
                <DownloadIcon aria-hidden="true" />
                {k === 'aseprite' ? '.aseprite' : k}
              </a>
            </Button>
          ) : null,
        )}
        {(job.status === 'done' || job.status === 'generated') && (
          <Button variant="outline" size="xs" disabled={reprocess.isPending} onClick={() => reprocess.mutate()}>
            <RefreshCwIcon aria-hidden="true" /> Re-process
          </Button>
        )}
        {job.backend === 'gpu' && (job.status === 'queued' || job.status === 'generating') && (
          <Button variant="outline" size="xs" disabled={collect.isPending} onClick={() => collect.mutate()}>
            <UploadCloudIcon aria-hidden="true" /> Collect from GPU
          </Button>
        )}
        {job.raw.length > 0 && (
          <Button variant="ghost" size="xs" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? 'Hide generator output' : 'Show generator output'}
          </Button>
        )}
      </div>
      {job.status === 'done' && <div className="flex flex-wrap items-center gap-2">
        <label className={FIELD}>Export format
          <select aria-label="Export format" className={SELECT} value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            <option value="web">Web</option>
            {['tileset', 'platformer', 'tileset47'].includes(job.tool) && <option value="tiled">Tiled</option>}
            <option value="godot">Godot</option><option value="unity">Unity</option>
          </select>
        </label>
        <Button type="button" variant="outline" size="xs" disabled={exportJob.isPending} onClick={() => exportJob.mutate()}>Export</Button>
        {exported && <ul aria-label="Exported paths">{Object.entries(exported).map(([key, path]) => <li key={key}>{key}: {path}</li>)}</ul>}
      </div>}
      {showRaw && job.raw.map((r) => <img key={r} src={pixelJobFileUrl(job.id, r)} alt={r} className="max-w-full rounded-sm" />)}
    </section>
  )
}

function SpritePlayer({ sheet, src }: { sheet: Sheet; src: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [tag, setTag] = useState<string | null>(sheet.tags.length > 1 && sheet.tags.every((t) => t.from === t.to) ? null : sheet.tags[0]?.name ?? null)
  const [zoom, setZoom] = useState(6)
  const [grid, setGrid] = useState(false)
  const [playing, setPlaying] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const sequence = useMemo(() => tagSequence(sheet, tag), [sheet, tag])
  const fw = Math.max(...sheet.frames.map((f) => f.w))
  const fh = Math.max(...sheet.frames.map((f) => f.h))

  useEffect(() => {
    const img = new Image()
    img.onload = () => setLoaded(true)
    img.src = src
    imgRef.current = img
  }, [src])

  useEffect(() => {
    if (!loaded) return
    let raf = 0
    const start = performance.now()
    let still = sequence[0] ?? 0
    const draw = (now: number) => {
      const canvas = canvasRef.current
      const img = imgRef.current
      if (!canvas || !img) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const i = playing ? frameAt(sheet, sequence, now - start) : still
      still = i
      const f = sheet.frames[i]
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (f) ctx.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, f.w * zoom, f.h * zoom)
      if (grid && zoom >= 4) {
        ctx.strokeStyle = 'rgba(128,128,128,0.35)'
        ctx.lineWidth = 1
        for (let x = 0; x <= fw; x++) { ctx.beginPath(); ctx.moveTo(x * zoom + 0.5, 0); ctx.lineTo(x * zoom + 0.5, fh * zoom); ctx.stroke() }
        for (let y = 0; y <= fh; y++) { ctx.beginPath(); ctx.moveTo(0, y * zoom + 0.5); ctx.lineTo(fw * zoom, y * zoom + 0.5); ctx.stroke() }
      }
      if (playing) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [loaded, sheet, sequence, zoom, grid, playing, fw, fh])

  return (
    <div data-slot="sprite-player" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          Tag
          <select aria-label="Animation tag" className="rounded-sm border border-border bg-background px-1 py-0.5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={tag ?? ''} onChange={(e) => setTag(e.target.value || null)}>
            <option value="">all frames</option>
            {sheet.tags.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Zoom
          <input aria-label="Zoom" type="range" min={1} max={16} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
          {zoom}×
        </label>
        <Button variant="ghost" size="icon-xs" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying((p) => !p)}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Pixel grid" aria-pressed={grid} onClick={() => setGrid((g) => !g)}>
          <GridIcon />
        </Button>
        <span className="text-soft-foreground">{fw}×{fh} px · {sheet.frames.length} frames</span>
      </div>
      <div className="w-fit max-w-full overflow-auto rounded-sm" style={{ background: CHECKER }}>
        <canvas ref={canvasRef} width={fw * zoom} height={fh * zoom} style={{ imageRendering: 'pixelated' }} />
      </div>
      <img src={src} alt="Sprite sheet" className="max-w-full" style={{ imageRendering: 'pixelated', background: CHECKER }} />
    </div>
  )
}

const FIELD = 'flex flex-col gap-1 text-ui'
const SELECT = 'h-9 rounded-md border border-border bg-background px-2 text-ui outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

type GenTool = PixelJob['tool']
type Palette = (typeof PALETTES)[number]

/** A file input that uploads at once and keeps the returned upload name. */
function UploadField({ label, value, onChange, accept = 'image/png,image/jpeg,image/webp' }: { label: string; value: string | null; onChange: (name: string | null) => void; accept?: string }) {
  const upload = useMutation({
    mutationFn: (file: File) => uploadPixelImage(file),
    onSuccess: (r) => onChange(r.name),
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })
  return (
    <label className={FIELD}>
      {label}
      <input
        aria-label={label}
        type="file"
        accept={accept}
        className="text-ui"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) upload.mutate(file)
          else onChange(null)
        }}
      />
      <span className="text-xs text-soft-foreground">{upload.isPending ? 'Uploading…' : value ? `uploaded: ${value}` : 'optional'}</span>
    </label>
  )
}

export function Generate({ jobs, onStarted }: { jobs: PixelJob[]; onStarted: (id: string) => void }) {
  const queryClient = useQueryClient()
  const [tool, setTool] = useState<GenTool>('character8')
  const [backend, setBackend] = useState<'codex' | 'gpu'>('codex')
  const [description, setDescription] = useState('')
  const [view, setView] = useState<'side' | 'low top-down' | 'high top-down'>('low top-down')
  const [quality, setQuality] = useState<'standard' | 'hd'>('hd')
  const [outline, setOutline] = useState<'' | 'black' | 'colored' | 'selective' | 'lineless'>('')
  const [shading, setShading] = useState<'' | 'flat' | 'basic' | 'medium' | 'detailed' | 'highly-detailed'>('')
  const [detail, setDetail] = useState<'' | 'low' | 'medium' | 'high'>('')
  const look = { quality, ...(outline ? { outline } : {}), ...(shading ? { shading } : {}), ...(detail ? { detail } : {}) }

  const [palette, setPalette] = useState<Palette | ''>('')
  const [concept, setConcept] = useState<string | null>(null)
  const [style, setStyle] = useState<string | null>(null)
  const [size, setSize] = useState(48)
  const [colors, setColors] = useState(16)
  const refs = useMemo(() => referenceOptions(jobs), [jobs])
  const sources = useMemo(() => editSourceOptions(jobs), [jobs])
  const [reference, setReference] = useState('')
  const [animateSize, setAnimateSize] = useState('')
  const [weapon, setWeapon] = useState<'' | 'sword' | 'staff' | 'bow'>('')
  const [animateDescription, setAnimateDescription] = useState('')
  const [action, setAction] = useState('walk')
  const [frames, setFrames] = useState<4 | 6 | 8>(8)
  const [direction, setDirection] = useState('east')
  const [lower, setLower] = useState('')
  const [upper, setUpper] = useState('')
  const [tileSize, setTileSize] = useState<16 | 24 | 32 | 48 | 64>(32)
  const [kind, setKind] = useState<'scene' | 'map' | 'object'>('scene')
  const [width, setWidth] = useState(256)
  const [height, setHeight] = useState(144)
  const [items, setItems] = useState('')
  const [theme, setTheme] = useState('')
  const [source, setSource] = useState('')
  const [sourceUpload, setSourceUpload] = useState<string | null>(null)
  const [mask, setMask] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')

  const start = useMutation({
    mutationFn: (input: CreatePixelJobInput) => createPixelJob(input),
    onSuccess: (r) => {
      toast(`Started ${r.jobId}`)
      void queryClient.invalidateQueries({ queryKey: queryKeys.pixelStudio.jobs() })
      onStarted(r.jobId)
    },
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })

  const pal = palette ? { palette } : {}
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (tool === 'character8') {
      start.mutate({ tool, description, size, colors, view, ...look, backend, ...pal, ...(concept ? { concept } : {}), ...(style ? { styles: [style] } : {}) })
    } else if (tool === 'animate') {
      start.mutate({ tool, reference: reference || refs[0]?.value || '', action, frames, direction, ...(animateSize ? { size: Number(animateSize) } : {}), ...(weapon ? { weapon } : {}), ...(animateDescription ? { description: animateDescription } : {}), colors, ...look, backend, ...pal })
    } else if (tool === 'tileset') {
      start.mutate({ tool, lower, upper, tileSize, colors, ...look, backend, ...pal })
    } else if (tool === 'image') {
      start.mutate({ tool, description, kind, width, height, colors, ...look, backend, ...pal })
    } else if (tool === 'ui') {
      start.mutate({ tool, items: parseItems(items), theme, size, colors, ...look, backend, ...pal, ...(style ? { styles: [style] } : {}) })
    } else if (tool === 'edit') {
      const src = sourceUpload ? `upload:${sourceUpload}` : source || sources[0]?.value || ''
      start.mutate({ tool, source: src, instruction, ...look, backend, ...(mask ? { mask } : {}) })
    }
  }

  const needsDescription = tool === 'character8' || tool === 'image'
  const disabled =
    start.isPending ||
    (tool === 'animate' && refs.length === 0) ||
    (tool === 'edit' && !sourceUpload && sources.length === 0) ||
    (tool === 'ui' && parseItems(items).length === 0)

  if (!['character8', 'animate', 'tileset', 'image', 'ui', 'edit'].includes(tool)) {
    return <NewToolForm tool={tool} jobs={jobs} onTool={setTool} onStarted={onStarted} />
  }

  return (
    <form data-slot="pixel-generate" onSubmit={submit} className="flex max-w-2xl flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={FIELD}>
          Tool
          <select aria-label="Tool" className={SELECT} value={tool} onChange={(e) => setTool(e.target.value as GenTool)}>
            <option value="character8">Character, 8 directions (text, concept or sketch)</option>
            <option value="animate">Animate a character</option>
            <option value="tileset">Terrain tileset (16 tiles)</option>
            <option value="image">Scene, map or object</option>
            <option value="ui">UI elements</option>
            <option value="edit">Edit / inpaint an image</option>
            {(['isometric', 'platformer', 'interpolate', 'rotate', 'resize', 'vfx', 'tileset47'] as const).map((t) => <option key={t} value={t}>{TOOL_LABEL[t]}</option>)}
          </select>
        </label>
        <label className={FIELD}>
          Generator
          <select aria-label="Generator" className={SELECT} value={backend} onChange={(e) => setBackend(e.target.value as typeof backend)}>
            <option value="codex">Codex image_gen (this machine)</option>
            <option value="gpu">GPU cezar (queue)</option>
          </select>
        </label>
      </div>

      {needsDescription && (
        <label className={FIELD}>
          Description
          <Textarea aria-label="Description" required={tool === 'image' || !concept} minLength={3} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder={tool === 'image' ? 'a fantasy forest market street with striped awnings and potion shelves' : 'adult female ranger, red ponytail, green vest, longbow'} />
        </label>
      )}

      {tool === 'character8' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <UploadField label="Concept art or sketch" value={concept} onChange={setConcept} />
          <UploadField label="Style reference" value={style} onChange={setStyle} />
          <label className={FIELD}>
            View
            <select aria-label="View" className={SELECT} value={view} onChange={(e) => setView(e.target.value as typeof view)}>
              <option value="low top-down">low top-down</option>
              <option value="high top-down">high top-down</option>
              <option value="side">side</option>
            </select>
          </label>
        </div>
      )}

      {tool === 'animate' && (
        <>
          <label className={FIELD}>
            Reference frame
            <select aria-label="Reference frame" className={SELECT} value={reference || refs[0]?.value || ''} onChange={(e) => setReference(e.target.value)}>
              {refs.length === 0 && <option value="">Generate an 8-direction character first</option>}
              {refs.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <label className={FIELD}>Weapon<select aria-label="Weapon" className={SELECT} value={weapon} onChange={(e) => setWeapon(e.target.value as typeof weapon)}><option value="">None</option>{(['sword', 'staff', 'bow'] as const).map((w) => <option key={w} value={w}>{w}</option>)}</select></label>
          <label className={FIELD}>Description<Textarea aria-label="Description" maxLength={500} value={animateDescription} onChange={(e) => setAnimateDescription(e.target.value)} /></label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={FIELD}>
              Action
              <Input aria-label="Action" list="pixel-actions" value={action} onChange={(e) => setAction(e.target.value)} />
              <datalist id="pixel-actions">
                {['walk', 'run', 'idle', 'attack'].map((a) => <option key={a} value={a} />)}
              </datalist>
            </label>
            <label className={FIELD}>
              Frames
              <select aria-label="Frames" className={SELECT} value={frames} onChange={(e) => setFrames(Number(e.target.value) as 4 | 6 | 8)}>
                {[4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className={FIELD}>
              Direction
              <select aria-label="Direction" className={SELECT} value={direction} onChange={(e) => setDirection(e.target.value)}>
                {['east', 'west', 'south', 'north', 'south-east', 'south-west', 'north-east', 'north-west'].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          </div>
        </>
      )}

      {tool === 'tileset' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={FIELD}>
            Lower terrain
            <Input aria-label="Lower terrain" required value={lower} onChange={(e) => setLower(e.target.value)} placeholder="lush grass with small flowers" />
          </label>
          <label className={FIELD}>
            Upper terrain
            <Input aria-label="Upper terrain" required value={upper} onChange={(e) => setUpper(e.target.value)} placeholder="dry dirt path with pebbles" />
          </label>
          <label className={FIELD}>
            Tile size
            <select aria-label="Tile size" className={SELECT} value={tileSize} onChange={(e) => setTileSize(Number(e.target.value) as typeof tileSize)}>
              {[16, 24, 32, 48, 64].map((n) => <option key={n} value={n}>{n} px</option>)}
            </select>
          </label>
        </div>
      )}

      {tool === 'image' && (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={FIELD}>
            Kind
            <select aria-label="Kind" className={SELECT} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="scene">Scene / environment</option>
              <option value="map">Top-down game map</option>
              <option value="object">Single object</option>
            </select>
          </label>
          <label className={FIELD}>
            Width
            <Input aria-label="Width" type="number" min={16} max={512} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
          </label>
          <label className={FIELD}>
            Height
            <Input aria-label="Height" type="number" min={16} max={512} value={height} onChange={(e) => setHeight(Number(e.target.value))} />
          </label>
        </div>
      )}

      {tool === 'ui' && (
        <>
          <label className={FIELD}>
            Elements (one per line)
            <Textarea aria-label="Elements" value={items} onChange={(e) => setItems(e.target.value)} placeholder={'square wooden button\nround red health orb in an iron frame\nhorizontal health bar frame'} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={FIELD}>
              Theme
              <Input aria-label="Theme" value={theme} onChange={(e) => setTheme(e.target.value)} placeholder="dark fantasy RPG" />
            </label>
            <UploadField label="Style reference" value={style} onChange={setStyle} />
          </div>
        </>
      )}

      {tool === 'edit' && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={FIELD}>
              Image to edit
              <select aria-label="Image to edit" className={SELECT} value={source || sources[0]?.value || ''} onChange={(e) => setSource(e.target.value)} disabled={Boolean(sourceUpload)}>
                {sources.length === 0 && <option value="">Upload an image or finish a job first</option>}
                {sources.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
            <UploadField label="…or upload a pixel-art image" value={sourceUpload} onChange={setSourceUpload} />
            <UploadField label="Mask (white = may change)" value={mask} onChange={setMask} />
          </div>
          <label className={FIELD}>
            Change
            <Textarea aria-label="Change" required minLength={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="add a green ranger hat with a red feather" />
          </label>
        </>
      )}

      {tool !== 'edit' && (
        <div className="grid gap-3 sm:grid-cols-3">
          {(tool === 'character8' || tool === 'animate' || tool === 'ui') && (
            <label className={FIELD}>
              Size (logical px)
              {tool === 'animate' ? <Input aria-label="Size" type="number" min={16} max={168} placeholder="Auto (reference size)" value={animateSize} onChange={(e) => setAnimateSize(e.target.value)} /> : <Input aria-label="Size" type="number" min={16} max={tool === 'ui' ? 128 : 168} value={size} onChange={(e) => setSize(Number(e.target.value))} />}
            </label>
          )}
          <label className={FIELD}>
            Colors
            <Input aria-label="Colors" type="number" min={4} max={64} value={colors} onChange={(e) => setColors(Number(e.target.value))} />
          </label>
          <label className={FIELD}>
            Palette
            <select aria-label="Palette" className={SELECT} value={palette} onChange={(e) => setPalette(e.target.value as Palette | '')}>
              <option value="">from the image</option>
              {PALETTES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          {
            <label className={FIELD}>
              Quality
              <select aria-label="Quality" className={SELECT} value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)}>
                <option value="hd">HD (rich shading)</option>
                <option value="standard">standard</option>
              </select>
            </label>
          }
        </div>
      )}
      {tool === 'edit' && <label className={FIELD}>Quality<select aria-label="Quality" className={SELECT} value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)}><option value="hd">HD</option><option value="standard">standard</option></select></label>}
      {<div className="grid gap-3 sm:grid-cols-3">
        <label className={FIELD}>Outline<select aria-label="Outline" className={SELECT} value={outline} onChange={(e) => setOutline(e.target.value as typeof outline)}><option value="">Quality default</option>{['black', 'colored', 'selective', 'lineless'].map((v) => <option key={v}>{v}</option>)}</select></label>
        <label className={FIELD}>Shading<select aria-label="Shading" className={SELECT} value={shading} onChange={(e) => setShading(e.target.value as typeof shading)}><option value="">Quality default</option>{['flat', 'basic', 'medium', 'detailed', 'highly-detailed'].map((v) => <option key={v}>{v}</option>)}</select></label>
        <label className={FIELD}>Detail<select aria-label="Detail" className={SELECT} value={detail} onChange={(e) => setDetail(e.target.value as typeof detail)}><option value="">Quality default</option>{['low', 'medium', 'high'].map((v) => <option key={v}>{v}</option>)}</select></label>
      </div>}
      <Button type="submit" className="w-fit" disabled={disabled}>
        <SparklesIcon aria-hidden="true" /> {start.isPending ? 'Starting…' : 'Generate'}
      </Button>
      <p className="text-xs text-soft-foreground">
        Codex jobs run on this machine (1–3 minutes per image). GPU jobs wait in gpu-queue/ until the GPU cezar picks them up — sync the queue in the GPU tab.
      </p>
    </form>
  )
}

/** Inputs for the additional PixelForge pipelines. Files are uploads or library references. */
export function NewToolForm({ tool, jobs, onTool, onStarted }: { tool: GenTool; jobs: PixelJob[]; onTool: (tool: GenTool) => void; onStarted: (id: string) => void }) {
  const queryClient = useQueryClient()
  const [backend, setBackend] = useState<'codex' | 'gpu'>('codex')
  const [quality, setQuality] = useState<'standard' | 'hd'>('hd')
  const [outline, setOutline] = useState<'' | 'black' | 'colored' | 'selective' | 'lineless'>('')
  const [shading, setShading] = useState<'' | 'flat' | 'basic' | 'medium' | 'detailed' | 'highly-detailed'>('')
  const [detail, setDetail] = useState<'' | 'low' | 'medium' | 'high'>('')
  const [edgeOutline, setEdgeOutline] = useState<'all' | 'outer'>('all')
  const [description, setDescription] = useState('')
  const [lower, setLower] = useState('')
  const [upper, setUpper] = useState('')
  const [material, setMaterial] = useState('')
  const [decoration, setDecoration] = useState('')
  const [tileSize, setTileSize] = useState(32)
  const [blockHeight, setBlockHeight] = useState(0)
  const [size, setSize] = useState(48)
  const [colors, setColors] = useState(16)
  const [frames, setFrames] = useState(8)
  const [inbetweens, setInbetweens] = useState(1)
  const [direction, setDirection] = useState<'south' | 'south-west' | 'west' | 'north-west' | 'north' | 'north-east' | 'east' | 'south-east' | 'all'>('east')
  const [palette, setPalette] = useState<Palette | ''>('')
  const [reference, setReference] = useState('')
  const [referenceUpload, setReferenceUpload] = useState<string | null>(null)
  const [end, setEnd] = useState('')
  const [endUpload, setEndUpload] = useState<string | null>(null)
  const [mode, setMode] = useState<'endpoints' | 'sheet'>('endpoints')
  const [sheet, setSheet] = useState('')
  const [sheetUpload, setSheetUpload] = useState<string | null>(null)
  const [jsonUpload, setJsonUpload] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const sources = editSourceOptions(jobs)
  const sheets = jobs.filter((j) => j.status === 'done' && j.outputs.sheet && j.outputs.json)
  const sourceRef = referenceUpload ? `upload:${referenceUpload}` : reference || sources[0]?.value || ''
  const endRef = endUpload ? `upload:${endUpload}` : end || sources[0]?.value || ''
  const selectedSheet = sheets.find((j) => j.id === sheet) ?? sheets[0]
  const common = { backend, quality, ...(outline ? { outline } : {}), ...(shading ? { shading } : {}), ...(detail ? { detail } : {}) }
  const pal = palette ? { palette } : {}
  const start = useMutation({ mutationFn: (input: CreatePixelJobInput) => createPixelJob(input), onSuccess: (r) => { void queryClient.invalidateQueries({ queryKey: queryKeys.pixelStudio.jobs() }); onStarted(r.jobId) }, onError: (e: Error) => toast(e.message, { tone: 'danger' }) })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (tool === 'isometric') start.mutate({ tool, description, tileSize, blockHeight, colors, edgeOutline, ...pal, ...common })
    else if (tool === 'platformer') start.mutate({ tool, material, decoration, tileSize, colors, edgeOutline, ...pal, ...common })
    else if (tool === 'tileset47') start.mutate({ tool, lower, upper, tileSize, colors, ...pal, ...common })
    else if (tool === 'rotate') start.mutate({ tool, reference: sourceRef, direction, ...common })
    else if (tool === 'resize') start.mutate({ tool, reference: sourceRef, size, ...common })
    else if (tool === 'vfx') start.mutate({ tool, description, frames, size, colors, ...common })
    else if (tool === 'interpolate') start.mutate({ tool, inbetweens, ...common, ...(mode === 'sheet' ? { sheet: sheetUpload ? `upload:${sheetUpload}` : `${selectedSheet?.id}/${selectedSheet?.outputs.sheet}`, sheetJson: jsonUpload ? `upload:${jsonUpload}` : `${selectedSheet?.id}/${selectedSheet?.outputs.json}`, instruction } : { start: sourceRef, end: endRef }) })
  }
  const fileInput = (label: string, value: string, setValue: (s: string) => void, upload: string | null, setUpload: (s: string | null) => void) => <div className="grid gap-2 sm:grid-cols-2">
    <label className={FIELD}>{label}<select aria-label={label} className={SELECT} value={value || sources[0]?.value || ''} onChange={(e) => setValue(e.target.value)} disabled={Boolean(upload)}><option value="">Choose a frame</option>{sources.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></label>
    <UploadField label={`${label} upload`} value={upload} onChange={setUpload} />
  </div>
  return <form data-slot="pixel-generate" onSubmit={submit} className="flex max-w-2xl flex-col gap-3">
    <label className={FIELD}>Tool<select aria-label="Tool" className={SELECT} value={tool} onChange={(e) => onTool(e.target.value as GenTool)}>{(Object.keys(TOOL_LABEL) as GenTool[]).map((t) => <option key={t} value={t}>{TOOL_LABEL[t]}</option>)}</select></label>
    <label className={FIELD}>Generator<select aria-label="Generator" className={SELECT} value={backend} onChange={(e) => setBackend(e.target.value as typeof backend)}><option value="codex">Codex image_gen</option><option value="gpu">GPU cezar</option></select></label>
    {(tool === 'isometric' || tool === 'vfx') && <label className={FIELD}>Description<Textarea aria-label="Description" required minLength={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>}
    {tool === 'platformer' && <><label className={FIELD}>Material<Input aria-label="Material" required minLength={2} value={material} onChange={(e) => setMaterial(e.target.value)} /></label><label className={FIELD}>Decoration<Input aria-label="Decoration" value={decoration} onChange={(e) => setDecoration(e.target.value)} /></label></>}
    {tool === 'tileset47' && <><label className={FIELD}>Lower terrain<Input aria-label="Lower terrain" required minLength={2} value={lower} onChange={(e) => setLower(e.target.value)} /></label><label className={FIELD}>Upper terrain<Input aria-label="Upper terrain" required minLength={2} value={upper} onChange={(e) => setUpper(e.target.value)} /></label></>}
    {(['isometric', 'platformer', 'tileset47'].includes(tool)) && <label className={FIELD}>Tile size<Input aria-label="Tile size" type="number" min={16} max={tool === 'platformer' ? 32 : 64} step={tool === 'tileset47' ? 2 : 1} value={tileSize} onChange={(e) => setTileSize(Number(e.target.value))} /></label>}
    {tool === 'isometric' && <label className={FIELD}>Block height<Input aria-label="Block height" type="number" min={0} max={128} value={blockHeight} onChange={(e) => setBlockHeight(Number(e.target.value))} /></label>}
    {(tool === 'isometric' || tool === 'platformer') && <label className={FIELD}>Edge outline<select aria-label="Edge outline" className={SELECT} value={edgeOutline} onChange={(e) => setEdgeOutline(e.target.value as typeof edgeOutline)}><option value="all">all</option><option value="outer">outer</option></select></label>}
    {(tool === 'rotate' || tool === 'resize' || (tool === 'interpolate' && mode === 'endpoints')) && fileInput(tool === 'interpolate' ? 'Start frame' : 'Reference', reference, setReference, referenceUpload, setReferenceUpload)}
    {tool === 'interpolate' && <><label className={FIELD}>Input mode<select aria-label="Input mode" className={SELECT} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="endpoints">Two endpoints</option><option value="sheet">Edit sheet</option></select></label>{mode === 'endpoints' ? fileInput('End frame', end, setEnd, endUpload, setEndUpload) : <><label className={FIELD}>Sheet<select aria-label="Sheet" className={SELECT} value={selectedSheet?.id || ''} onChange={(e) => setSheet(e.target.value)}><option value="">Choose a sheet</option>{sheets.map((j) => <option key={j.id} value={j.id}>{j.id}</option>)}</select></label><UploadField label="Sheet upload" value={sheetUpload} onChange={setSheetUpload} /><UploadField label="Sheet JSON upload" value={jsonUpload} onChange={setJsonUpload} accept="application/json,.json" /><label className={FIELD}>Instruction<Textarea aria-label="Instruction" required value={instruction} onChange={(e) => setInstruction(e.target.value)} /></label></>}<label className={FIELD}>In-betweens<Input aria-label="In-betweens" type="number" min={1} max={14} value={inbetweens} onChange={(e) => setInbetweens(Number(e.target.value))} /></label></>}
    {tool === 'rotate' && <label className={FIELD}>Direction<select aria-label="Direction" className={SELECT} value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}>{['south','south-west','west','north-west','north','north-east','east','south-east','all'].map((d) => <option key={d}>{d}</option>)}</select></label>}
    {(tool === 'resize' || tool === 'vfx') && <label className={FIELD}>Size<Input aria-label="Size" type="number" min={tool === 'vfx' ? 8 : 1} max={tool === 'vfx' ? 128 : 512} value={size} onChange={(e) => setSize(Number(e.target.value))} /></label>}
    {tool === 'vfx' && <label className={FIELD}>Frames<Input aria-label="Frames" type="number" min={4} max={16} value={frames} onChange={(e) => setFrames(Number(e.target.value))} /></label>}
    {['isometric', 'platformer', 'tileset47', 'vfx'].includes(tool) && <label className={FIELD}>Colors<Input aria-label="Colors" type="number" min={tool === 'vfx' ? 2 : 4} max={64} value={colors} onChange={(e) => setColors(Number(e.target.value))} /></label>}
    {['isometric', 'platformer', 'tileset47'].includes(tool) && <label className={FIELD}>Palette<select aria-label="Palette" className={SELECT} value={palette} onChange={(e) => setPalette(e.target.value as typeof palette)}><option value="">from the image</option>{PALETTES.map((p) => <option key={p}>{p}</option>)}</select></label>}
    <label className={FIELD}>Quality<select aria-label="Quality" className={SELECT} value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)}><option value="hd">HD</option><option value="standard">standard</option></select></label>
    <label className={FIELD}>Outline<select aria-label="Outline" className={SELECT} value={outline} onChange={(e) => setOutline(e.target.value as typeof outline)}><option value="">Quality default</option>{['black','colored','selective','lineless'].map((v) => <option key={v}>{v}</option>)}</select></label>
    <label className={FIELD}>Shading<select aria-label="Shading" className={SELECT} value={shading} onChange={(e) => setShading(e.target.value as typeof shading)}><option value="">Quality default</option>{['flat','basic','medium','detailed','highly-detailed'].map((v) => <option key={v}>{v}</option>)}</select></label>
    <label className={FIELD}>Detail<select aria-label="Detail" className={SELECT} value={detail} onChange={(e) => setDetail(e.target.value as typeof detail)}><option value="">Quality default</option>{['low','medium','high'].map((v) => <option key={v}>{v}</option>)}</select></label>
    <Button type="submit" className="w-fit" disabled={start.isPending || ((tool === 'rotate' || tool === 'resize') && !sourceRef) || (tool === 'interpolate' && (mode === 'sheet' ? !(sheetUpload || selectedSheet) || !(jsonUpload || selectedSheet) : !sourceRef || !endRef))}>Generate</Button>
  </form>
}

function GpuQueue() {
  const queue = usePixelGpuQueue()
  const queryClient = useQueryClient()
  const [log, setLog] = useState<string | null>(null)
  const sync = useMutation({
    mutationFn: () => syncPixelGpuQueue(),
    onSuccess: (r) => {
      setLog(r.log)
      if (!r.ok) toast('GPU queue sync failed; see the log', { tone: 'danger' })
      void queryClient.invalidateQueries({ queryKey: queryKeys.pixelStudio.gpuQueue() })
    },
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })
  return (
    <section data-slot="pixel-gpu" className="flex max-w-2xl flex-col gap-3">
      <p className="text-ui text-muted-foreground">
        GPU jobs are exchanged through the project repository: Sync pulls the GPU cezar’s results and pushes new queued jobs (only the gpu-queue/ folder is committed).
      </p>
      <Button variant="outline" className="w-fit" disabled={sync.isPending} onClick={() => sync.mutate()}>
        <RefreshCwIcon aria-hidden="true" /> {sync.isPending ? 'Syncing…' : 'Sync with remote'}
      </Button>
      {log && <pre data-slot="pixel-gpu-log" className="overflow-auto rounded-sm bg-muted p-2 text-xs">{log}</pre>}
      {queue.data?.entries.length ? (
        <ul className="flex flex-col gap-1">
          {queue.data.entries.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-ui">
              <span className="truncate">{e.id}</span>
              <Badge variant="outline">{e.status}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ui text-soft-foreground">The GPU queue is empty.</p>
      )}
    </section>
  )
}
