import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SCRUM_DOCUMENT_LIMIT, SCRUM_DOCUMENT_TEXT_LIMIT, SCRUM_DOCUMENT_VERSION_LIMIT,
  type ScrumDocument, type ScrumDocumentContent, type ScrumDocumentKind, type ScrumDocumentVersion, type ScrumItem, type ScrumProvenance, type ScrumState,
} from '@open-mercato/cezar-contract';
import { isApprovedLatest, kickoffBlockers, latestVersion, markdownHeadings } from './coordinator-state.ts';

/**
 * SCRUM-COORD-01: the shared memory. Every document version is an immutable Markdown file under
 * `<dataDir>/scrum/documents/`; `state.json` holds its metadata and hash. A version file is written
 * BEFORE the state save that names it, so a crash leaves an unreferenced file, never a reference
 * without a file. `INDEX.md` and `items/<id>.md` are compact derived views the agents read instead
 * of the whole state; they are regenerated from the state and may be deleted at any time.
 *
 * @author Skorowid
 */

const CODE: Record<ScrumDocumentKind, string> = {
  brd: 'BRD', frd: 'FRD', story: 'STORY', decision: 'DEC', context: 'CTX', consultation: 'CONSULT', review: 'REVIEW', implementation: 'RESULT',
};
/** Derived or returned kinds keep only their recent version metadata; the requirement kinds never lose history silently. */
const PRUNED_VERSIONS: ReadonlySet<ScrumDocumentKind> = new Set(['context']);

export const documentsDir = (dataDir: string) => join(dataDir, 'scrum', 'documents');
export const documentVersionPath = (dataDir: string, document: Pick<ScrumDocument, 'id'>, version: number) =>
  join(documentsDir(dataDir), document.id, `v${String(version).padStart(3, '0')}.md`);
export const indexPath = (dataDir: string) => join(dataDir, 'scrum', 'INDEX.md');
export const itemCardPath = (dataDir: string, itemId: string) => join(dataDir, 'scrum', 'items', `${itemId}.md`);

function writeAtomicSync(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

const sha256 = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

function nextCode(documents: readonly ScrumDocument[], kind: ScrumDocumentKind): string {
  const prefix = CODE[kind];
  const taken = documents.filter(document => document.kind === kind).map(document => Number(document.code.slice(prefix.length + 1)) || 0);
  return `${prefix}-${Math.max(0, ...taken) + 1}`;
}

export interface NewVersion {
  content: string;
  summary: string;
  source: ScrumDocumentVersion['source'];
  provenance: ScrumProvenance | null;
  runId: string | null;
}

function version(number: number, at: string, input: NewVersion): ScrumDocumentVersion {
  return {
    version: number, sha256: sha256(input.content), chars: input.content.length, headings: markdownHeadings(input.content),
    summary: input.summary.slice(0, 500), at, source: input.source, provenance: input.provenance, runId: input.runId,
  };
}

/** Validation shared by the coordinator's drafts and generated documents; returns why it cannot be stored. */
export function documentProblem(content: string): string | undefined {
  if (!content.trim()) return 'the document is empty';
  if (content.length > SCRUM_DOCUMENT_TEXT_LIMIT) return `the document is ${content.length} characters, over the ${SCRUM_DOCUMENT_TEXT_LIMIT} limit; split it instead of shortening requirements`;
  return undefined;
}

/** Create a document with its first version. Throws on a full store or a failed write; nothing is recorded then. */
export function createDocument(
  dataDir: string, state: ScrumState,
  fields: { kind: ScrumDocumentKind; title: string; itemIds?: readonly string[]; id?: string } & NewVersion,
): { state: ScrumState; document: ScrumDocument } {
  const problem = documentProblem(fields.content);
  if (problem) throw new Error(problem);
  const documents = state.documents ?? [];
  if (documents.length >= SCRUM_DOCUMENT_LIMIT) throw new Error(`the project already holds ${SCRUM_DOCUMENT_LIMIT} documents`);
  const at = new Date().toISOString();
  const document: ScrumDocument = {
    id: fields.id ?? randomUUID(), code: nextCode(documents, fields.kind), kind: fields.kind, title: fields.title.slice(0, 300),
    itemIds: [...new Set(fields.itemIds ?? [])], versions: [version(1, at, fields)], approval: null,
  };
  writeAtomicSync(documentVersionPath(dataDir, document, 1), fields.content);
  return { state: { ...state, documents: [...documents, document] }, document };
}

/** Add a version. The approval stays on the version it was given to, so the new one is not approved by it. */
export function reviseDocument(
  dataDir: string, state: ScrumState, documentId: string,
  fields: { title?: string; itemIds?: readonly string[] } & NewVersion,
): { state: ScrumState; document: ScrumDocument; changed: boolean } {
  const problem = documentProblem(fields.content);
  if (problem) throw new Error(problem);
  const documents = state.documents ?? [];
  const current = documents.find(document => document.id === documentId);
  if (!current) throw new Error(`unknown document ${documentId}`);
  const latest = latestVersion(current);
  const same = latest.sha256 === sha256(fields.content);
  // A byte-identical revision is no new baseline: approval and traces stay valid.
  if (same && fields.title === undefined && fields.itemIds === undefined) return { state, document: current, changed: false };
  let versions = current.versions;
  if (!same) {
    const pruned = PRUNED_VERSIONS.has(current.kind) ? current.versions.slice(-19) : current.versions;
    if (pruned.length >= SCRUM_DOCUMENT_VERSION_LIMIT) throw new Error(`${current.code} already has ${SCRUM_DOCUMENT_VERSION_LIMIT} versions`);
    const number = latest.version + 1;
    writeAtomicSync(documentVersionPath(dataDir, current, number), fields.content);
    versions = [...pruned, version(number, new Date().toISOString(), fields)];
  }
  const document: ScrumDocument = {
    ...current, versions,
    ...(fields.title !== undefined ? { title: fields.title.slice(0, 300) } : {}),
    ...(fields.itemIds !== undefined ? { itemIds: [...new Set(fields.itemIds)] } : {}),
  };
  return { state: { ...state, documents: documents.map(entry => entry.id === documentId ? document : entry) }, document, changed: true };
}

/** One version's Markdown with a hash check, so a hand-edited or lost file is never presented as the approved text. */
export function readDocumentVersion(dataDir: string, document: ScrumDocument, wanted?: number): ScrumDocumentContent | undefined {
  const meta = wanted === undefined ? latestVersion(document) : document.versions.find(entry => entry.version === wanted);
  if (!meta) return undefined;
  const path = documentVersionPath(dataDir, document, meta.version);
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return { documentId: document.id, version: meta.version, content: '', integrity: 'missing', path };
  }
  return { documentId: document.id, version: meta.version, content: content.slice(0, SCRUM_DOCUMENT_TEXT_LIMIT), integrity: sha256(content) === meta.sha256 ? 'ok' : 'altered', path };
}

