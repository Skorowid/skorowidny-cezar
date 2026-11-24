import { describe, expect, it } from 'vitest';
import { createPixelJobInputSchema, pixelExportInputSchema } from '@open-mercato/cezar-contract';

const examples = [
  { tool: 'isometric', description: 'stone floor', edgeOutline: 'outer' },
  { tool: 'platformer', material: 'mossy stone', edgeOutline: 'outer' },
  { tool: 'interpolate', start: 'job/out/start.png', end: 'upload:end.png' },
  { tool: 'rotate', reference: 'upload:sprite.png', direction: 'all' },
  { tool: 'resize', reference: 'job/out/frame.png', size: 128 },
  { tool: 'vfx', description: 'magic fire', frames: 16 },
  { tool: 'tileset47', lower: 'grass', upper: 'dirt' },
];
describe('Pixel Studio job contract', () => {
  it.each(examples)('accepts $tool and defaults quality to HD', (example) => {
    expect(createPixelJobInputSchema.parse(example)).toMatchObject({ tool: example.tool, quality: 'hd' });
  });
  it('accepts sheet interpolation and rejects incomplete or mixed forms', () => {
    expect(createPixelJobInputSchema.safeParse({ tool: 'interpolate', sheet: 'job/out/sheet.png', sheetJson: 'job/out/sheet.json', instruction: 'change pose' }).success).toBe(true);
    expect(createPixelJobInputSchema.safeParse({ tool: 'interpolate', sheet: 'upload:sheet.png', sheetJson: 'upload:sheet.json', instruction: 'change pose' }).success).toBe(true);
    for (const invalid of [
      { tool: 'interpolate', start: 'job/out/a.png' },
      { tool: 'interpolate', start: 'job/out/a.png', end: 'job/out/b.png', sheet: 'job/out/sheet.png' },
      { tool: 'rotate', reference: 'upload:../secret' },
      { tool: 'resize', reference: '/etc/passwd' },
      { tool: 'vfx', description: 'magic', frames: 17 },
      { tool: 'platformer', material: 'grass', tileSize: 64 },
      { tool: 'isometric', description: 'stone', outline: 'glow' },
    ]) expect(createPixelJobInputSchema.safeParse(invalid).success).toBe(false);
  });
  it('validates animation options without defaulting size', () => {
    const base = { tool: 'animate', reference: 'upload:sprite.png' };
    expect(createPixelJobInputSchema.parse(base)).not.toHaveProperty('size');
    for (const weapon of ['sword', 'staff', 'bow']) expect(createPixelJobInputSchema.safeParse({ ...base, weapon, description: 'x'.repeat(500) }).success).toBe(true);
    expect(createPixelJobInputSchema.safeParse({ ...base, weapon: 'axe' }).success).toBe(false);
    expect(createPixelJobInputSchema.safeParse({ ...base, description: 'x'.repeat(501) }).success).toBe(false);
  });
  it('accepts only supported export formats', () => {
    for (const format of ['web', 'tiled', 'godot', 'unity']) expect(pixelExportInputSchema.safeParse({ format }).success).toBe(true);
    expect(pixelExportInputSchema.safeParse({ format: '../x' }).success).toBe(false);
  });
});
