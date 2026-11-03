/** SCRUM-CHAT-01 / SCRUM-COORD-01: the author's one conversation, with the project's persistent OpenCode coordinator. Author: Skorowid. */
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MessageSquareIcon, SendIcon } from 'lucide-react'
import type { ScrumChatLogEntry, ScrumState } from '@open-mercato/cezar-api-client'
import { getScrumChat, getScrumCoordinator, sendScrumChat } from '@/api/scrum'
import { useProjectScope } from '@/api/project-scope-context'
import { Link } from '@/lib/project-router'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@/routes/task-thread/markdown'

const LIVE = new Set(['queued', 'running'])
const outcomeLabel: Record<ScrumChatLogEntry['outcome'], string> = {
  applied: 'Applied', refused: 'Refused', queued: 'Queued', 'queue-failed': 'Not queued',
  'forward-pending': 'Not received yet', forwarded: 'Received by agent', 'forward-failed': 'Not received by agent', 'run-failed': 'Attempt failed', question: 'Question', 'agent-started': 'Agent started', 'agent-result': 'Agent result',
}
const PROBLEM = new Set<ScrumChatLogEntry['outcome']>(['refused', 'queue-failed', 'forward-failed', 'run-failed'])
const statusLabel: Record<string, string> = { queued: 'waiting for a free agent', running: 'thinking…', waiting: 'ready', review: 'ready', done: 'resting — your next message resumes the same thread', failed: 'stopped — your next message resumes or replaces the thread', cancelled: 'stopped — your next message resumes or replaces the thread' }

export function ScrumChat({ onState }: { onState: (state: ScrumState) => void }) {
  const scope = useProjectScope()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  // One id per message until it is accepted, so a retried send is answered once.
  const pendingId = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const query = useQuery({
    queryKey: ['scrum-chat', scope.projectId],
    queryFn: getScrumChat,
    retry: false,
    refetchInterval: (current) => (current.state.data?.threadStatus && LIVE.has(current.state.data.threadStatus)) || sending ? 2000 : 10000,
  })
  const coordinator = useQuery({ queryKey: ['scrum-coordinator', scope.projectId, 'availability'], queryFn: getScrumCoordinator, retry: false, refetchInterval: 60_000 })
  const data = query.data
  useEffect(() => { if (data) onState(data.state) }, [data, onState])
  useEffect(() => { listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight }) }, [data?.messages.length])
  useEffect(() => { setText(''); setError(''); pendingId.current = null }, [scope.projectId])

  async function send() {
    const message = text.trim()
    if (!message) return
    pendingId.current ??= crypto.randomUUID()
    setSending(true); setError('')
    try {
      const answer = await sendScrumChat({ clientMessageId: pendingId.current, text: message })
      pendingId.current = null
      setText('')
      onState(answer.state)
      await query.refetch()
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'The message could not be sent.')
    } finally { setSending(false) }
  }

  const log = [...(data?.state.chat?.log ?? [])].reverse().slice(0, 30)
  return <section aria-label="Product coordinator" className="grid gap-3 rounded-xl border border-border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 font-semibold"><MessageSquareIcon className="size-4" /> Product coordinator</h2>
      <p className="text-xs text-soft-foreground">
        {data?.threadRunId
          ? <>{data.threadRunner === 'opencode' ? 'OpenCode' : coordinator.data?.runner === data.threadRunner ? 'Codex (took over from OpenCode)' : `Earlier ${data.threadRunner ?? 'agent'}`} thread {data.threadRunId.slice(0, 8)} · {statusLabel[data.threadStatus ?? ''] ?? data.threadStatus} · <Link className="text-primary underline" to={`/tasks/${data.threadRunId}`}>open the full session</Link></>
          : `No conversation yet — your first message starts this project's coordinator on ${coordinator.data?.runner === 'codex' ? 'Codex, because OpenCode cannot do the work now' : 'OpenCode'}.`}
      </p>
    </div>
    {coordinator.data?.runner === 'codex' && coordinator.data.takeoverReason && <p role="status" className="rounded-lg border border-border bg-muted p-3 text-sm">Codex holds the coordinator's role: {coordinator.data.takeoverReason}</p>}
    {coordinator.data?.blocker && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">{coordinator.data.blocker}</p>}
    <div ref={listRef} className="grid max-h-[28rem] gap-2 overflow-y-auto rounded-lg bg-muted p-3" aria-live="polite">
      {query.isPending && <p role="status" className="text-sm">Loading the conversation…</p>}
      {query.isError && <p role="alert" className="text-sm">{query.error instanceof Error ? query.error.message : 'The conversation could not be loaded.'}</p>}
      {data && data.truncated && <p className="text-xs text-soft-foreground">Older messages are in the full session.</p>}
      {data && data.messages.length === 0 && <p className="text-sm text-soft-foreground">Tell the coordinator what you want to build, and for whom. Before the first split into tasks it asks about your vision, your own value or profit objectives, scope, behaviour, Definition of Ready and Done, and Sprint limits, and drafts a minimum BRD and FRD in Markdown for you to approve. Afterwards it refines one slice at a time, asks other agents for a second opinion, plans Sprints within the limits you agreed and queues ready, approved tasks for free agents. You remain the accountable Product Owner: only you approve requirements and mark work Done, and a failed attempt is retried only when you ask for it here.</p>}
      {data?.messages.map((message, index) => message.role === 'system'
        ? <div key={`${message.seq}-${index}`} role="note" className="mx-auto max-w-[90%] whitespace-pre-wrap rounded-lg border border-border px-3 py-2 text-xs text-soft-foreground">
          <p className="mb-1 text-[11px] font-medium">cezar</p>{message.text}
        </div>
        : <div key={`${message.seq}-${index}`} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${message.role === 'user' ? 'ml-auto whitespace-pre-wrap bg-primary/10' : 'bg-card'}`}>
          <p className="mb-1 text-[11px] text-soft-foreground">{message.role === 'user' ? 'You' : 'Coordinator'}</p>{message.role === 'user' ? message.text : <Markdown>{message.text}</Markdown>}
        </div>)}
    </div>
    <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void send() }}>
      <Textarea rows={3} value={text} disabled={sending} placeholder="Answer the coordinator, describe your goal, approve a document, or ask for progress…" onChange={event => { setText(event.target.value); pendingId.current = null }}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send() } }} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-soft-foreground">The coordinator never marks work Done and records only what you state or confirm. Ctrl/⌘+Enter sends.</p>
        <Button type="submit" disabled={sending || !text.trim()}><SendIcon className="size-4" /> {sending ? 'Sending…' : 'Send'}</Button>
      </div>
      {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-sm">{error}</p>}
    </form>
    {log.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-soft-foreground">Backlog change log ({data?.state.chat?.log.length ?? 0})</summary>
      <ul className="mt-2 grid gap-1">{log.map((entry, index) => <li key={`${entry.at}-${index}`} className="rounded-md bg-muted p-2">
        <span className={PROBLEM.has(entry.outcome) ? 'font-medium text-destructive' : 'font-medium'}>{outcomeLabel[entry.outcome]}</span> · {entry.op} — {entry.detail}
        {entry.quote && <span className="block text-xs text-soft-foreground">Based on: “{entry.quote}”</span>}
      </li>)}</ul>
    </details>}
  </section>
}
