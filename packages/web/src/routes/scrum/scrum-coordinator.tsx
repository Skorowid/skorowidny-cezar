/** SCRUM-COORD-01: the initial readiness gate, the author's product statements, and coordinator and agent choices. Author: Skorowid. */
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2Icon, CircleDashedIcon, SaveIcon } from 'lucide-react'
import type { ScrumAgentRole, ScrumCoordinatorConfig, ScrumState } from '@open-mercato/cezar-api-client'
import { getRunnerModels } from '@/api/client'
import { getScrumCoordinator, saveScrumCoordinator } from '@/api/scrum'
import { useProjectScope } from '@/api/project-scope-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export const UNCERTAIN_ESTIMATE = 'An uncertain forecast, not a promise or a deadline.'
export function formatMinutes(minutes: number) {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 6) / 10
  return `${hours} h`
}
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The operation failed.'
const RUNNERS = ['claude', 'codex', 'opencode', 'cursor', 'pi', 'junie', 'copilot'] as const
const ROLES: readonly [ScrumAgentRole, string, string][] = [
  ['consult', 'Consultation', 'Read-only: finds requirement gaps and assesses feasibility.'],
  ['implement', 'Implementation', 'Works in its own task worktree; never merges or pushes.'],
  ['review', 'Review', 'Independent verdict in its own worktree; advice, not acceptance.'],
]
const SOURCE: Record<string, string> = {
  override: 'the choice saved below',
  'project-default': 'this project\'s OpenCode model setting',
  'opencode-settings': 'OpenCode\'s own settings file',
  'opencode-own-default': 'OpenCode decides by its own configuration; cezar names no model',
  locked: 'models are locked on this server: OpenCode\'s own settings are authoritative',
}

export function useCoordinatorView(revision?: number) {
  const scope = useProjectScope()
  return useQuery({ queryKey: ['scrum-coordinator', scope.projectId, revision], queryFn: getScrumCoordinator, retry: false })
}

