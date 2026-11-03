/** SCRUM-COORD-01: versioned Markdown documents, with human approval of one exact version. Author: Skorowid. */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ScrumDocument, ScrumState } from '@open-mercato/cezar-api-client'
import { SCRUM_APPROVABLE_DOCUMENT_KINDS } from '@open-mercato/cezar-api-client'
import { decideScrumDocument, getScrumDocument } from '@/api/scrum'
import { useProjectScope } from '@/api/project-scope-context'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/routes/task-thread/markdown'

const KIND: Record<ScrumDocument['kind'], string> = {
  brd: 'BRD', frd: 'FRD', story: 'User story', decision: 'Decision', context: 'Context packet', consultation: 'Consultation', review: 'Review', implementation: 'Implementation result',
}
const GROUPS: readonly [string, readonly ScrumDocument['kind'][]][] = [
  ['Requirements and decisions', SCRUM_APPROVABLE_DOCUMENT_KINDS],
  ['What agents returned', ['consultation', 'review', 'implementation']],
  ['Context handed to runs', ['context']],
]
const latestOf = (document: ScrumDocument) => document.versions[document.versions.length - 1]!
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The operation failed.'

function approvalLabel(document: ScrumDocument) {
  if (!SCRUM_APPROVABLE_DOCUMENT_KINDS.includes(document.kind)) return 'Not a decision: needs no approval'
  if (!document.approval) return 'Not approved'
  const when = new Date(document.approval.at).toLocaleString()
  return document.approval.version === latestOf(document).version
    ? `Approved v${document.approval.version} (${document.approval.by}, ${when})`
    : `Only v${document.approval.version} is approved; v${latestOf(document).version} is not`
}

export function ScrumDocuments({ state, onState }: { state: ScrumState; onState: (state: ScrumState) => void }) {
  const scope = useProjectScope()
  const documents = state.documents ?? []
  const [selected, setSelected] = useState<string | null>(null)
  const [wanted, setWanted] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const document = documents.find(entry => entry.id === selected) ?? null
  const version = document ? wanted ?? latestOf(document).version : null
  const content = useQuery({
    queryKey: ['scrum-document', scope.projectId, selected, version],
    queryFn: () => getScrumDocument(selected!, version!),
    enabled: !!selected && version !== null,
    retry: false,
  })
  async function decide(decision: 'approve' | 'revoke') {
    if (!document || version === null) return
    setBusy(true); setError('')
    try { onState(await decideScrumDocument(document.id, { expectedRevision: state.revision, version, decision })) } catch (problem) { setError(errorText(problem)) } finally { setBusy(false) }
  }
  if (!documents.length) return <p className="rounded-xl border border-dashed border-border p-5 text-sm text-soft-foreground">No documents yet. The coordinator drafts the minimum BRD and FRD in Markdown once it has asked its initial questions; you approve them here or in the chat.</p>
  const approvable = document && SCRUM_APPROVABLE_DOCUMENT_KINDS.includes(document.kind)
  return <section aria-label="Documents" className="grid items-start gap-5 lg:grid-cols-[minmax(230px,1fr)_minmax(0,2fr)]">
    <div className="grid gap-4">{GROUPS.map(([title, kinds]) => {
      const rows = documents.filter(entry => kinds.includes(entry.kind))
      return rows.length > 0 && <div key={title} className="grid gap-2"><h3 className="text-sm font-medium">{title}</h3>{rows.map(row => <button key={row.id} onClick={() => { setSelected(row.id); setWanted(null); setError('') }} className={`rounded-xl border p-3 text-left ${selected === row.id ? 'border-primary bg-primary/5' : 'border-border bg-card'}`}>
        <p className="text-xs text-soft-foreground">{row.code} · {KIND[row.kind]} · v{latestOf(row).version}</p>
        <p className="mt-1 text-sm font-medium">{row.title}</p>
        <p className="mt-1 text-xs text-soft-foreground">{approvalLabel(row)}</p>
      </button>)}</div>
    })}</div>
    {document ? <article className="grid min-w-0 gap-3 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{document.code} — {document.title}</h3>
        <select aria-label="Version" className="h-9 rounded-md border border-input bg-card px-2 text-sm" value={version ?? ''} onChange={event => setWanted(Number(event.target.value))}>
          {[...document.versions].reverse().map(entry => <option key={entry.version} value={entry.version}>v{entry.version} · {new Date(entry.at).toLocaleString()}</option>)}
        </select>
      </div>
      <p className="text-xs text-soft-foreground">{approvalLabel(document)} · written by {document.versions.find(entry => entry.version === version)?.source ?? 'unknown'}{document.versions.find(entry => entry.version === version)?.summary ? ` · ${document.versions.find(entry => entry.version === version)?.summary}` : ''}</p>
      {approvable && <div className="flex flex-wrap gap-2">
        <Button disabled={busy || version !== latestOf(document).version || document.approval?.version === version} onClick={() => void decide('approve')}>Approve v{version}</Button>
        <Button variant="outline" disabled={busy || document.approval?.version !== version} onClick={() => void decide('revoke')}>Withdraw approval</Button>
      </div>}
      {error && <p role="alert" className="text-sm">{error}</p>}
      {content.isPending && <p role="status" className="text-sm">Loading…</p>}
      {content.isError && <p role="alert" className="text-sm">{errorText(content.error)}</p>}
      {content.data && content.data.integrity !== 'ok' && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-sm">{content.data.integrity === 'missing' ? 'This version\'s file is missing.' : 'This file no longer matches the recorded hash: it was changed outside cezar. Do not treat it as the approved text.'}</p>}
      {content.data && content.data.content && <Markdown variant="document">{content.data.content}</Markdown>}
      {content.data && <p className="break-all text-xs text-soft-foreground">File: {content.data.path}</p>}
    </article> : <div className="rounded-xl border border-dashed border-border p-8 text-sm text-soft-foreground">Select a document.</div>}
  </section>
}
