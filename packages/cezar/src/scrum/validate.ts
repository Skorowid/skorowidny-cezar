import type { ScrumItem, ScrumSprint, ScrumState } from '@open-mercato/cezar-contract';

/**
 * Cross-reference rules of SCRUM-LOCAL-01 that a per-field schema cannot express. Each function
 * returns human-readable problems; an empty list means valid.
 *
 * @author Skorowid
 */

export type ScrumErrorStatus = 400 | 404 | 409 | 503;

/** Typed failure the route family maps to its status verbatim. */
export class ScrumError extends Error {
  constructor(readonly status: ScrumErrorStatus, message: string) {
    super(message);
    this.name = 'ScrumError';
  }
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated];
}

function parseDate(value: string): Date | undefined {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : date;
}

/** Last allowed end date: one calendar month after the start, minus a day, clamped to month end. */
export function latestSprintEnd(startsOn: string): string | undefined {
  const start = parseDate(startsOn);
  if (!start) return undefined;
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const end = new Date(Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay)));
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

function sprintProblems(sprint: ScrumSprint): string[] {
  const label = `Sprint "${sprint.name || sprint.id}"`;
  if (!parseDate(sprint.startsOn)) return [`${label}: startsOn is not a calendar date`];
  if (!parseDate(sprint.endsOn)) return [`${label}: endsOn is not a calendar date`];
  if (sprint.endsOn < sprint.startsOn) return [`${label}: endsOn is before startsOn`];
  const latest = latestSprintEnd(sprint.startsOn);
  return latest && sprint.endsOn > latest ? [`${label}: a Sprint lasts at most one month (end on or before ${latest})`] : [];
}

