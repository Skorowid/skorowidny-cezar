/** Native project-local Scrum boundary (SCRUM-LOCAL-01). Author: Skorowid. */
import {
  apiPath, getApiScope, scrumChatMessageResponseSchema, scrumChatViewSchema, scrumCoordinatorViewSchema, scrumDocumentContentSchema, scrumStateSchema, scrumLaunchResponseSchema,
  type ScrumChatMessageInput, type ScrumCoordinatorSave, type ScrumDocumentDecision, type ScrumLaunchMode, type ScrumSaveInput,
} from '@open-mercato/cezar-api-client'
import { cez, unwrap } from './client'

const scope = () => getApiScope() ?? 'default'

export async function getScrum() {
  return scrumStateSchema.parse(await unwrap(await cez.api.v1.p[':projectId'].scrum.$get({ param: { projectId: scope() } }), '/scrum'))
}

export async function saveScrum(json: ScrumSaveInput) {
  return scrumStateSchema.parse(await unwrap(await cez.api.v1.p[':projectId'].scrum.$put({ param: { projectId: scope() }, json }), '/scrum'))
}

export async function launchScrum(id: string, expectedRevision: number, mode: ScrumLaunchMode) {
  return scrumLaunchResponseSchema.parse(await unwrap(await cez.api.v1.p[':projectId'].scrum.items[':id'].launch.$post({
    param: { projectId: scope(), id }, json: { expectedRevision, mode },
  }), '/scrum/items/:id/launch'))
}

/** SCRUM-CHAT-01: the project's persistent Scrum chat thread. */
export async function getScrumChat() {
  return scrumChatViewSchema.parse(await unwrap(await cez.api.v1.p[':projectId'].scrum.chat.$get({ param: { projectId: scope() } }), '/scrum/chat'))
}

export async function sendScrumChat(json: ScrumChatMessageInput) {
  return scrumChatMessageResponseSchema.parse(await unwrap(await cez.api.v1.p[':projectId'].scrum.chat.messages.$post({ param: { projectId: scope() }, json }), '/scrum/chat/messages'))
}

/** SCRUM-COORD-01: coordinator and agent configuration, and the initial readiness gate. */
export async function getScrumCoordinator() {
  return scrumCoordinatorViewSchema.parse(await unwrap(await cez.api.v1.p[':projectId'].scrum.coordinator.$get({ param: { projectId: scope() } }), '/scrum/coordinator'))
}

export async function saveScrumCoordinator(json: ScrumCoordinatorSave) {
  return scrumCoordinatorViewSchema.parse(await unwrap(await cez.api.v1.p[':projectId'].scrum.coordinator.$put({ param: { projectId: scope() }, json }), '/scrum/coordinator'))
}

export async function getScrumDocument(id: string, version?: number) {
  return scrumDocumentContentSchema.parse(await unwrap(await cez.api.v1.p[':projectId'].scrum.documents[':id'].$get({
    param: { projectId: scope(), id }, query: version === undefined ? {} : { version: String(version) },
  }), '/scrum/documents/:id'))
}

export async function decideScrumDocument(id: string, json: ScrumDocumentDecision) {
  return scrumStateSchema.parse(await unwrap(await cez.api.v1.p[':projectId'].scrum.documents[':id'].decision.$post({ param: { projectId: scope(), id }, json }), '/scrum/documents/:id/decision'))
}

export async function checkScrumArtifact(id: string) {
  return scrumStateSchema.parse(await unwrap(await cez.api.v1.p[':projectId'].scrum.artifacts[':id'].check.$post({ param: { projectId: scope(), id } }), '/scrum/artifacts/:id/check'))
}

/** Same-origin address of a verified copy; the server refuses anything else. */
export function scrumArtifactUrl(id: string) {
  return apiPath(`/scrum/artifacts/${encodeURIComponent(id)}/content`)
}
