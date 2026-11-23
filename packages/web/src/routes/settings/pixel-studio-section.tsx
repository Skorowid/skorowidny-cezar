import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SparklesIcon } from 'lucide-react'
import { useState } from 'react'

import { setPixelStudioHome, setPixelStudioProject } from '@/api/client'
import { usePixelStudioStatus, workspaceQueryKeys } from '@/api/queries'
import type { PixelStudioProject, PixelStudioStatus } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'

/**
 * Settings → global → Pixel Studio (fork; docs/skorowidny-cezar/pixel-studio.md): where the
 * PixelForge checkout lives, whether Codex/Aseprite are available, and one switch per project
 * that adds or removes its private `pixelforge` MCP entry.
 *
 * Author: Skorowid
 */
export function PixelStudioSection() {
  const status = usePixelStudioStatus()
  if (status.isPending) return <p className="p-4 text-ui text-soft-foreground md:p-6">Loading Pixel Studio settings…</p>
  if (status.isError) {
    return <CenteredState icon={<SparklesIcon />} tone="danger" title="Pixel Studio settings did not load" subtitle={status.error.message} heading="h2" />
  }
  return <PixelStudioPanel status={status.data} />
}

const STATUS_LABEL: Record<PixelStudioProject['status'], string> = {
  connected: 'Connected',
  disconnected: 'Not connected',
  foreign: 'Custom entry',
  broken: 'Config broken',
  missing: 'Folder missing',
}

function PixelStudioPanel({ status }: { status: PixelStudioStatus }) {
  const queryClient = useQueryClient()
  const [home, setHome] = useState(status.home ?? '')
  const onResult = (result: PixelStudioStatus) => queryClient.setQueryData(workspaceQueryKeys.pixelStudio, result)
  const onError = (error: Error) => {
    toast(error.message, { tone: 'danger' })
    void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.pixelStudio })
  }
  const saveHome = useMutation({ mutationFn: () => setPixelStudioHome({ home }), onSuccess: onResult, onError })
  const toggle = useMutation({
    mutationFn: ({ id, connected }: { id: string; connected: boolean }) => setPixelStudioProject(id, { connected }),
    onSuccess: onResult,
    onError,
  })
  return (
    <div data-slot="pixel-studio-settings" className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6">
      <p className="text-sm text-muted-foreground">
        PixelForge — local PixelLab-style tools: 8-direction characters, animations and tilesets drawn by Codex image_gen (or the GPU cezar) and cleaned into true pixel art. Jobs appear in each project’s Pixel Studio page.
      </p>
      <section className="flex flex-col gap-2 rounded-md border border-border p-3">
        <h2 className="text-sm font-semibold text-foreground">This machine</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ui">
          <dt className="text-muted-foreground">PixelForge</dt>
          <dd data-slot="pixel-installed">{status.installed ? 'ready' : 'not configured'}</dd>
          <dt className="text-muted-foreground">Codex image_gen</dt>
          <dd>{status.codex ? 'available' : 'codex not on PATH'}</dd>
          <dt className="text-muted-foreground">Aseprite</dt>
          <dd>{status.aseprite ? 'available' : 'not installed (optional, for retouching)'}</dd>
        </dl>
        {status.writable && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              saveHome.mutate()
            }}
          >
            <Input aria-label="PixelForge checkout" value={home} onChange={(e) => setHome(e.target.value)} placeholder="/home/you/ai-projects/PixelArt_Skorowid_Games" />
            <Button type="submit" variant="outline" disabled={saveHome.isPending || !home.startsWith('/')}>Save</Button>
          </form>
        )}
        {status.problems.length > 0 && (
          <ul data-slot="pixel-problems" className="flex flex-col gap-1 text-ui text-warning">
            {status.problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Projects</h2>
          <p className="text-ui text-muted-foreground">
            A connected project gives its tasks’ agents the PixelForge tools (Claude, Codex, OpenCode, Junie, Copilot). Jobs land in the project’s assets/jobs library. The change applies to the next task.
          </p>
        </div>
        <ul className="flex flex-col gap-1">
          {status.projects.map((project) => {
            const connected = project.status === 'connected'
            const togglable = connected || project.status === 'disconnected'
            return (
              <li key={project.id} data-slot="pixel-project" data-project-id={project.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-ui">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-foreground">{project.name}</span>
                  {project.problem && <span className="text-soft-foreground">{project.problem}</span>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="outline" className={connected ? 'border-primary text-primary' : undefined}>{STATUS_LABEL[project.status]}</Badge>
                  <Switch
                    aria-label={`Pixel Studio for ${project.name}`}
                    checked={connected}
                    disabled={!status.writable || !togglable || toggle.isPending || (!connected && !status.installed)}
                    onCheckedChange={(next) => toggle.mutate({ id: project.id, connected: next })}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
