import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BoxIcon } from 'lucide-react'

import { setMeshyProject } from '@/api/client'
import { useMeshyStatus, workspaceQueryKeys } from '@/api/queries'
import type { MeshyProject, MeshyStatus } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'

/**
 * Settings → global → Meshy AI (fork; docs/skorowidny-cezar/meshy-integration.md): the install
 * state of the Meshy MCP server and one switch per project that adds or removes its private
 * `meshy` MCP entry. The API key is set in a terminal (`meshy_mcp.py set-key`), never here.
 *
 * Author: Skorowid
 */
export function MeshySection() {
  const status = useMeshyStatus()
  if (status.isPending) {
    return (
      <p data-slot="meshy-settings-loading" className="p-4 text-ui text-soft-foreground md:p-6">
        Loading Meshy settings…
      </p>
    )
  }
  if (status.isError) {
    return (
      <CenteredState
        icon={<BoxIcon />}
        tone="danger"
        title="Meshy settings did not load"
        subtitle={status.error.message}
        heading="h2"
      />
    )
  }
  return <MeshyPanel status={status.data} />
}

const STATUS_LABEL: Record<MeshyProject['status'], string> = {
  connected: 'Connected',
  disconnected: 'Not connected',
  foreign: 'Custom entry',
  broken: 'Config broken',
  missing: 'Folder missing',
}

function MeshyPanel({ status }: { status: MeshyStatus }) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: ({ id, connected }: { id: string; connected: boolean }) => setMeshyProject(id, { connected }),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.meshy, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const ready = status.installed && status.keyPresent && status.keyPrivate
  return (
    <div
      data-slot="meshy-settings-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <p className="text-sm text-muted-foreground">
        3D generation as a tool for the agents of the projects you connect. Every generation uses
        Meshy credits; set a monthly credit limit on the API key.
      </p>

      <section data-slot="meshy-install" className="flex flex-col gap-2 rounded-md border border-border p-3">
        <h2 className="text-sm font-semibold text-foreground">This machine</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ui">
          <dt className="text-muted-foreground">Server</dt>
          <dd data-slot="meshy-server">{status.installed ? `installed, ${status.version}` : 'not installed'}</dd>
          <dt className="text-muted-foreground">API key</dt>
          <dd data-slot="meshy-key">
            {!status.keyPresent ? 'not set' : status.keyPrivate ? 'set (private file)' : 'set, but readable by others'}
          </dd>
          <dt className="text-muted-foreground">Downloads</dt>
          <dd data-slot="meshy-output" className="break-all">
            {status.outputDir ?? 'the server’s private work folder'}
          </dd>
        </dl>
        {status.problems.length > 0 && (
          <ul data-slot="meshy-problems" className="flex flex-col gap-1 text-ui text-warning">
            {status.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </section>

      <section data-slot="meshy-projects" className="flex flex-col gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Projects</h2>
          <p className="text-ui text-muted-foreground">
            A connected project gives every task’s agent the Meshy tools; the change applies to the
            next task, no restart needed.
            {!status.writable && ' Connecting is only possible on the machine hosting cezar.'}
          </p>
        </div>
        {status.projects.length === 0 ? (
          <p className="text-ui text-soft-foreground">No registered projects.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {status.projects.map((project) => {
              const connected = project.status === 'connected'
              const togglable = connected || project.status === 'disconnected'
              const busy = toggle.isPending && toggle.variables?.id === project.id
              return (
                <li
                  key={project.id}
                  data-slot="meshy-project"
                  data-project-id={project.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-ui"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-foreground">{project.name}</span>
                    {project.problem && <span className="text-soft-foreground">{project.problem}</span>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline" className={connected ? 'border-primary text-primary' : undefined}>
                      {STATUS_LABEL[project.status]}
                    </Badge>
                    <Switch
                      aria-label={`Meshy for ${project.name}`}
                      checked={connected}
                      disabled={!status.writable || !togglable || busy || (!connected && !ready)}
                      onCheckedChange={(next) => toggle.mutate({ id: project.id, connected: next })}
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