export function ReadinessPanel({ state }: { state: ScrumState }) {
  const view = useCoordinatorView(state.revision)
  const product = state.product
  const gate = view.data?.kickoff
  return <section aria-label="Readiness" className="grid gap-4 rounded-xl border border-border bg-card p-5">
    <div>
      <h2 className="font-semibold">Initial readiness</h2>
      {view.isPending && <p role="status" className="text-sm">Loading…</p>}
      {view.isError && <p role="alert" className="text-sm">{errorText(view.error)}</p>}
      {gate && <p className="mt-1 text-sm text-soft-foreground">{!gate.required
        ? 'This project already had a backlog when the coordinator started, so its existing items keep working without this gate. New work is still refined one slice at a time.'
        : gate.complete || !gate.blockers.length
          ? 'Passed: the coordinator may split approved work into tasks. Refinement continues one slice at a time.'
          : 'The coordinator cannot create the first tasks until this is complete. Answer it in the chat; nothing here is filled in for you.'}</p>}
    </div>
    {gate && gate.blockers.length > 0 && <div><h3 className="text-sm font-medium">Still open</h3><ul className="mt-1 grid list-disc gap-1 pl-5 text-sm">{gate.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul></div>}
    {gate && <div><h3 className="text-sm font-medium">Initial questions</h3><ul className="mt-2 grid gap-2">{gate.questions.map(question => <li key={question.id} className="flex gap-2 rounded-md bg-muted p-2 text-sm">
      {question.status === 'open' ? <CircleDashedIcon aria-label="Open" className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2Icon aria-label={question.status} className="mt-0.5 size-4 shrink-0" />}
      <div className="min-w-0"><p className="font-medium">{question.topic}{question.essential ? '' : ' (may be deferred)'} — {question.status}</p>
        <p className="whitespace-pre-wrap text-soft-foreground">{question.status === 'open' ? question.question : question.answer || 'Deferred by the author.'}</p></div>
    </li>)}</ul></div>}
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-lg bg-muted p-3 text-sm"><strong>Vision</strong><p className="mt-1 whitespace-pre-wrap">{product?.vision || 'Not stated yet.'}</p></div>
      <div className="rounded-lg bg-muted p-3 text-sm"><strong>Value and profit objectives</strong>
        {product?.valueObjectives.length
          ? <ul className="mt-1 grid gap-1">{product.valueObjectives.map(objective => <li key={objective.id}>{objective.statement}{objective.metric ? ` — measured by ${objective.metric}` : ''}{objective.target ? `, target ${objective.target}` : ''}</li>)}</ul>
          : <p className="mt-1">None stated. Only you define these; cezar assumes none.</p>}
      </div>
      <div className="rounded-lg bg-muted p-3 text-sm"><strong>Definition of Ready</strong><p className="mt-1 whitespace-pre-wrap">{product?.definitionOfReady || 'Not set yet.'}</p></div>
      <div className="rounded-lg bg-muted p-3 text-sm"><strong>Definition of Done</strong><p className="mt-1 whitespace-pre-wrap">{state.definitionOfDone || 'Not set yet.'}</p></div>
    </div>
    <p className="text-xs text-soft-foreground">The Product Goal, Sprint Goal, Definition of Done and the Sprint's limits come from Scrum. The initial gate, the Definition of Ready, minimum BRD/FRD and value objectives are this project's own additions. You remain the accountable Product Owner.</p>
  </section>
}

export function CoordinatorSettings() {
  const scope = useProjectScope()
  const queryClient = useQueryClient()
  const view = useQuery({ queryKey: ['scrum-coordinator', scope.projectId], queryFn: getScrumCoordinator, retry: false })
  const models = useQuery({ queryKey: ['runner-models', 'opencode'], queryFn: () => getRunnerModels('opencode'), retry: false, staleTime: 60_000 })
  const [config, setConfig] = useState<ScrumCoordinatorConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  useEffect(() => { setConfig(null); setMessage(null) }, [scope.projectId])
  const form = config ?? view.data?.config
  if (view.isPending) return <p role="status" className="text-sm">Loading the coordinator settings…</p>
  if (view.isError || !form || !view.data) return <p role="alert" className="text-sm">{errorText(view.error)}</p>
  const locked = view.data.modelsLocked
  async function save(next: ScrumCoordinatorConfig) {
    setBusy(true); setMessage(null)
    try {
      // Read fresh: the coordinator changes the backlog between saves, and this form only touches its own part.
      const fresh = await getScrumCoordinator()
      const saved = await saveScrumCoordinator({ expectedRevision: fresh.revision, config: next })
      queryClient.setQueryData(['scrum-coordinator', scope.projectId], saved)
      void queryClient.invalidateQueries({ queryKey: ['scrum', scope.projectId] })
      setConfig(null); setMessage({ error: false, text: 'Settings saved. They apply to the next assignment; the coordinator picks up a changed model when its session reopens.' })
    } catch (problem) { setMessage({ error: true, text: errorText(problem) }) } finally { setBusy(false) }
  }
  const setRole = (role: ScrumAgentRole, patch: Partial<ScrumCoordinatorConfig['agents'][ScrumAgentRole]>) =>
    setConfig({ ...form, agents: { ...form.agents, [role]: { ...form.agents[role], ...patch } } })
  return <section aria-label="Coordinator and agents" className="grid gap-4 rounded-xl border border-border bg-card p-5">
    <h2 className="font-semibold">Coordinator and agents</h2>
    <div className="grid gap-1.5 text-sm">
      <p>The coordinator always runs on <strong>OpenCode</strong>. Current model: <strong>{view.data.resolvedModel ?? 'OpenCode\'s own choice'}</strong> <span className="text-soft-foreground">— from {SOURCE[view.data.modelSource]}.</span></p>
      <label className="grid gap-1"><span className="font-medium">Coordinator model override</span>
        <Input list="scrum-opencode-models" disabled={locked} placeholder="Empty: use the configured OpenCode choice" value={form.model ?? ''} onChange={event => setConfig({ ...form, model: event.target.value.trim() || null })} /></label>
      <datalist id="scrum-opencode-models">{models.data?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
      {models.data?.source === 'unavailable' && <p className="text-xs text-soft-foreground">OpenCode's model list is unavailable: {models.data.reason ?? 'no reason given'}.</p>}
    </div>
    <div className="grid gap-3">{ROLES.map(([role, title, hint]) => <fieldset key={role} className="grid gap-2 rounded-lg bg-muted p-3 text-sm sm:grid-cols-2">
      <legend className="px-1 font-medium">{title}</legend>
      <p className="text-xs text-soft-foreground sm:col-span-2">{hint}</p>
      <label className="grid gap-1"><span>Runner</span><select aria-label={`${title} runner`} className="h-9 w-full rounded-md border border-input bg-card px-2" value={form.agents[role].runner ?? ''} onChange={event => setRole(role, { runner: (event.target.value || null) as ScrumCoordinatorConfig['agents'][ScrumAgentRole]['runner'] })}>
        <option value="">Project default runner</option>{RUNNERS.map(runner => <option key={runner} value={runner}>{runner}</option>)}</select></label>
      <label className="grid gap-1"><span>Model</span><Input aria-label={`${title} model`} disabled={locked} placeholder="Empty: the runner's configured choice" value={form.agents[role].model ?? ''} onChange={event => setRole(role, { model: event.target.value.trim() || null })} /></label>
    </fieldset>)}</div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.autoReview} onChange={event => setConfig({ ...form, autoReview: event.target.checked })} /> Start one independent review when an implementation attempt settles</label>
    {locked && <p className="text-xs text-soft-foreground">Models are locked on this server, so model names cannot be set here; runners can.</p>}
    <div><Button disabled={busy || !config} onClick={() => void save(form)}><SaveIcon className="size-4" /> {busy ? 'Saving…' : 'Save coordinator settings'}</Button></div>
    {message && <p role={message.error ? 'alert' : 'status'} className="text-sm">{message.text}</p>}
  </section>
}
