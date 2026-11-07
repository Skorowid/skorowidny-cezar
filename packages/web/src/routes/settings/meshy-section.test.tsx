import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { MeshyStatus } from '@open-mercato/cezar-api-client'
import { MeshySection } from './meshy-section'
import { SETTINGS_SECTIONS } from './registry'

// Fork feature (docs/skorowidny-cezar/meshy-integration.md). Author: Skorowid.
let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(status: MeshyStatus) {
  requests = []
  let current = status
  const json = (payload: unknown, code = 200) =>
    new Response(JSON.stringify(payload), { status: code, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/meshy' && method === 'GET') return json(current)
      const match = url.match(/^\/api\/v1\/workspace\/meshy\/projects\/([^/]+)$/)
      if (match && method === 'PUT') {
        current = {
          ...current,
          projects: current.projects.map((p) =>
            p.id === match[1] ? { ...p, status: body.connected ? 'connected' : 'disconnected' } : p,
          ),
        }
        return json(current)
      }
      return json({ error: 'unexpected' }, 404)
    }),
  )
}

const READY: MeshyStatus = {
  installed: true,
  version: '0.6.9',
  keyPresent: true,
  keyPrivate: true,
  outputDir: '/home/u/ai-projects/mesh_outputs',
  writable: true,
  problems: [],
  projects: [
    { id: 'robo', name: 'RobocraftWars', status: 'disconnected' },
    { id: 'chess', name: 'SnakeBiteChess', status: 'connected' },
    { id: 'odd', name: 'Odd', status: 'foreign', problem: 'a "meshy" entry that does not start this machine’s launcher' },
  ],
}

function mount() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MeshySection />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Settings → global → Meshy AI', () => {
  it('is a global settings section', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.id === 'meshy')).toMatchObject({ scope: 'global', title: 'Meshy AI' })
  })

  it('shows the machine state and every project with its status', async () => {
    serve(READY)
    mount()
    expect(await screen.findByText('installed, 0.6.9')).toBeTruthy()
    expect(screen.getByText('set (private file)')).toBeTruthy()
    expect(screen.getByText('/home/u/ai-projects/mesh_outputs')).toBeTruthy()
    expect(screen.getByText('RobocraftWars')).toBeTruthy()
    expect(screen.getByText('Custom entry')).toBeTruthy()
    expect((screen.getByRole('switch', { name: 'Meshy for Odd' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('connects a project with only { connected } in the body', async () => {
    serve(READY)
    mount()
    fireEvent.click(await screen.findByRole('switch', { name: 'Meshy for RobocraftWars' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Meshy for RobocraftWars' }).getAttribute('aria-checked')).toBe('true'))
    expect(requests.find((r) => r.method === 'PUT')).toEqual({
      method: 'PUT',
      url: '/api/v1/workspace/meshy/projects/robo',
      body: { connected: true },
    })
  })

  it('does not offer connecting without a key, but still allows disconnecting', async () => {
    serve({ ...READY, keyPresent: false, keyPrivate: false, problems: ['No API key: run meshy_mcp.py set-key in a terminal.'] })
    mount()
    expect(await screen.findByText(/No API key/)).toBeTruthy()
    expect((screen.getByRole('switch', { name: 'Meshy for RobocraftWars' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch', { name: 'Meshy for SnakeBiteChess' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('is read-only on a hosted cockpit', async () => {
    serve({ ...READY, writable: false })
    mount()
    expect(await screen.findByText(/only possible on the machine hosting cezar/)).toBeTruthy()
    for (const sw of screen.getAllByRole('switch')) expect((sw as HTMLButtonElement).disabled).toBe(true)
  })
})
