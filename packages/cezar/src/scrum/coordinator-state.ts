import { randomUUID } from 'node:crypto';
import {
  SCRUM_ESTIMATE_BUFFER_FACTOR, SCRUM_KICKOFF_QUESTIONS, SCRUM_WORK_LIMIT,
  type ScrumCoordinatorConfig, type ScrumDocument, type ScrumDocumentKind, type ScrumDocumentVersion, type ScrumEstimate, type ScrumItem,
  type ScrumKickoff, type ScrumProduct, type ScrumSprint, type ScrumState, type ScrumWork, type ScrumWorkKind,
} from '@open-mercato/cezar-contract';

/**
 * SCRUM-COORD-01 (docs/skorowidny-cezar/scrum-coordinator.md): the deterministic rules around the
 * product coordinator. No model decides any of these: the first-decomposition gate, document
 * approval, traceability, the ×3 estimate and the Sprint planning limits are all checked here.
 *
 * @author Skorowid
 */

export function coordinatorConfig(state: ScrumState): ScrumCoordinatorConfig {
  const none = { runner: null, model: null };
  return state.coordinator ?? { model: null, agents: { consult: none, implement: none, review: none }, autoReview: true };
}

export function emptyProduct(): ScrumProduct {
  return { vision: '', valueObjectives: [], definitionOfReady: '', planning: null };
}

/** The gate applies to a project that starts from nothing; an existing backlog keeps working without it. */
export function startKickoff(state: ScrumState): ScrumState {
  if (state.kickoff) return state;
  const kickoff: ScrumKickoff = { required: state.items.length === 0, startedAt: new Date().toISOString(), answers: [], completedAt: null };
  return { ...state, kickoff };
}

/** Minimum sections per document kind, from the project's BRD/FRD skeletons. Matched as heading text, ignoring case. */
export const REQUIRED_HEADINGS: Partial<Record<ScrumDocumentKind, readonly string[]>> = {
  brd: ['Identity', 'Purpose', 'Scope', 'Users and context', 'Requirements', 'Decisions and gaps'],
  frd: ['Identity and scope', 'Actors and behavior', 'Data and business rules', 'Failures and constraints', 'Acceptance and decisions'],
};

export function markdownHeadings(content: string): string[] {
  const headings: string[] = [];
  let fence = false;
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const match = fence ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1]) headings.push(match[1].replace(/^\d+[.)]\s*/, '').slice(0, 200));
    if (headings.length >= 200) break;
  }
  return headings;
}

export function missingHeadings(kind: ScrumDocumentKind, headings: readonly string[]): string[] {
  const found = new Set(headings.map(heading => heading.trim().toLowerCase()));
  return (REQUIRED_HEADINGS[kind] ?? []).filter(heading => !found.has(heading.toLowerCase()));
}

export const latestVersion = (document: ScrumDocument): ScrumDocumentVersion => document.versions[document.versions.length - 1]!;
export const isApprovedLatest = (document: ScrumDocument): boolean => document.approval?.version === latestVersion(document).version;

/** A BRD or FRD counts when one document of the kind has every minimum section and its latest version is approved. */
function minimumDocumentProblem(state: ScrumState, kind: 'brd' | 'frd'): string | undefined {
  const name = kind.toUpperCase();
  const documents = (state.documents ?? []).filter(document => document.kind === kind);
  if (!documents.length) return `no ${name} in Markdown yet`;
  const complete = documents.filter(document => !missingHeadings(kind, latestVersion(document).headings).length);
  if (!complete.length) {
    const newest = documents[documents.length - 1]!;
    return `${newest.code} v${latestVersion(newest).version} lacks the minimum sections: ${missingHeadings(kind, latestVersion(newest).headings).join(', ')}`;
  }
  return complete.some(isApprovedLatest) ? undefined : `${complete[complete.length - 1]!.code} is not approved by the author yet`;
}

/** What still stands between this project and its first decomposition. Empty once it was passed: later refinement is per slice. */
export function kickoffBlockers(state: ScrumState): string[] {
  const kickoff = state.kickoff;
  if (!kickoff?.required || kickoff.completedAt) return [];
  const blockers: string[] = [];
  const answered = new Map(kickoff.answers.map(answer => [answer.questionId, answer.status]));
  for (const question of SCRUM_KICKOFF_QUESTIONS) {
    const status = answered.get(question.id);
    if (!status) blockers.push(`unanswered: ${question.topic}`);
    else if (question.essential && status !== 'answered') blockers.push(`needs an answer, not a deferral: ${question.topic}`);
  }
  if (!state.product?.vision.trim()) blockers.push('vision not recorded');
  if (!state.productGoal.trim()) blockers.push('Product Goal not set');
  if (!state.definitionOfDone.trim()) blockers.push('Definition of Done not set');
  if (!state.product?.definitionOfReady.trim()) blockers.push('Definition of Ready not set');
  for (const kind of ['brd', 'frd'] as const) {
    const problem = minimumDocumentProblem(state, kind);
    if (problem) blockers.push(problem);
  }
  return blockers;
}