const INDEX_LIMIT = 40_000;
const clip = (value: string, max: number) => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
export const formatMinutes = (minutes: number) => minutes >= 60 ? `${Math.round(minutes / 6) / 10} h` : `${minutes} min`;

function estimateLine(item: ScrumItem): string {
  return item.estimate ? `estimate base ${formatMinutes(item.estimate.baseMinutes)}, ×3 buffered ${formatMinutes(item.estimate.bufferedMinutes)} (uncertain)` : 'no estimate';
}

/** The compact index: enough to decide what to open next, bounded, with an explicit note when it is cut. */
export function buildIndex(state: ScrumState): string {
  const product = state.product;
  const active = state.sprints.find(sprint => sprint.status === 'active');
  const documents = (state.documents ?? []).filter(document => document.kind !== 'context');
  const openWork = (state.work ?? []).filter(work => ['pending', 'active', 'waiting'].includes(work.status));
  const recent = (state.work ?? []).filter(work => work.result).slice(-15);
  const gate = kickoffBlockers(state);
  const lines = [
    '# Scrum index (generated by cezar; do not edit)',
    `Revision ${state.revision}. Full data: state.json. Item cards: items/<id>.md. Documents: documents/<id>/vNNN.md.`,
    '',
    '## Product',
    `- Product Goal: ${clip(state.productGoal, 400) || '(not set)'}`,
    `- Vision: ${clip(product?.vision ?? '', 400) || '(not stated)'}`,
    `- Value objectives: ${product?.valueObjectives.length ? product.valueObjectives.map(objective => clip(objective.statement, 200)).join(' | ') : '(none stated)'}`,
    `- Definition of Ready: ${product?.definitionOfReady.trim() ? 'set' : '(not set)'}; Definition of Done: ${state.definitionOfDone.trim() ? 'set' : '(not set)'}`,
    `- Sprint planning constraints: ${product?.planning ? `max ${product.planning.maxSprintDays} days, from ${product.planning.earliestStart}${product.planning.latestEnd ? ` to ${product.planning.latestEnd}` : ''}, may activate: ${product.planning.mayActivate ? 'yes' : 'no'}` : '(none agreed: the coordinator cannot plan Sprints by itself)'}`,
    `- Initial readiness gate: ${!state.kickoff ? 'not started' : !state.kickoff.required ? 'not required (existing backlog)' : gate.length ? `OPEN — ${gate.join('; ')}` : 'passed'}`,
    '',
    '## Sprints',
    active ? `- Active: ${active.name} (${active.startsOn} – ${active.endsOn}): ${clip(active.goal, 200)} [${active.itemIds.length} items] id ${active.id}` : '- No active Sprint.',
    ...state.sprints.filter(sprint => sprint.status === 'planned').map(sprint => `- Planned: ${sprint.name} (${sprint.startsOn} – ${sprint.endsOn}): ${clip(sprint.goal, 200)} id ${sprint.id}`),
    '',
    '## Documents',
    ...(documents.length ? documents.map(document => `- ${document.code} v${latestVersion(document).version} ${document.kind} "${clip(document.title, 100)}" ${isApprovedLatest(document) ? 'APPROVED' : document.approval ? `approved only v${document.approval.version}` : 'not approved'} id ${document.id}`) : ['- none']),
    '',
    '## Open agent work',
    ...(openWork.length ? openWork.map(work => `- ${work.kind} ${work.status} item ${work.itemId ?? '-'} run ${work.runId?.slice(0, 8) ?? '-'}: ${clip(work.request, 160)}`) : ['- none']),
    '',
    '## Recent agent results',
    ...(recent.length ? recent.map(work => `- ${work.kind} ${work.status}${work.result?.verdict ? ` verdict ${work.result.verdict}` : ''} item ${work.itemId ?? '-'}: ${clip(work.result?.summary ?? '', 240)}`) : ['- none']),
    '',
    '## Product Backlog',
    ...[...state.items].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)).map(item =>
      `- #${item.priority} ${item.id} "${clip(item.title, 90)}" ${item.dorStatus}${item.approved ? ' approved' : ''} ${item.deliveryStatus}${item.group ? ` group "${clip(item.group, 40)}"` : ''}; ${estimateLine(item)}; ${item.questions.length} open questions; ${item.dependencies.length} dependencies; ${item.runIds.length} runs`),
  ];
  let text = lines.join('\n');
  if (text.length > INDEX_LIMIT) text = `${text.slice(0, INDEX_LIMIT)}\n\n(index cut at ${INDEX_LIMIT} characters; state.json holds the rest)`;
  return `${text}\n`;
}

