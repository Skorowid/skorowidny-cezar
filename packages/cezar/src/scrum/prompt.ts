import type { ScrumItem, ScrumLaunchMode, ScrumState } from '@open-mercato/cezar-contract';
import { activeSprintOf } from './validate.ts';

/**
 * The task text a Scrum launch hands the existing run engine (SCRUM-LOCAL-01 "Uruchamianie
 * agenta"): Product/Sprint context, the PBI and its rules. Refinement is analysis only.
 *
 * @author Skorowid
 */

const list = (values: readonly string[], empty: string) =>
  values.some(value => value.trim()) ? values.filter(value => value.trim()).map(value => `- ${value.trim()}`).join('\n') : `- ${empty}`;
const block = (value: string, empty: string) => value.trim() || empty;

/** Line that ties an implementation run's task to its PBI, so a run whose link was lost can be adopted. */
export function scrumItemMarker(itemId: string): string {
  return `Scrum PBI id: ${itemId}`;
}

/** Line that makes one forwarded chat change recognisable in a run's transcript (no second delivery on replay). */
export function scrumChangeMarker(changeId: string): string {
  return `Scrum change id: ${changeId}`;
}

export function itemContext(state: ScrumState, item: ScrumItem): string {
  const byId = new Map(state.items.map(entry => [entry.id, entry]));
  const sprint = activeSprintOf(state, item.id);
  const plan = sprint
    ? sprint.itemIds.map(id => byId.get(id)).filter(entry => entry !== undefined).map(entry => `${entry.title} [${entry.deliveryStatus}]`)
    : [];
  const dependencies = item.dependencies.map(id => {
    const entry = byId.get(id);
    return entry ? `${entry.title} [${entry.deliveryStatus}]` : id;
  });
  return [
    `## Product Goal\n${block(state.productGoal, '(not set)')}`,
    sprint
      ? `## Active Sprint: ${sprint.name} (${sprint.startsOn} – ${sprint.endsOn})\nSprint Goal: ${block(sprint.goal, '(not set)')}\nSprint Backlog:\n${list(plan, '(empty)')}`
      : '## Active Sprint\nThis item is not planned in an active Sprint.',
    `## Product Backlog Item: ${item.title}\nDoR status: ${item.dorStatus}; requirements approved: ${item.approved ? 'yes' : 'no'}; priority: ${item.priority}\n\n${block(item.description, '(no description)')}`,
    `## Acceptance criteria\n${list(item.acceptanceCriteria, '(none)')}`,
    `## Open BA questions\n${list(item.questions, '(none)')}`,
    `## Dependencies\n${list(dependencies, '(none)')}`,
    `## Definition of Done\n${block(state.definitionOfDone, '(not set)')}`,
    ...(state.guidelines?.trim() ? [`## Project guidelines\n${state.guidelines.trim()}`] : []),
  ].join('\n\n');
}

/** SCRUM-COORD-01: the fence an agent's final message carries, so its result reaches the coordinator structured. */
export const SCRUM_RESULT_FENCE = 'cezar-agent-result';

/** How an assigned agent hands back its result. `fields` names what this kind of work must fill in. */
export function resultInstructions(fields: string): string {
  return `## Returning your result\nEnd your final message with exactly one fenced block, then the line CEZ:DONE. cezar reads it from your transcript and hands it to the project's coordinator; the author does not talk to you directly.\n\n\`\`\`${SCRUM_RESULT_FENCE}\n{"summary":"what you found or did, in plain words", ${fields}}\n\`\`\`\n\nKeep the JSON on its own lines. State only what you actually did and observed. Never list a file or link you did not really produce: cezar verifies each one and reports what it refuses.`;
}

export const IMPLEMENT_RESULT_FIELDS = '"gaps":["requirement gaps you found"],"blockers":["what stopped you"],"artifacts":[{"kind":"screenshot","label":"…","path":"relative/path/inside/this/worktree.png"},{"kind":"file","label":"…","path":"relative/path"},{"kind":"preview","label":"…","url":"http://127.0.0.1:PORT/"}]';

/**
 * `packet`: the item-scoped context packet (`context.ts`), when the project has documents.
 * Refinement is a consultation, so its result block follows `consult` instructions too.
 */
export function buildScrumPrompt(state: ScrumState, item: ScrumItem, mode: ScrumLaunchMode, packet?: string): string {
  const context = packet ? `${itemContext(state, item)}\n\n${packet}` : itemContext(state, item);
  if (mode === 'refine') {
    return [
      `Backlog refinement (read-only analysis) for the Product Backlog Item "${item.title}".`,
      context,
      '## Instructions\n- Do not change product code, files or the backlog; this is analysis only.\n- Identify ambiguity, missing data, failure scenarios, dependencies and untestable criteria.\n- Propose concrete, answerable questions for the Business/Systems Analyst, each marked BLOCKING or NON-BLOCKING.\n- You may suggest acceptance criteria or a DoR status, labelled as proposals. You never approve requirements; a human decides.',
      resultInstructions('"gaps":["each question, marked BLOCKING or NON-BLOCKING"],"blockers":[],"feasibility":"what you can say about feasibility"'),
    ].join('\n\n');
  }
  return [
    `Implement the Product Backlog Item "${item.title}".`,
    context,
    scrumItemMarker(item.id),
    '## Instructions\n- Implement exactly the approved requirements and acceptance criteria; respect the BA decisions above and do not invent business rules.\n- If you find a new gap or conflict, stop work on the affected behaviour and report it as a question instead of guessing.\n- Work in this isolated task worktree. Never merge or push; the result goes to human review.\n- Verify against the acceptance criteria and the Definition of Done, and report the evidence. Finishing this run does not mark the item Done.',
    resultInstructions(IMPLEMENT_RESULT_FIELDS),
  ].join('\n\n');
}

/**
 * SCRUM-CHAT-01 Q1: the message that forwards a chat change to the item's queued, running or
 * waiting run. It restates the whole item, since the run cannot read the backlog file.
 */
export function buildScrumChangeMessage(state: ScrumState, item: ScrumItem, quotes: readonly string[], changeId: string): string {
  return [
    `The Product Backlog Item "${item.title}" you are working on was changed in the project's Scrum chat.`,
    `## The user's words behind the change\n${list(quotes.map(quote => `"${quote}"`), '(none recorded)')}`,
    `# Updated item\n\n${itemContext(state, item)}`,
    scrumChangeMarker(changeId),
    `## Instructions\n- Continue this attempt with the updated item; do not restart or start a second attempt.\n- Implement only approved requirements. ${item.approved ? 'The updated requirements are approved.' : 'The updated requirements are NOT approved yet: do not implement what changed until an approval is forwarded to you; stop work on that behaviour and report what you are waiting for.'}\n- If the change conflicts with work already done or leaves a gap, report it as a question instead of guessing.`,
  ].join('\n\n');
}
