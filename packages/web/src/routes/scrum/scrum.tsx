/** SCRUM-LOCAL-01 / SCRUM-CHAT-01: chat-driven backlog, planning and decision notebook. Author: Skorowid. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpenIcon, KanbanIcon, PlayIcon, SaveIcon, SparklesIcon } from 'lucide-react'
import type { ScrumState, ScrumItem, ScrumSprint, ScrumNote } from '@open-mercato/cezar-api-client'
import { getScrum, saveScrum, launchScrum } from '@/api/scrum'
import { useProjectScope } from '@/api/project-scope-context'
import { Link } from '@/lib/project-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ScrumChat } from './scrum-chat'

const selectClass = 'h-9 w-full rounded-md border border-input bg-card px-2 text-sm'
const dorStatuses = ['NEEDS CLARIFICATION', 'READY', 'BLOCKED', 'CHANGE REQUEST'] as const
const noteLabels = { general: 'Note', planning: 'Sprint Planning', daily: 'Daily Scrum', review: 'Sprint Review', retrospective: 'Sprint Retrospective', refinement: 'Refinement', decision: 'Decision', question: 'Question' } as const
const lines = (value: string) => value.split('\n').map(x => x.trim()).filter(Boolean)
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The operation failed.'

function Field({ title, children }: { title: string; children: ReactNode }) {
  return <label className="grid gap-1.5 text-sm"><span className="font-medium">{title}</span>{children}</label>
}

function LinesInput({ value, onChange, rows = 3 }: { value: string[]; onChange: (next: string[]) => void; rows?: number }) {
  const [raw, setRaw] = useState(value.join('\n'))
  useEffect(() => { if (lines(raw).join('\n') !== value.join('\n')) setRaw(value.join('\n')) }, [value, raw])
  return <Textarea rows={rows} value={raw} onChange={event => { setRaw(event.target.value); onChange(lines(event.target.value)) }} />
}

export function ScrumRoute() {
  const scope = useProjectScope()
  const queryClient = useQueryClient()
  const currentProject = useRef(scope.projectId)
  currentProject.current = scope.projectId
  const key = ['scrum', scope.projectId]
  const query = useQuery({ queryKey: key, queryFn: getScrum, retry: false })
  const [draft, setDraft] = useState<ScrumState | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState<'backlog' | 'sprints' | 'notes' | 'product'>('backlog')
  const [selected, setSelected] = useState<string | null>(null)
  const [noteBody, setNoteBody] = useState('')
  const [noteKind, setNoteKind] = useState<ScrumNote['kind']>('general')
  const [noteItem, setNoteItem] = useState('')
  const [noteSprint, setNoteSprint] = useState('')
  const messageRef = useRef<HTMLDivElement>(null)
  // The chat agent changes the backlog between saves; take a newer revision, never an older one.
  const onChatState = useCallback((state: ScrumState) => {
    const current = queryClient.getQueryData<ScrumState>(['scrum', scope.projectId])
    if (!current || state.revision > current.revision) queryClient.setQueryData(['scrum', scope.projectId], state)
  }, [queryClient, scope.projectId])

  useEffect(() => { setDraft(null); setDirty(false); setSelected(null); setError(''); setNotice('') }, [scope.projectId])
  // Launch buttons sit far below the message area; bring a refusal or confirmation into view.
  useEffect(() => { if (error || notice) messageRef.current?.scrollIntoView?.({ block: 'nearest' }) }, [error, notice])
  useEffect(() => { if (query.data && !dirty) setDraft(structuredClone(query.data)) }, [query.data, dirty])
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [dirty])

  function edit(next: ScrumState) { setDraft(next); setDirty(true); setError(''); setNotice('') }
  function changeItem(id: string, patch: Partial<ScrumItem>) {
    if (draft) edit({ ...draft, items: draft.items.map(x => x.id === id ? { ...x, ...patch } : x) })
  }
  function changeSprint(id: string, patch: Partial<ScrumSprint>) {
    if (draft) edit({ ...draft, sprints: draft.sprints.map(x => x.id === id ? { ...x, ...patch } : x) })
  }
  async function commit(state: ScrumState) {
    const requestProject = scope.projectId
    setBusy(true); setError(''); setNotice('')
    try {
      const saved = await saveScrum({ expectedRevision: state.revision, state })
      queryClient.setQueryData(key, saved); if (currentProject.current !== requestProject) return false; setDraft(structuredClone(saved)); setDirty(false); setNotice('Changes saved.'); return true
    } catch (problem) { if (currentProject.current === requestProject) setError(errorText(problem)); return false }
    finally { setBusy(false) }
  }
  async function launch(item: ScrumItem, mode: 'implement' | 'refine') {
    if (!draft || dirty) return
    const requestProject = scope.projectId
    setBusy(true); setError(''); setNotice('')
    try {
      const answer = await launchScrum(item.id, draft.revision, mode)
      queryClient.setQueryData(key, answer.state); if (currentProject.current !== requestProject) return; setDraft(structuredClone(answer.state)); setDirty(false)
      setNotice(`Started ${mode === 'refine' ? 'BA refinement' : 'implementation'} — ${answer.runId.slice(0, 8)}. Open the linked run below.`)
    } catch (problem) { if (currentProject.current === requestProject) setError(errorText(problem)) }
    finally { setBusy(false) }
  }
  if (query.isPending) return <div role="status" className="p-8">Loading Scrum…</div>
  if (!draft) return <div className="p-8"><p role="alert">{errorText(query.error)}</p><Button onClick={() => void query.refetch()}>Try again</Button></div>

  const item = draft.items.find(x => x.id === selected) ?? null
  const active = draft.sprints.find(x => x.status === 'active')
  const stale = dirty && query.data && query.data.revision !== draft.revision
  return <div data-route="scrum" className="min-h-full bg-background">
    <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-5 py-3">
      <div><h1 className="flex items-center gap-2 text-lg font-semibold"><KanbanIcon className="size-5" /> Scrum</h1><p className="text-xs text-soft-foreground">Local project backlog · revision {draft.revision}{dirty ? ' · unsaved changes' : ''}</p></div>
      <div className="flex gap-2"><Button variant="outline" disabled={busy || dirty} onClick={() => void query.refetch()}>Reload</Button><Button disabled={busy || !dirty} onClick={() => void commit(draft)}><SaveIcon className="size-4" /> {busy ? 'Saving…' : 'Save changes'}</Button></div>
    </header>
    <div className="mx-auto grid max-w-7xl gap-5 p-4 md:p-6">
      <div ref={messageRef} className="grid scroll-mt-20 gap-3 empty:hidden">
        {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">{error} {dirty && 'Your unsaved changes are kept in the form.'}</p>}
        {notice && <p role="status" className="rounded-lg border border-border bg-muted p-3 text-sm">{notice}</p>}
      </div>
      {stale && <p role="alert" className="text-sm text-amber-600">Another session saved a newer revision. Saving will be refused so it is not overwritten. Copy your changes before reloading the page.</p>}
      <section className="grid gap-3 md:grid-cols-3" aria-label="Goals and progress">
        <div className="rounded-xl border border-border bg-card p-4"><p className="text-xs text-soft-foreground">Product Goal</p><p className="mt-1 whitespace-pre-wrap text-sm">{draft.productGoal || 'Set the Product Goal in product settings.'}</p></div>
        <div className="rounded-xl border border-border bg-card p-4"><p className="text-xs text-soft-foreground">Sprint Goal</p><p className="mt-1 whitespace-pre-wrap text-sm">{active ? `${active.name}: ${active.goal}` : 'No active Sprint.'}</p></div>
        <div className="rounded-xl border border-border bg-card p-4"><p className="text-xs text-soft-foreground">Product Backlog</p><p className="mt-1 text-xl font-semibold">{draft.items.length} PBI <span className="text-sm font-normal text-soft-foreground">· {draft.items.filter(x => x.dorStatus === 'READY').length} READY · {draft.items.filter(x => x.deliveryStatus === 'done').length} Done</span></p></div>
      </section>
      <ScrumChat onState={onChatState} />
      <nav aria-label="Scrum views" className="flex flex-wrap gap-2">{([['backlog', 'Backlog'], ['sprints', 'Sprints'], ['notes', 'Notebook'], ['product', 'Product settings']] as const).map(([value, title]) => <Button key={value} variant={tab === value ? 'primary' : 'outline'} aria-pressed={tab === value} onClick={() => setTab(value)}>{title}</Button>)}</nav>
      <fieldset disabled={busy} className="min-w-0">
        {tab === 'backlog' && <div className="grid items-start gap-5 lg:grid-cols-[minmax(230px,1fr)_minmax(0,2fr)]">
          <section className="grid gap-3">
            {draft.items.length === 0 && <p className="rounded-xl border border-dashed border-border p-5 text-sm text-soft-foreground">The backlog is empty. Describe the work to the Scrum assistant above; it records items, asks for what is missing and splits complex work into tasks.</p>}
            {[...draft.items].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)).map(row => <button key={row.id} onClick={() => setSelected(row.id)} className={`rounded-xl border p-4 text-left ${item?.id === row.id ? 'border-primary bg-primary/5' : 'border-border bg-card'}`}><p className="text-xs text-soft-foreground">#{row.priority} · {row.dorStatus}{row.group ? ` · ${row.group}` : ''}</p><p className="mt-1 font-medium">{row.title}</p><p className="mt-2 text-xs text-soft-foreground">{row.deliveryStatus} · {row.runIds.length} runs · {row.questions.length} questions{row.autoRunId ? ' · queued automatically' : ''}</p></button>)}
          </section>
          {item ? <section className="grid gap-4 rounded-xl border border-border bg-card p-5" aria-label="Edit PBI">
            <Field title="PBI title"><Input value={item.title} onChange={e => changeItem(item.id, { title: e.target.value })} /></Field>
            <Field title="BA description / stated need"><Textarea rows={5} value={item.description} onChange={e => changeItem(item.id, { description: e.target.value })} /></Field>
            <Field title="Acceptance criteria — one per line"><LinesInput key={item.id + '-criteria'} value={item.acceptanceCriteria} onChange={value => changeItem(item.id, { acceptanceCriteria: value })} /></Field>
            <Field title="Open BA questions — one per line"><LinesInput key={item.id + '-questions'} value={item.questions} onChange={value => changeItem(item.id, { questions: value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2"><Field title="DoR status"><select className={selectClass} value={item.dorStatus} onChange={e => changeItem(item.id, { dorStatus: e.target.value as ScrumItem['dorStatus'] })}>{dorStatuses.map(x => <option key={x}>{x}</option>)}</select></Field><Field title="Backlog order"><Input type="number" min={1} value={item.priority} onChange={e => changeItem(item.id, { priority: Number(e.target.value) })} /></Field></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={item.approved} onChange={e => changeItem(item.id, { approved: e.target.checked })} /> Requirements of this item are approved</label>
            <Field title="Dependencies"><div className="grid gap-2">{draft.items.filter(x => x.id !== item.id).map(dep => <label key={dep.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={item.dependencies.includes(dep.id)} onChange={e => changeItem(item.id, { dependencies: e.target.checked ? [...item.dependencies, dep.id] : item.dependencies.filter(x => x !== dep.id) })} /> {dep.title} ({dep.deliveryStatus})</label>)}{draft.items.length < 2 && <span className="text-soft-foreground">No other PBIs.</span>}</div></Field>
            <Field title="Delivery status"><select className={selectClass} value={item.deliveryStatus} onChange={e => changeItem(item.id, { deliveryStatus: e.target.value as ScrumItem['deliveryStatus'] })}><option value="open">Open</option><option value="in_progress">In progress</option><option value="done">Done — confirmed</option></select></Field>
            <Field title="Definition of Done evidence"><Textarea rows={3} placeholder="Check results, review and links to the usable Increment" value={item.doneEvidence} onChange={e => changeItem(item.id, { doneEvidence: e.target.value })} /></Field>
            <div className="rounded-lg bg-muted p-3 text-sm"><strong>Definition of Done</strong><p className="mt-1 whitespace-pre-wrap">{draft.definitionOfDone || 'Set it in product settings.'}</p></div>
            {item.autoQueue && <p className="rounded-lg bg-muted p-3 text-sm">{item.autoRunId ? <>Queued automatically as run <Link className="text-primary underline" to={`/tasks/${item.autoRunId}`}>{item.autoRunId.slice(0, 8)}</Link> when it became executable.</> : 'Created in the Scrum chat: it is queued for a free agent automatically as soon as it is executable.'}</p>}
            {item.provenance && item.provenance.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-soft-foreground">Chat decisions behind this item ({item.provenance.length})</summary><ul className="mt-2 grid gap-1">{item.provenance.map((source, index) => <li key={index} className="rounded-md bg-muted p-2">“{source.quote}” <span className="text-xs text-soft-foreground">· {new Date(source.at).toLocaleString()} · thread {source.runId.slice(0, 8)}</span></li>)}</ul></details>}
            <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={dirty} onClick={() => void launch(item, 'refine')}><SparklesIcon className="size-4" /> BA refinement</Button><Button variant="outline" disabled={dirty} onClick={() => void launch(item, 'implement')}><PlayIcon className="size-4" /> Start another attempt</Button></div>
            <p className="text-xs text-soft-foreground">Save your changes first. A manual attempt requires READY, approved requirements, acceptance criteria, no open questions, done dependencies, a Product Goal, a Definition of Done and a place in the active Sprint plan with a Sprint Goal. Refinement stays a read-only analysis.</p>
            <div className="grid gap-1 text-sm" aria-label="Linked runs">{item.runIds.map(id => <Link key={id} className="text-primary underline" to={`/tasks/${id}`}>Run {id.slice(0, 8)} → agent session</Link>)}</div>
            <p className="text-xs text-soft-foreground">A finished run does not mean Done. Check the result against the Definition of Done.</p>
          </section> : <div className="rounded-xl border border-dashed border-border p-8 text-sm text-soft-foreground">Select a backlog item.</div>}
        </div>}
        {tab === 'sprints' && <section className="grid gap-5"><div><Button onClick={() => edit({ ...draft, sprints: [...draft.sprints, { id: crypto.randomUUID(), name: 'New Sprint', goal: '', startsOn: '', endsOn: '', status: 'planned', itemIds: [] }] })}>Plan a Sprint</Button><p className="mt-2 text-sm text-soft-foreground">Agree the goal, dates and plan with the Developers. A Sprint lasts at most one month and only one can be active. Dates are not chosen for the team; set both before saving.</p></div>
          {draft.sprints.map(sprint => <article key={sprint.id} className="grid gap-4 rounded-xl border border-border bg-card p-5">
            <div className="grid gap-3 sm:grid-cols-2"><Field title="Sprint name"><Input value={sprint.name} onChange={e => changeSprint(sprint.id, { name: e.target.value })} /></Field><Field title="Sprint status"><select className={selectClass} value={sprint.status} onChange={e => changeSprint(sprint.id, { status: e.target.value as ScrumSprint['status'] })}><option value="planned">Planned</option><option value="active">Active</option><option value="closed">Closed</option><option value="cancelled">Cancelled by the PO</option></select></Field></div>
            <Field title="Sprint Goal"><Textarea value={sprint.goal} onChange={e => changeSprint(sprint.id, { goal: e.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2"><Field title="Starts on"><Input type="date" required value={sprint.startsOn} onChange={e => changeSprint(sprint.id, { startsOn: e.target.value })} /></Field><Field title="Ends on"><Input type="date" required value={sprint.endsOn} onChange={e => changeSprint(sprint.id, { endsOn: e.target.value })} /></Field></div>
            <Field title="Sprint Backlog — the Developers' plan"><div className="grid gap-2">{draft.items.map(row => <label key={row.id} className="flex items-center gap-2 rounded-md bg-muted p-2 text-sm"><input type="checkbox" checked={sprint.itemIds.includes(row.id)} onChange={e => changeSprint(sprint.id, { itemIds: e.target.checked ? [...sprint.itemIds, row.id] : sprint.itemIds.filter(x => x !== row.id) })} />{row.title}<span className="ml-auto text-xs text-soft-foreground">{row.deliveryStatus}</span></label>)}</div></Field>
            <p className="text-xs text-soft-foreground">A closed Sprint keeps its plan for inspection. Unfinished PBIs return to the Product Backlog for reconsideration; they do not move to the next Sprint automatically.</p>
          </article>)}
        </section>}
        {tab === 'notes' && <section className="grid gap-5"><form className="grid gap-3 rounded-xl border border-border bg-card p-5" onSubmit={async e => { e.preventDefault(); if (!noteBody.trim()) return; if (await commit({ ...draft, notes: [...draft.notes, { id: crypto.randomUUID(), kind: noteKind, body: noteBody.trim(), itemId: noteItem || null, sprintId: noteSprint || null, createdAt: new Date().toISOString() }] })) setNoteBody('') }}>
          <h2 className="flex items-center gap-2 font-semibold"><BookOpenIcon className="size-4" /> Notebook and events</h2>
          <Field title="Note kind"><select className={selectClass} value={noteKind} onChange={e => setNoteKind(e.target.value as ScrumNote['kind'])}>{Object.entries(noteLabels).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></Field>
          <div className="grid gap-3 sm:grid-cols-2"><Field title="Linked PBI"><select className={selectClass} value={noteItem} onChange={e => setNoteItem(e.target.value)}><option value="">Whole product</option>{draft.items.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}</select></Field><Field title="Linked Sprint"><select className={selectClass} value={noteSprint} onChange={e => setNoteSprint(e.target.value)}><option value="">No Sprint</option>{draft.sprints.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field></div>
          <Field title="Note"><Textarea required rows={5} value={noteBody} onChange={e => setNoteBody(e.target.value)} placeholder="Decisions, questions, Review feedback or concrete Retrospective improvements" /></Field><Button type="submit" disabled={!noteBody.trim()}>Save note and current changes</Button>
          <p className="text-xs text-soft-foreground">The notebook records the team's work. Saving a note does not approve requirements or replace a Scrum event.</p>
        </form>{[...draft.notes].reverse().map(note => <article key={note.id} className="rounded-xl border border-border bg-card p-5"><p className="text-xs text-soft-foreground">{noteLabels[note.kind]} · {new Date(note.createdAt).toLocaleString()} {note.itemId && `· ${draft.items.find(x => x.id === note.itemId)?.title ?? note.itemId}`} {note.sprintId && `· ${draft.sprints.find(x => x.id === note.sprintId)?.name ?? note.sprintId}`}</p><p className="mt-3 whitespace-pre-wrap text-sm">{note.body}</p></article>)}</section>}
        {tab === 'product' && <section className="grid max-w-3xl gap-5 rounded-xl border border-border bg-card p-5"><Field title="Product Goal"><Textarea rows={5} value={draft.productGoal} onChange={e => edit({ ...draft, productGoal: e.target.value })} /></Field><Field title="Definition of Done"><Textarea rows={6} value={draft.definitionOfDone} onChange={e => edit({ ...draft, definitionOfDone: e.target.value })} /></Field><Field title="Guidelines for every task"><Textarea rows={5} value={draft.guidelines ?? ''} onChange={e => edit({ ...draft, guidelines: e.target.value })} /></Field><p className="text-sm text-soft-foreground">The Product Owner is accountable for the Product Goal and Product Backlog order. The Developers create and adapt the Sprint plan. The Scrum Master supports the effectiveness of the process. AI does not take over business decisions.</p></section>}
      </fieldset>
    </div>
  </div>
}
