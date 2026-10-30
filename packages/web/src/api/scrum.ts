/** Native project-local Scrum boundary (SCRUM-LOCAL-01). Author: Skorowid. */
import { getApiScope, scrumStateSchema, scrumLaunchResponseSchema, type ScrumLaunchMode, type ScrumSaveInput } from '@open-mercato/cezar-api-client'
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