function cyclePath(items: readonly ScrumItem[]): string[] | undefined {
  const edges = new Map(items.map(item => [item.id, item.dependencies]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (node: string): string[] | undefined => {
    if (state.get(node) === 'done') return undefined;
    if (state.get(node) === 'visiting') return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(node, 'done');
    return undefined;
  };
  for (const item of items) {
    const found = visit(item.id);
    if (found) return found;
  }
  return undefined;
}

/** Integrity of a state as stored: ids, references, cycles, Sprint rules and Done evidence. */
export function stateProblems(state: ScrumState): string[] {
  const problems: string[] = [];
  const itemIds = new Set(state.items.map(item => item.id));
  const sprintIds = new Set(state.sprints.map(sprint => sprint.id));
  for (const [kind, ids] of [
    ['item', state.items.map(item => item.id)],
    ['Sprint', state.sprints.map(sprint => sprint.id)],
    ['note', state.notes.map(note => note.id)],
  ] as const) {
    for (const repeated of duplicates(ids)) problems.push(`duplicate ${kind} id ${repeated}`);
  }
  for (const item of state.items) {
    const label = `item "${item.title || item.id}"`;
    for (const dependency of item.dependencies) {
      if (dependency === item.id) problems.push(`${label} depends on itself`);
      else if (!itemIds.has(dependency)) problems.push(`${label} depends on unknown item ${dependency}`);
    }
    for (const repeated of duplicates(item.dependencies)) problems.push(`${label} lists dependency ${repeated} twice`);
    for (const repeated of duplicates(item.runIds)) problems.push(`${label} lists run ${repeated} twice`);
    if (item.deliveryStatus === 'done') {
      if (!state.definitionOfDone.trim()) problems.push(`${label} is done but the Definition of Done is empty`);
      if (!item.doneEvidence.trim()) problems.push(`${label} is done without doneEvidence`);
    }
  }
  if (problems.every(problem => !problem.includes('depends on'))) {
    const cycle = cyclePath(state.items);
    const titles = new Map(state.items.map(item => [item.id, item.title || item.id]));
    if (cycle) problems.push(`dependency cycle: ${cycle.map(node => titles.get(node) ?? node).join(' -> ')}`);
  }
  const active = state.sprints.filter(sprint => sprint.status === 'active');
  if (active.length > 1) problems.push(`at most one Sprint may be active (found ${active.length})`);
  for (const sprint of state.sprints) {
    problems.push(...sprintProblems(sprint));
    for (const itemId of sprint.itemIds) {
      if (!itemIds.has(itemId)) problems.push(`Sprint "${sprint.name || sprint.id}" plans unknown item ${itemId}`);
    }
    for (const repeated of duplicates(sprint.itemIds)) problems.push(`Sprint "${sprint.name || sprint.id}" plans item ${repeated} twice`);
  }
  for (const note of state.notes) {
    if (note.itemId !== null && !itemIds.has(note.itemId)) problems.push(`note ${note.id} refers to unknown item ${note.itemId}`);
    if (note.sprintId !== null && !sprintIds.has(note.sprintId)) problems.push(`note ${note.id} refers to unknown Sprint ${note.sprintId}`);
  }
  return problems;
}

/** `runIds` are written only by the launch route: an edit must carry them unchanged. */
export function runHistoryProblems(previous: ScrumState, next: ScrumState): string[] {
  const stored = new Map(previous.items.map(item => [item.id, item.runIds]));
  const problems: string[] = [];
  for (const item of next.items) {
    const before = stored.get(item.id) ?? [];
    if (before.length !== item.runIds.length || before.some((runId, index) => item.runIds[index] !== runId)) {
      problems.push(`item "${item.title || item.id}": runIds are recorded by the server and cannot be edited`);
    }
  }
  return problems;
}

/** Why an item may not start an implementation run; empty when it is ready. */
export function implementationBlockers(state: ScrumState, item: ScrumItem): string[] {
  const blockers: string[] = [];
  if (item.dorStatus !== 'READY') blockers.push(`DoR status is ${item.dorStatus}, not READY`);
  if (!item.approved) blockers.push('requirements are not approved');
  if (!item.acceptanceCriteria.some(criterion => criterion.trim())) blockers.push('no acceptance criteria');
  if (item.questions.some(question => question.trim())) blockers.push('open questions remain');
  const byId = new Map(state.items.map(entry => [entry.id, entry]));
  const unfinished = item.dependencies.filter(dependency => byId.get(dependency)?.deliveryStatus !== 'done');
  if (unfinished.length) blockers.push(`dependencies not done: ${unfinished.map(dependency => byId.get(dependency)?.title || dependency).join(', ')}`);
  if (!state.productGoal.trim()) blockers.push('Product Goal is empty');
  if (!state.definitionOfDone.trim()) blockers.push('Definition of Done is empty');
  const sprint = activeSprintOf(state, item.id);
  if (!sprint) blockers.push('item is not planned in the active Sprint');
  else if (!sprint.goal.trim()) blockers.push('the active Sprint has no Sprint Goal');
  return blockers;
}

export function activeSprintOf(state: ScrumState, itemId: string): ScrumSprint | undefined {
  return state.sprints.find(sprint => sprint.status === 'active' && sprint.itemIds.includes(itemId));
}

/**
 * SCRUM-CHAT-01: `chat`, `autoQueue`, `autoRunId` and `provenance` are written by the server
 * only. A client save carries whatever it read; the stored values always win.
 */
export function keepServerOwned(previous: ScrumState, next: ScrumState): ScrumState {
  const items = new Map(previous.items.map(item => [item.id, item]));
  const sprints = new Map(previous.sprints.map(sprint => [sprint.id, sprint]));
  const { chat: _sent, ...rest } = next;
  return {
    ...rest,
    ...(previous.chat ? { chat: previous.chat } : {}),
    items: next.items.map(item => {
      const { autoQueue: _q, autoRunId: _r, provenance: _p, ...plain } = item;
      const before = items.get(item.id);
      return {
        ...plain,
        ...(before?.autoQueue !== undefined ? { autoQueue: before.autoQueue } : {}),
        ...(before?.autoRunId !== undefined ? { autoRunId: before.autoRunId } : {}),
        ...(before?.provenance !== undefined ? { provenance: before.provenance } : {}),
      };
    }),
    sprints: next.sprints.map(sprint => {
      const { provenance: _p, ...plain } = sprint;
      const before = sprints.get(sprint.id);
      return { ...plain, ...(before?.provenance !== undefined ? { provenance: before.provenance } : {}) };
    }),
  };
}
