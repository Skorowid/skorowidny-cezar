import { describe, expect, it } from 'vitest'

import type { PixelJob } from '@open-mercato/cezar-api-client'

import { TOOL_LABEL, editSourceOptions, frameAt, parseItems, parseSheet, qaSummary, referenceOptions, tagSequence } from './pixel-studio-model'

// Fork feature (docs/skorowidny-cezar/pixel-studio.md). Author: Skorowid.

const sheetJson = {
  frames: [0, 1, 2, 3].map((i) => ({ frame: { x: i * 16, y: 0, w: 16, h: 16 }, duration: i === 1 ? 200 : 100 })),
  meta: {
    size: { w: 64, h: 16 },
    frameTags: [
      { name: 'walk', from: 0, to: 3, direction: 'pingpong' },
      { name: 'back', from: 1, to: 2, direction: 'reverse' },
      { name: 'bad', from: 2, to: 9 },
    ],
  },
}

describe('parseSheet', () => {
  it('reads frames, durations and valid tags only', () => {
    const s = parseSheet(sheetJson)!
    expect(s.frames).toHaveLength(4)
    expect(s.frames[1]).toEqual({ x: 16, y: 0, w: 16, h: 16, duration: 200 })
    expect(s.tags.map((t) => t.name)).toEqual(['walk', 'back'])
    expect(s.width).toBe(64)
  })

  it('returns null for garbage', () => {
    expect(parseSheet(null)).toBeNull()
    expect(parseSheet({ frames: 'x' })).toBeNull()
    expect(parseSheet({ frames: [] })).toBeNull()
  })
})

describe('playback', () => {
  const s = parseSheet(sheetJson)!
  it('builds sequences per direction', () => {
    expect(tagSequence(s, null)).toEqual([0, 1, 2, 3])
    expect(tagSequence(s, 'walk')).toEqual([0, 1, 2, 3, 2, 1])
    expect(tagSequence(s, 'back')).toEqual([2, 1])
  })

  it('picks the frame by elapsed time with per-frame durations and loops', () => {
    const seq = tagSequence(s, null) // 100 + 200 + 100 + 100 = 500 ms
    expect(frameAt(s, seq, 0)).toBe(0)
    expect(frameAt(s, seq, 99)).toBe(0)
    expect(frameAt(s, seq, 100)).toBe(1)
    expect(frameAt(s, seq, 299)).toBe(1)
    expect(frameAt(s, seq, 300)).toBe(2)
    expect(frameAt(s, seq, 500)).toBe(0)
    expect(frameAt(s, [], 50)).toBe(0)
  })
})

describe('forms and summaries', () => {
  const job = (over: Partial<PixelJob>): PixelJob => ({
    id: 'j1', tool: 'character8', backend: 'codex', status: 'done', created: '', updated: '',
    params: { description: 'mage' }, outputs: { frames: ['out/frames/000.png', 'out/frames/001.png'] },
    qa: {}, error: null, raw: [], ...over,
  })

  it('offers frames of finished 8-direction jobs as references', () => {
    const opts = referenceOptions([job({}), job({ id: 'j2', status: 'generating' }), job({ id: 'j3', tool: 'tileset' })])
    expect(opts).toEqual([
      { value: 'j1/out/frames/000.png', label: 'mage — south' },
      { value: 'j1/out/frames/001.png', label: 'mage — south-west' },
    ])
  })

  it('offers every frame of every finished job as an edit source', () => {
    const opts = editSourceOptions([job({}), job({ id: 'u1', tool: 'ui', params: {}, outputs: { frames: ['out/frames/000.png'] } }), job({ id: 'x', status: 'failed' })])
    expect(opts.map((o) => o.value)).toEqual(['j1/out/frames/000.png', 'j1/out/frames/001.png', 'u1/out/frames/000.png'])
    expect(opts[2]?.label).toBe('UI elements — frame 1')
  })

  it('parses UI items one per line, dropping blanks, capped at 16', () => {
    expect(parseItems(' button \n\n x\norb\n')).toEqual(['button', 'orb'])
    expect(parseItems(Array.from({ length: 20 }, (_, i) => `item ${i}`).join('\n'))).toHaveLength(16)
  })

  it('summarises QA in a stable order', () => {
    expect(qaSummary({ pitch: 6.35, frames: 8, other: 1, anchor_spread_px: 0 })).toEqual([
      ['frames', '8'], ['anchor spread px', '0'], ['pitch', '6.35'],
    ])
  })
})


it('labels every additional PixelForge tool', () => {
  for (const tool of ['isometric', 'platformer', 'interpolate', 'rotate', 'resize', 'vfx', 'tileset47'] as const) {
    expect(TOOL_LABEL[tool]).toBeTruthy()
  }
})
