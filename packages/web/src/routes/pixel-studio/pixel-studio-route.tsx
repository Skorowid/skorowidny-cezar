import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DownloadIcon, GridIcon, PauseIcon, PlayIcon, RefreshCwIcon, SparklesIcon, UploadCloudIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'

import { collectPixelJob, createPixelJob, pixelJobFileUrl, reprocessPixelJob, syncPixelGpuQueue } from '@/api/client'
import { queryKeys, usePixelGpuQueue, usePixelJobs } from '@/api/queries'
import type { CreatePixelJobInput, PixelJob } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

import { TOOL_LABEL, frameAt, isBusy, parseSheet, qaSummary, referenceOptions, tagSequence, type Sheet } from './pixel-studio-model'

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
          const thumb = job.outputs.frames?.[0] ?? job.outputs.preview
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

function JobViewer({ job }: { job: PixelJob }) {
  const queryClient = useQueryClient()
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.pixelStudio.jobs() })
  const reprocess = useMutation({ mutationFn: () => reprocessPixelJob(job.id), onSuccess: refresh, onError: (e: Error) => toast(e.message, { tone: 'danger' }) })
  const collect = useMutation({ mutationFn: () => collectPixelJob(job.id), onSuccess: refresh, onError: (e: Error) => toast(e.message, { tone: 'danger' }) })
  const sheet = useSheet(job)
  const [showRaw, setShowRaw] = useState(false)
  const sheetPath = job.tool === 'tileset' ? job.outputs.preview : job.outputs.sheet
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

      {job.status === 'done' && sheet.data && job.outputs.sheet && job.tool !== 'tileset' && (
        <SpritePlayer sheet={sheet.data} src={pixelJobFileUrl(job.id, job.outputs.sheet)} />
      )}
      {job.status === 'done' && job.tool === 'tileset' && sheetPath && (
        <div className="overflow-auto rounded-sm" style={{ background: CHECKER }}>
          <img src={pixelJobFileUrl(job.id, sheetPath)} alt="Tileset demo map" style={{ imageRendering: 'pixelated' }} />
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

function Generate({ jobs, onStarted }: { jobs: PixelJob[]; onStarted: (id: string) => void }) {
  const queryClient = useQueryClient()
  const [tool, setTool] = useState<'character8' | 'animate' | 'tileset'>('character8')
  const [backend, setBackend] = useState<'codex' | 'gpu'>('codex')
  const [description, setDescription] = useState('')
  const [view, setView] = useState<'side' | 'low top-down' | 'high top-down'>('low top-down')
  const [size, setSize] = useState(48)
  const [colors, setColors] = useState(16)
  const refs = useMemo(() => referenceOptions(jobs), [jobs])
  const [reference, setReference] = useState('')
  const [action, setAction] = useState('walk')
  const [frames, setFrames] = useState<4 | 6 | 8>(8)
  const [direction, setDirection] = useState('east')
  const [lower, setLower] = useState('')
  const [upper, setUpper] = useState('')
  const [tileSize, setTileSize] = useState<16 | 24 | 32 | 48 | 64>(32)

  const start = useMutation({
    mutationFn: (input: CreatePixelJobInput) => createPixelJob(input),
    onSuccess: (r) => {
      toast(`Started ${r.jobId}`)
      void queryClient.invalidateQueries({ queryKey: queryKeys.pixelStudio.jobs() })
      onStarted(r.jobId)
    },
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (tool === 'character8') start.mutate({ tool, description, size, colors, view, backend })
    else if (tool === 'animate') start.mutate({ tool, reference: reference || refs[0]?.value || '', action, frames, direction, size, colors, backend })
    else start.mutate({ tool, lower, upper, tileSize, colors, backend })
  }

  return (
    <form data-slot="pixel-generate" onSubmit={submit} className="flex max-w-2xl flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={FIELD}>
          Tool
          <select aria-label="Tool" className={SELECT} value={tool} onChange={(e) => setTool(e.target.value as typeof tool)}>
            <option value="character8">Character, 8 directions</option>
            <option value="animate">Animate a character</option>
            <option value="tileset">Terrain tileset (16 tiles)</option>
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

      {tool === 'character8' && (
        <>
          <label className={FIELD}>
            Description
            <Textarea aria-label="Description" required minLength={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="young female mage with a purple hooded robe, wooden staff with a cyan crystal" />
          </label>
          <label className={FIELD}>
            View
            <select aria-label="View" className={SELECT} value={view} onChange={(e) => setView(e.target.value as typeof view)}>
              <option value="low top-down">low top-down</option>
              <option value="high top-down">high top-down</option>
              <option value="side">side</option>
            </select>
          </label>
        </>
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

      <div className="grid gap-3 sm:grid-cols-2">
        {tool !== 'tileset' && (
          <label className={FIELD}>
            Size (logical px)
            <Input aria-label="Size" type="number" min={16} max={168} value={size} onChange={(e) => setSize(Number(e.target.value))} />
          </label>
        )}
        <label className={FIELD}>
          Colors
          <Input aria-label="Colors" type="number" min={4} max={64} value={colors} onChange={(e) => setColors(Number(e.target.value))} />
        </label>
      </div>
      <Button type="submit" className="w-fit" disabled={start.isPending || (tool === 'animate' && refs.length === 0)}>
        <SparklesIcon aria-hidden="true" /> {start.isPending ? 'Starting…' : 'Generate'}
      </Button>
      <p className="text-xs text-soft-foreground">
        Codex jobs run on this machine (1–3 minutes per image). GPU jobs wait in gpu-queue/ until the GPU cezar picks them up — sync the queue in the GPU tab.
      </p>
    </form>
  )
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
