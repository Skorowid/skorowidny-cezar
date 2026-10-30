/** User flows for SCRUM-LOCAL-01. Author: Skorowid. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ScrumState } from '@open-mercato/cezar-api-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { getScrum, saveScrum, launchScrum } from '@/api/scrum'
import { ScrumRoute } from './scrum'

vi.mock('@/api/scrum', () => ({ getScrum: vi.fn(), saveScrum: vi.fn(), launchScrum: vi.fn() }))
const itemId = '00000000-0000-4000-8000-000000000001'
const runId = '00000000-0000-4000-8000-000000000002'
function fixture(): ScrumState {
  return { schemaVersion: 1, revision: 0, productGoal: 'Usable product', definitionOfDone: 'Reviewed and tested', sprints: [], notes: [], items: [{ id: itemId, title: 'Backlog export', description: 'User need', acceptanceCriteria: ['Valid file'], dorStatus: 'NEEDS CLARIFICATION', approved: false, questions: ['Which fields?'], priority: 1, dependencies: [], deliveryStatus: 'open', doneEvidence: '', runIds: [] }] }
}
function mount(projectId = 'project-a', client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const tree = (id: string) => <QueryClientProvider client={client}><MemoryRouter><ProjectScopeProvider projectId={id}><ScrumRoute /></ProjectScopeProvider></MemoryRouter></QueryClientProvider>
  const result = render(tree(projectId))
  return { ...result, switchProject: (id: string) => result.rerender(tree(id)) }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getScrum).mockResolvedValue(fixture())
  vi.mocked(saveScrum).mockImplementation(async input => ({ ...input.state, revision: input.expectedRevision + 1 }))
})
afterEach(cleanup)

it('loads the native backlog and exposes product goals without starting an agent', async () => {
  mount()
  expect(await screen.findByText('Backlog export')).toBeTruthy()
  expect(screen.getByText('Usable product')).toBeTruthy()
  expect(screen.getByText('No active Sprint.')).toBeTruthy()
  expect(launchScrum).not.toHaveBeenCalled()
})

it('creates a draft and preserves multiline criteria before saving the full versioned state', async () => {
  mount()
  await screen.findByText('Backlog export')
  fireEvent.click(screen.getByRole('button', { name: 'Add PBI' }))
  fireEvent.change(screen.getByLabelText('PBI title'), { target: { value: 'New need' } })
  const criteria = screen.getByLabelText('Acceptance criteria — one per line')
  fireEvent.change(criteria, { target: { value: 'First\n' } })
  expect((criteria as HTMLTextAreaElement).value).toBe('First\n')
  fireEvent.change(criteria, { target: { value: 'First\nSecond' } })
  fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
  await waitFor(() => expect(saveScrum).toHaveBeenCalledTimes(1))
  const input = vi.mocked(saveScrum).mock.calls[0]![0]
  expect(input.expectedRevision).toBe(0)
  expect(input.state.items[1]).toMatchObject({ title: 'New need', acceptanceCriteria: ['First', 'Second'], approved: false, dorStatus: 'NEEDS CLARIFICATION' })
})

it('keeps unsaved edits on a revision conflict and displays the server refusal', async () => {
  vi.mocked(saveScrum).mockRejectedValue(new Error('Revision conflict — reload'))
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Backlog export/ }))
  fireEvent.change(screen.getByLabelText('PBI title'), { target: { value: 'My edit' } })
  fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
  expect((await screen.findByRole('alert')).textContent).toContain('Revision conflict')
  expect((screen.getByLabelText('PBI title') as HTMLInputElement).value).toBe('My edit')
})

it('starts refinement through the real API seam and links the returned run', async () => {
  const state = fixture(); state.revision = 1; state.items[0]!.runIds = [runId]
  vi.mocked(launchScrum).mockResolvedValue({ state, runId })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Backlog export/ }))
  fireEvent.click(screen.getByRole('button', { name: 'BA refinement' }))
  await waitFor(() => expect(launchScrum).toHaveBeenCalledWith(itemId, 0, 'refine'))
  expect((await screen.findByRole('link', { name: /Run 00000000/ })).getAttribute('href')).toBe(`/p/project-a/tasks/${runId}`)
})

it('persists an event note without silently confirming requirements', async () => {
  mount()
  await screen.findByText('Backlog export')
  fireEvent.click(screen.getByRole('button', { name: 'Notebook' }))
  fireEvent.change(screen.getByLabelText('Note kind'), { target: { value: 'refinement' } })
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Question for the BA about the export format.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save note and current changes' }))
  await waitFor(() => expect(saveScrum).toHaveBeenCalledTimes(1))
  const state = vi.mocked(saveScrum).mock.calls[0]![0].state
  expect(state.notes[0]).toMatchObject({ kind: 'refinement', body: 'Question for the BA about the export format.', itemId: null, sprintId: null })
  expect(state.items[0]!.approved).toBe(false)
})

it('does not carry a dirty backlog into a different project', async () => {
  const page = mount()
  fireEvent.click(await screen.findByRole('button', { name: /Backlog export/ }))
  fireEvent.change(screen.getByLabelText('PBI title'), { target: { value: 'Private draft A' } })
  vi.mocked(getScrum).mockResolvedValue({ ...fixture(), productGoal: 'Product B', items: [] })
  page.switchProject('project-b')
  expect(await screen.findByText('Product B')).toBeTruthy()
  expect(screen.queryByText('Private draft A')).toBeNull()
  expect(saveScrum).not.toHaveBeenCalled()
})
