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

export function buildScrumPrompt(state: ScrumState, item: ScrumItem, mode: ScrumLaunchMode): string {
  const byId = new Map(state.items.map(entry => [entry.id, entry]));
  const sprint = activeSprintOf(state, item.id);
  const plan = sprint
    ? sprint.itemIds.map(id => byId.get(id)).filter(entry => entry !== undefined).map(entry => `${entry.title} [${entry.deliveryStatus}]`)
    : [];
  const dependencies = item.dependencies.map(id => {
    const entry = byId.get(id);
    return entry ? `${entry.title} [${entry.deliveryStatus}]` : id;
  });
  const context = [
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
  if (mode === 'refine') {
    return [
      `Backlog refinement (read-only analysis) for the Product Backlog Item "${item.title}".`,
      context,
      '## Instructions\n- Do not change product code, files or the backlog; this is analysis only.\n- Identify ambiguity, missing data, failure scenarios, dependencies and untestable criteria.\n- Propose concrete, answerable questions for the Business/Systems Analyst, each marked BLOCKING or NON-BLOCKING.\n- You may suggest acceptance criteria or a DoR status, labelled as proposals. You never approve requirements; a human decides.',
    ].join('\n\n');
  }
  return [
    `Implement the Product Backlog Item "${item.title}".`,
    context,
    scrumItemMarker(item.id),
    '## Instructions\n- Implement exactly the approved requirements and acceptance criteria; respect the BA decisions above and do not invent business rules.\n- If you find a new gap or conflict, stop work on the affected behaviour and report it as a question instead of guessing.\n- Work in this isolated task worktree. Never merge or push; the result goes to human review.\n- Verify against the acceptance criteria and the Definition of Done, and report the evidence. Finishing this run does not mark the item Done.',
  ].join('\n\n');
}
