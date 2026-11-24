import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import type { PixelJob } from '@open-mercato/cezar-api-client'
import { Generate, JobViewer, NewToolForm } from './pixel-studio-route'

const exportJob = vi.hoisted(() => vi.fn(async () => ({ paths: { image: 'export/web/atlas.png' } })))
const create = vi.hoisted(() => vi.fn(async () => ({ jobId: 'new-job', status: 'queued' })))
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), createPixelJob: create, exportPixelJob: exportJob }))
const job: PixelJob = { id: 'job1', tool: 'character8', status: 'done', backend: 'codex', created: '', updated: '', params: {}, outputs: { frames: ['out/frame.png'], sheet: 'out/sheet.png', json: 'out/sheet.json' }, qa: {}, error: null, raw: [] }
afterEach(() => { cleanup(); create.mockClear() })

describe('additional PixelForge forms', () => {
  it.each([
    ['isometric', 'Description', 'stone tile'],
    ['platformer', 'Material', 'stone'],
    ['interpolate', null, null],
    ['rotate', null, null],
    ['resize', null, null],
    ['vfx', 'Description', 'magic fire'],
    ['tileset47', 'Lower terrain', 'grass'],
  ] as const)('submits %s through its form', async (tool, label, value) => {
    const onStarted = vi.fn()
    render(<QueryClientProvider client={createQueryClient()}><NewToolForm tool={tool} jobs={[job]} onTool={vi.fn()} onStarted={onStarted} /></QueryClientProvider>)
    if (label && value) fireEvent.change(screen.getByLabelText(label), { target: { value } })
    if (tool === 'tileset47') fireEvent.change(screen.getByLabelText('Upper terrain'), { target: { value: 'dirt' } })
    fireEvent.change(screen.getByLabelText('Outline'), { target: { value: 'black' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ tool, quality: 'hd', outline: 'black' })))
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('new-job'))
  })
})


it('exports a finished tileset and shows returned paths', async () => {
  const tileset = { ...job, tool: 'tileset47' as const, outputs: { preview: 'out/preview.png' } }
  render(<QueryClientProvider client={createQueryClient()}><JobViewer job={tileset} /></QueryClientProvider>)
  fireEvent.change(screen.getByLabelText('Export format'), { target: { value: 'tiled' } })
  fireEvent.click(screen.getByRole('button', { name: 'Export' }))
  await waitFor(() => expect(exportJob).toHaveBeenCalledWith('job1', 'tiled'))
  expect(await screen.findByText('image: export/web/atlas.png')).toBeTruthy()
})

it('passes selected edit style with a library image', async () => {
  render(<QueryClientProvider client={createQueryClient()}><Generate jobs={[job]} onStarted={vi.fn()} /></QueryClientProvider>)
  fireEvent.change(screen.getByLabelText('Tool'), { target: { value: 'edit' } })
  fireEvent.change(screen.getByLabelText('Change'), { target: { value: 'add a hat' } })
  fireEvent.change(screen.getByLabelText('Outline'), { target: { value: 'lineless' } })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ tool: 'edit', source: 'job1/out/frame.png', quality: 'hd', outline: 'lineless' })))
})


it('submits animation auto size and optional animation fields', async () => {
  render(<QueryClientProvider client={createQueryClient()}><Generate jobs={[job]} onStarted={vi.fn()} /></QueryClientProvider>)
  fireEvent.change(screen.getByLabelText('Tool'), { target: { value: 'animate' } })
  expect((screen.getByLabelText('Size') as HTMLInputElement).value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(create).toHaveBeenCalled())
  expect(create.mock.calls[0][0]).not.toHaveProperty('size')
  fireEvent.change(screen.getByLabelText('Size'), { target: { value: '64' } })
  fireEvent.change(screen.getByLabelText('Weapon'), { target: { value: 'sword' } })
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'red cloak' } })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ size: 64, weapon: 'sword', description: 'red cloak' })))
})