/** Record the first moment the gate is passed; it never closes again. */
export function settleKickoff(state: ScrumState): ScrumState {
  const kickoff = state.kickoff;
  if (!kickoff?.required || kickoff.completedAt || kickoffBlockers(state).length) return state;
  return { ...state, kickoff: { ...kickoff, completedAt: new Date().toISOString() } };
}

/** Why an item's document baseline blocks implementation. A legacy item without traces is not touched. */
export function traceBlockers(state: ScrumState, item: ScrumItem): string[] {
  const blockers: string[] = [];
  const documents = new Map((state.documents ?? []).map(document => [document.id, document]));
  for (const trace of item.traces ?? []) {
    const document = documents.get(trace.documentId);
    if (!document) { blockers.push(`traced document ${trace.documentId} is unknown`); continue; }
    const latest = latestVersion(document).version;
    if (trace.version !== latest) blockers.push(`${document.code} changed: the item traces v${trace.version}, the latest is v${latest}`);
    else if (!isApprovedLatest(document)) blockers.push(`${document.code} v${latest} is not approved`);
  }
  // A project under the gate derives every chat-made item from an approved requirement.
  if (state.kickoff?.required && item.autoQueue && !item.traces?.length) blockers.push('the item traces no approved BRD, FRD or user story');
  return blockers;
}

export function buildEstimate(baseMinutes: number, rationale: string, at: string, runId: string | null): ScrumEstimate {
  return { baseMinutes, bufferedMinutes: baseMinutes * SCRUM_ESTIMATE_BUFFER_FACTOR, factor: SCRUM_ESTIMATE_BUFFER_FACTOR, rationale: rationale.slice(0, 2000), at, runId };
}

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
const OPEN_SPRINT = new Set<ScrumSprint['status']>(['planned', 'active']);

/**
 * Why the coordinator may not plan this Sprint by itself. The author's constraints are the whole
 * authority: no constraints, no autonomous plan. Scrum's one-month limit stays in `stateProblems`.
 */
export function planningProblems(state: ScrumState, sprint: Pick<ScrumSprint, 'id' | 'startsOn' | 'endsOn' | 'goal'>, activate: boolean): string[] {
  const planning = state.product?.planning;
  if (!planning) return ['no Sprint planning constraints were agreed with the author; ask for them first'];
  const problems: string[] = [];
  if (!sprint.goal.trim()) problems.push('a Sprint Goal is required');
  if (sprint.startsOn < planning.earliestStart) problems.push(`starts before the agreed earliest start ${planning.earliestStart}`);
  if (planning.latestEnd && sprint.endsOn > planning.latestEnd) problems.push(`ends after the agreed latest end ${planning.latestEnd}`);
  const days = dayNumber(sprint.endsOn) - dayNumber(sprint.startsOn) + 1;
  if (days > planning.maxSprintDays) problems.push(`lasts ${days} days, over the agreed ${planning.maxSprintDays}`);
  if (activate && !planning.mayActivate) problems.push('the author has not agreed that the coordinator may activate Sprints');
  for (const other of state.sprints) {
    if (other.id === sprint.id || !OPEN_SPRINT.has(other.status)) continue;
    if (sprint.startsOn <= other.endsOn && other.startsOn <= sprint.endsOn) problems.push(`overlaps Sprint "${other.name}" (${other.startsOn} – ${other.endsOn})`);
  }
  return problems;
}

/** Most assignments the coordinator may start after one author message; agents do not discuss forever. */
export const MAX_REQUESTS_PER_AUTHOR_MESSAGE = 3;

/** The `request` of a review cezar started by itself; it does not count against the coordinator's own requests. */
export const AUTOMATIC_REVIEW = 'Automatic review of a settled implementation attempt';

export function requestsSince(state: ScrumState, since: string | undefined): number {
  return (state.work ?? []).filter(work => work.kind !== 'implement' && work.request !== AUTOMATIC_REVIEW && (since === undefined || work.createdAt > since)).length;
}

export function newWork(kind: ScrumWorkKind, fields: Partial<Pick<ScrumWork, 'itemId' | 'documentId' | 'request' | 'runId' | 'targetRunId' | 'runner' | 'model' | 'branch' | 'status' | 'detail' | 'provenance'>>): ScrumWork {
  const at = new Date().toISOString();
  return {
    id: randomUUID(), kind, itemId: null, documentId: null, request: '', runId: null, targetRunId: null, runner: null, model: null, branch: null,
    status: 'pending', detail: '', createdAt: at, updatedAt: at, result: null, artifacts: [], reportedKey: '', provenance: null, ...fields,
  };
}

const OPEN_WORK = new Set<ScrumWork['status']>(['pending', 'active', 'waiting']);

/** Append an assignment; past the limit the oldest settled ones fall off (their Markdown results stay on disk). */
export function addWork(state: ScrumState, work: ScrumWork): ScrumState {
  const all = [...(state.work ?? []), work];
  while (all.length > SCRUM_WORK_LIMIT) {
    const oldest = all.findIndex(entry => !OPEN_WORK.has(entry.status));
    if (oldest < 0) break;
    all.splice(oldest, 1);
  }
  return { ...state, work: all.slice(-SCRUM_WORK_LIMIT) };
}

