import { SCRUM_CONTEXT_PACKET_LIMIT, type ScrumDocument, type ScrumItem, type ScrumState } from '@open-mercato/cezar-contract';
import { createDocument, documentVersionPath, readDocumentVersion, reviseDocument } from './documents.ts';
import { isApprovedLatest, latestVersion } from './coordinator-state.ts';

/**
 * SCRUM-COORD-01: the item-scoped context packet a run starts from. It holds what this item
 * traces, then approved documents about it, then the project's approved BRD/FRD. Requirements are
 * never cut in the middle: a document that does not fit is listed with its path and hash, and the
 * packet says so. The packet is itself a versioned Markdown document linked to the item, so what a
 * run was told can be inspected later.
 *
 * @author Skorowid
 */

interface Chosen { document: ScrumDocument; version: number; why: string }

function chooseDocuments(state: ScrumState, item: ScrumItem): Chosen[] {
  const documents = state.documents ?? [];
  const chosen = new Map<string, Chosen>();
  const add = (document: ScrumDocument, version: number, why: string) => { if (!chosen.has(document.id)) chosen.set(document.id, { document, version, why }); };
  for (const trace of item.traces ?? []) {
    const document = documents.find(entry => entry.id === trace.documentId);
    if (document) add(document, trace.version, `this item traces it${trace.section ? ` (§ ${trace.section})` : ''}`);
  }
  for (const document of documents) {
    if (document.itemIds.includes(item.id) && (document.kind === 'story' || document.kind === 'decision') && isApprovedLatest(document)) add(document, latestVersion(document).version, 'approved and linked to this item');
  }
  for (const document of documents) {
    if ((document.kind === 'brd' || document.kind === 'frd') && isApprovedLatest(document)) add(document, latestVersion(document).version, 'approved project requirement');
  }
  return [...chosen.values()];
}

export function buildContextPacket(dataDir: string, state: ScrumState, item: ScrumItem): string {
  const parts: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const { document, version, why } of chooseDocuments(state, item)) {
    const read = readDocumentVersion(dataDir, document, version);
    const path = documentVersionPath(dataDir, document, version);
    const approved = document.approval?.version === version ? 'approved' : 'NOT approved';
    if (!read || read.integrity !== 'ok') {
      omitted.push(`${document.code} v${version}: the file is ${read?.integrity ?? 'missing'}; treat this requirement as unavailable and report it`);
      continue;
    }
    const section = `### ${document.code} v${version} — ${document.title} (${approved}; ${why})\n\n${read.content.trim()}`;
    if (used + section.length > SCRUM_CONTEXT_PACKET_LIMIT) {
      omitted.push(`${document.code} v${version} "${document.title}" (${approved}; ${why}): not inlined for size, read ${path}`);
      continue;
    }
    parts.push(section);
    used += section.length;
  }
  const results = (state.work ?? []).filter(work => work.itemId === item.id && work.result).slice(-3)
    .map(work => `- ${work.kind} ${work.status}${work.result?.verdict ? ` (verdict ${work.result.verdict})` : ''}: ${work.result?.summary.replace(/\s+/g, ' ').slice(0, 400)}`);
  const product = state.product;
  const objectives = product?.valueObjectives.map(objective => `- ${objective.statement}${objective.metric ? ` (measured by: ${objective.metric}${objective.target ? `; target: ${objective.target}` : ''})` : ''}`) ?? [];
  return [
    `# Context packet for "${item.title}"`,
    ...(product?.vision.trim() ? [`## Vision (the author's words)\n${product.vision.trim()}`] : []),
    ...(objectives.length ? [`## Value objectives the author defined\n${objectives.join('\n')}`] : []),
    ...(product?.definitionOfReady.trim() ? [`## Definition of Ready\n${product.definitionOfReady.trim()}`] : []),
    ...(results.length ? [`## Earlier agent results on this item\n${results.join('\n')}`] : []),
    `## Documents\n${parts.length ? parts.join('\n\n') : 'No approved document applies to this item; the requirements are the item itself.'}`,
    ...(omitted.length ? [`## Not included in this packet\n${omitted.map(line => `- ${line}`).join('\n')}`] : []),
  ].join('\n\n');
}

/** Record the packet as the item's `context` document (a new version only when its text changed). */
export function storeContextPacket(dataDir: string, state: ScrumState, item: ScrumItem, packet: string, runId: string | null): ScrumState {
  try {
    const existing = (state.documents ?? []).find(document => document.kind === 'context' && document.itemIds.includes(item.id));
    const input = { content: packet, summary: `Context handed to runs of "${item.title}"`, source: 'cezar' as const, provenance: null, runId };
    if (existing) return reviseDocument(dataDir, state, existing.id, input).state;
    return createDocument(dataDir, state, { ...input, kind: 'context', title: `Context: ${item.title}`, itemIds: [item.id] }).state;
  } catch {
    // The packet travels in the run's prompt; a failed copy here costs only the later inspection.
    return state;
  }
}
