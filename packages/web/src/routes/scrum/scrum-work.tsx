/** SCRUM-COORD-01: what other agents are doing and what they really returned, with verified results only. Author: Skorowid. */
import { useState } from 'react'
import { ExternalLinkIcon, FileIcon } from 'lucide-react'
import type { ScrumArtifact, ScrumState, ScrumWork } from '@open-mercato/cezar-api-client'
import { checkScrumArtifact, scrumArtifactUrl } from '@/api/scrum'
import { Link } from '@/lib/project-router'
import { Button } from '@/components/ui/button'

const KIND: Record<ScrumWork['kind'], string> = { consult: 'Consultation', implement: 'Implementation', review: 'Review' }
const STATUS: Record<ScrumWork['status'], string> = { pending: 'Not started', active: 'Queued or running', waiting: 'Waiting for an answer', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }
const ARTIFACT_STATUS: Record<ScrumArtifact['status'], string> = { verified: 'Verified copy', rejected: 'Rejected', unchecked: 'Not checked', reachable: 'Answered when checked', unreachable: 'No answer when checked' }
const SOURCE = { structured: 'structured result', transcript: 'final text only: no structured result', none: 'the run returned no text' } as const
/** The server already validated it; a link is rendered only for what still looks like a local address. */
const isLocalLink = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+(\/|$)/i.test(url)

function ArtifactRow({ artifact, onCheck, busy }: { artifact: ScrumArtifact; onCheck: (id: string) => void; busy: boolean }) {
  const title = artifact.label || artifact.declared || artifact.kind
  const provenance = `Run ${artifact.runId.slice(0, 8)} · ${new Date(artifact.capturedAt).toLocaleString()}${artifact.checkedAt ? ` · checked ${new Date(artifact.checkedAt).toLocaleString()}` : ''}${artifact.sha256 ? ` · sha256 ${artifact.sha256.slice(0, 12)}` : ''}`
  return <li className="grid gap-1 rounded-md bg-card p-2 text-sm">
    <p><span className="font-medium">{title}</span> <span className="text-xs text-soft-foreground">· {artifact.kind} · {ARTIFACT_STATUS[artifact.status]}</span></p>
    {artifact.status === 'verified' && artifact.kind === 'screenshot' && <a href={scrumArtifactUrl(artifact.id)} target="_blank" rel="noreferrer noopener"><img src={scrumArtifactUrl(artifact.id)} alt={title} loading="lazy" className="max-h-80 rounded-md border border-border" /></a>}
    {artifact.status === 'verified' && artifact.kind === 'file' && <a className="inline-flex items-center gap-1 text-primary underline" href={scrumArtifactUrl(artifact.id)} rel="noreferrer noopener"><FileIcon className="size-4" /> Download ({artifact.bytes ?? 0} bytes)</a>}
    {artifact.kind === 'preview' && artifact.url && isLocalLink(artifact.url) && <div className="flex flex-wrap items-center gap-2">
      <a className="inline-flex items-center gap-1 text-primary underline" href={artifact.url} target="_blank" rel="noreferrer noopener"><ExternalLinkIcon className="size-4" /> {artifact.url}</a>
      <Button variant="outline" disabled={busy} onClick={() => onCheck(artifact.id)}>Check now</Button>
    </div>}
    {artifact.kind !== 'preview' && artifact.status === 'rejected' && <p className="break-all text-xs text-soft-foreground">Declared: {artifact.declared || 'nothing'}</p>}
    <p className="text-xs text-soft-foreground">{artifact.reason}</p>
    <p className="text-xs text-soft-foreground">{provenance}</p>
  </li>
}

export function ScrumWorkPanel({ state, onState }: { state: ScrumState; onState: (state: ScrumState) => void }) {
  const work = [...(state.work ?? [])].reverse()
  const held = state.chat?.inbox ?? []
  const documents = new Map((state.documents ?? []).map(document => [document.id, document]))
  const items = new Map(state.items.map(item => [item.id, item]))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function check(id: string) {
    setBusy(true); setError('')
    try { onState(await checkScrumArtifact(id)) } catch (problem) { setError(problem instanceof Error ? problem.message : 'The check failed.') } finally { setBusy(false) }
  }
  return <section aria-label="Agents and results" className="grid gap-3">
    {held.length > 0 && <p role="status" className="rounded-lg border border-border bg-muted p-3 text-sm">{held.length} result{held.length === 1 ? '' : 's'} recorded and not yet with the coordinator: {held[0]!.detail}</p>}
    {error && <p role="alert" className="text-sm">{error}</p>}
    {!work.length && <p className="rounded-xl border border-dashed border-border p-5 text-sm text-soft-foreground">No agent has been assigned yet. The coordinator consults other agents on requirements; ready, approved tasks are queued for free agents and reviewed when they settle.</p>}
    {work.map(entry => {
      const result = entry.result
      const document = result?.documentId ? documents.get(result.documentId) : undefined
      return <article key={entry.id} className="grid gap-2 rounded-xl border border-border bg-card p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">{KIND[entry.kind]}{entry.itemId ? `: ${items.get(entry.itemId)?.title ?? 'removed item'}` : ''}</h3>
          <span className={entry.status === 'failed' ? 'text-xs font-medium text-destructive' : 'text-xs text-soft-foreground'}>{STATUS[entry.status]}{result?.verdict ? ` · verdict: ${result.verdict}` : ''}</span>
        </div>
        <p className="whitespace-pre-wrap text-soft-foreground">{entry.request}</p>
        <p className="text-xs text-soft-foreground">{entry.runner ?? 'default runner'}{entry.model ? ` · ${entry.model}` : ''}{entry.branch ? ` · branch ${entry.branch}` : ''}{entry.runId && <> · <Link className="text-primary underline" to={`/tasks/${entry.runId}`}>run {entry.runId.slice(0, 8)}</Link>{entry.kind === 'implement' && <> · <Link className="text-primary underline" to={`/tasks/${entry.runId}/preview`}>open the task's Preview tab</Link></>}</>}</p>
        {entry.detail && <p className="text-xs">{entry.detail}</p>}
        {result && <div className="grid gap-1 rounded-lg bg-muted p-3">
          <p className="text-xs text-soft-foreground">From the run's transcript: {SOURCE[result.source]} · {new Date(result.capturedAt).toLocaleString()}{document ? ` · ${document.code} v${result.documentVersion}` : ''}</p>
          {result.summary && <p className="whitespace-pre-wrap">{result.summary}</p>}
          {result.gaps.length > 0 && <div><strong>Gaps</strong><ul className="list-disc pl-5">{result.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></div>}
          {result.blockers.length > 0 && <div><strong>Blockers</strong><ul className="list-disc pl-5">{result.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul></div>}
          {result.feasibility && <p className="whitespace-pre-wrap"><strong>Feasibility: </strong>{result.feasibility}</p>}
        </div>}
        {entry.artifacts.length > 0 && <div className="grid gap-1"><strong>Presented results</strong><ul className="grid gap-2">{entry.artifacts.map(artifact => <ArtifactRow key={artifact.id} artifact={artifact} onCheck={id => void check(id)} busy={busy} />)}</ul></div>}
      </article>
    })}
    <p className="text-xs text-soft-foreground">An agent's result or review verdict is input for your decision. It does not approve a requirement or mark work Done.</p>
  </section>
}