/** A compact per-item card: the item, its traces, questions and returned results. */
export function buildItemCard(state: ScrumState, item: ScrumItem): string {
  const documents = new Map((state.documents ?? []).map(document => [document.id, document]));
  const titles = new Map(state.items.map(entry => [entry.id, entry]));
  const work = (state.work ?? []).filter(entry => entry.itemId === item.id).slice(-10);
  return [
    `# ${item.title}`,
    `id ${item.id}; DoR ${item.dorStatus}; approved ${item.approved ? 'yes' : 'no'}; delivery ${item.deliveryStatus}; priority ${item.priority}${item.group ? `; group ${item.group}` : ''}`,
    estimateLine(item),
    `\n## Description\n${item.description || '(none)'}`,
    `\n## Acceptance criteria\n${item.acceptanceCriteria.map(line => `- ${line}`).join('\n') || '(none)'}`,
    `\n## Open questions\n${item.questions.map(line => `- ${line}`).join('\n') || '(none)'}`,
    `\n## Dependencies\n${item.dependencies.map(id => `- ${titles.get(id)?.title ?? id} [${titles.get(id)?.deliveryStatus ?? 'unknown'}]`).join('\n') || '(none)'}`,
    `\n## Traces\n${(item.traces ?? []).map(trace => `- ${documents.get(trace.documentId)?.code ?? trace.documentId} v${trace.version}${trace.section ? ` § ${trace.section}` : ''}`).join('\n') || '(none)'}`,
    `\n## Agent work\n${work.map(entry => `- ${entry.kind} ${entry.status}${entry.result?.verdict ? ` verdict ${entry.result.verdict}` : ''} run ${entry.runId?.slice(0, 8) ?? '-'}: ${clip(entry.result?.summary ?? entry.detail, 400)}`).join('\n') || '(none)'}`,
    `\n## Runs\n${item.runIds.map(id => `- ${id}`).join('\n') || '(none)'}`,
  ].join('\n') + '\n';
}

const cardHashes = new Map<string, Map<string, string>>();

/** Refresh the derived views after a save. Best effort: they are rebuilt from the state on the next save. */
export function writeDerivedViews(dataDir: string, state: ScrumState): void {
  try {
    writeAtomicSync(indexPath(dataDir), buildIndex(state));
    const known = cardHashes.get(dataDir) ?? new Map<string, string>();
    cardHashes.set(dataDir, known);
    const live = new Set(state.items.map(item => item.id));
    for (const item of state.items) {
      const card = buildItemCard(state, item);
      const hash = sha256(card);
      if (known.get(item.id) === hash) continue;
      writeAtomicSync(itemCardPath(dataDir, item.id), card);
      known.set(item.id, hash);
    }
    for (const id of [...known.keys()]) {
      if (live.has(id)) continue;
      rmSync(itemCardPath(dataDir, id), { force: true });
      known.delete(id);
    }
  } catch {
    // The state is the record; the agent reads state.json if the views are missing.
  }
}
