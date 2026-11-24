import { z } from 'zod';

// ---- Pixel Studio (fork feature; docs/skorowidny-cezar/pixel-studio.md) ------------------------
// PixelForge — a local PixelLab-style pixel-art toolchain (repo Skorowid/PixelArt_Skorowid_Games,
// tools/pixelforge) — attached to cezar: an MCP server per project, a job library with sprite /
// animation / tileset previews, a generation panel and the queue for the GPU cezar.
// Workspace:  GET/PUT /workspace/pixel-studio, PUT /workspace/pixel-studio/projects/:projectId
// Project:    /p/:projectId/pixel-studio/{jobs,jobs/:jobId,jobs/:jobId/file,jobs/:jobId/process,
//             jobs/:jobId/collect,gpu-queue,gpu-queue/sync}
// Author: Skorowid

export const pixelStudioProjectStatusSchema = z.enum(['connected', 'disconnected', 'foreign', 'broken', 'missing']);
export type PixelStudioProjectStatus = z.infer<typeof pixelStudioProjectStatusSchema>;

export const pixelStudioProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: pixelStudioProjectStatusSchema,
  problem: z.string().optional(),
});
export type PixelStudioProject = z.infer<typeof pixelStudioProjectSchema>;

export const pixelStudioStatusSchema = z.object({
  /** The PixelForge checkout (launcher + its .venv python) exists at `home`. */
  installed: z.boolean(),
  /** Absolute path of the PixelForge checkout; hidden on a hosted cockpit. */
  home: z.string().optional(),
  /** `codex` on PATH — the default image generator (built-in image_gen). */
  codex: z.boolean(),
  /** `aseprite` on PATH — optional, for manual retouching. */
  aseprite: z.boolean(),
  writable: z.boolean(),
  problems: z.array(z.string()),
  projects: z.array(pixelStudioProjectSchema),
});
export type PixelStudioStatus = z.infer<typeof pixelStudioStatusSchema>;

export const setPixelStudioHomeInputSchema = z.object({ home: z.string().min(1).refine((p) => p.startsWith('/'), 'home must be an absolute path') }).strict();
export type SetPixelStudioHomeInput = z.infer<typeof setPixelStudioHomeInputSchema>;

export const setPixelStudioProjectInputSchema = z.object({ connected: z.boolean() }).strict();
export type SetPixelStudioProjectInput = z.infer<typeof setPixelStudioProjectInputSchema>;

export const pixelJobToolSchema = z.enum(['character8', 'animate', 'tileset', 'image', 'ui', 'edit', 'isometric', 'platformer', 'interpolate', 'rotate', 'resize', 'vfx', 'tileset47']);
export type PixelJobTool = z.infer<typeof pixelJobToolSchema>;
export const pixelJobStatusSchema = z.enum(['queued', 'generating', 'generated', 'processing', 'done', 'failed']);
export type PixelJobStatus = z.infer<typeof pixelJobStatusSchema>;

/** job.json (schema pixelforge.job/1), the fields the cockpit shows. Paths are job-relative. */
export const pixelJobSchema = z.object({
  id: z.string(),
  tool: pixelJobToolSchema,
  backend: z.enum(['codex', 'gpu']),
  status: pixelJobStatusSchema,
  created: z.string(),
  updated: z.string(),
  params: z.record(z.string(), z.unknown()),
  outputs: z.object({
    sheet: z.string().optional(),
    json: z.string().optional(),
    aseprite: z.string().optional(),
    frames: z.array(z.string()).optional(),
    palette: z.string().optional(),
    preview: z.string().optional(),
  }),
  qa: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  /** Raw generator images, job-relative. */
  raw: z.array(z.string()),
});
export type PixelJob = z.infer<typeof pixelJobSchema>;

export const pixelJobListSchema = z.object({ jobs: z.array(pixelJobSchema), problems: z.array(z.string()) });
export type PixelJobList = z.infer<typeof pixelJobListSchema>;

const size = z.number().int().min(16).max(168);
const colors = z.number().int().min(4).max(64);
const backend = z.enum(['codex', 'gpu']);
/** Lospec presets shipped with PixelForge (tools/pixelforge/pixelforge/palettes). */
export const pixelPalettePresetSchema = z.enum(['endesga-32', 'resurrect-64', 'sweetie-16', 'pico-8', 'apollo']);
const quality = z.enum(['standard', 'hd']);
/** A file uploaded through POST …/pixel-studio/uploads (name only, never a path). */
const uploadName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/);
/** A file of a finished job: `<jobId>/<job-relative path>`. */
const jobFileRef = z.string().max(500).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\/[A-Za-z0-9_./-]+$/, 'must be <jobId>/<file>');

const fileRef = z.union([jobFileRef, z.string().regex(/^upload:[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/)]);
const look = {
  quality: quality.default('hd'),
  outline: z.enum(['black', 'colored', 'selective', 'lineless']).optional(),
  shading: z.enum(['flat', 'basic', 'medium', 'detailed', 'highly-detailed']).optional(),
  detail: z.enum(['low', 'medium', 'high']).optional(),
};
const newCommon = { backend: backend.default('codex'), ...look };
const terrain = { lower: z.string().min(2).max(500), upper: z.string().min(2).max(500), tileSize: z.number().int().min(16).max(64).multipleOf(2).default(32), colors: colors.default(16), palette: pixelPalettePresetSchema.optional() };

export const createPixelJobInputSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('character8'),
    description: z.string().min(3).max(2000),
    size: size.default(48),
    colors: colors.default(16),
    view: z.enum(['side', 'low top-down', 'high top-down']).default('low top-down'),
    palette: pixelPalettePresetSchema.optional(),
    /** Concept art or a sketch (upload name): the character is redrawn from it. */
    concept: uploadName.optional(),
    /** Style reference images (upload names). */
    styles: z.array(uploadName).max(4).optional(),
    backend: backend.default('codex'),
    ...look,
  }).strict(),
  z.object({
    tool: z.literal('animate'),
    /** Job-relative frame of an earlier job, e.g. `<jobId>/out/frames/006.png`. */
    reference: fileRef,
    action: z.string().min(2).max(200).default('walk'),
    frames: z.union([z.literal(4), z.literal(6), z.literal(8)]).default(8),
    direction: z.string().min(2).max(20).default('east'),
    size: size.default(48),
    colors: colors.default(16),
    palette: pixelPalettePresetSchema.optional(),
    backend: backend.default('codex'),
    ...look,
  }).strict(),
  z.object({
    tool: z.literal('tileset'),
    lower: z.string().min(2).max(500),
    upper: z.string().min(2).max(500),
    tileSize: z.union([z.literal(16), z.literal(24), z.literal(32), z.literal(48), z.literal(64)]).default(32),
    colors: colors.default(16),
    palette: pixelPalettePresetSchema.optional(),
    backend: backend.default('codex'),
    ...look,
  }).strict(),
  z.object({
    tool: z.literal('image'),
    description: z.string().min(3).max(2000),
    kind: z.enum(['scene', 'map', 'object']).default('scene'),
    width: z.number().int().min(16).max(512).default(256),
    height: z.number().int().min(16).max(512).default(144),
    colors: colors.default(32),
    palette: pixelPalettePresetSchema.optional(),
    backend: backend.default('codex'),
    ...look,
  }).strict(),
  z.object({
    tool: z.literal('ui'),
    items: z.array(z.string().min(2).max(200)).min(1).max(16),
    theme: z.string().max(300).default(''),
    size: z.number().int().min(16).max(128).default(48),
    colors: colors.default(24),
    palette: pixelPalettePresetSchema.optional(),
    styles: z.array(uploadName).max(4).optional(),
    backend: backend.default('codex'),
    ...look,
  }).strict(),
  z.object({
    tool: z.literal('edit'),
    /** The pixel-art image to edit: a finished job's file or an upload (`upload:<name>`). */
    source: z.union([jobFileRef, z.string().regex(/^upload:[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/)]),
    instruction: z.string().min(3).max(2000),
    /** Optional mask upload name (white = may change). */
    mask: uploadName.optional(),
    backend: backend.default('codex'),
    ...look,
  }).strict(),

  z.object({ tool: z.literal('isometric'), description: z.string().min(3).max(2000), tileSize: z.number().int().min(16).max(64).default(32), blockHeight: z.number().int().min(0).max(128).default(0), colors: colors.default(16), palette: pixelPalettePresetSchema.optional(), edgeOutline: z.enum(['all', 'outer']).default('all'), ...newCommon }).strict(),
  z.object({ tool: z.literal('platformer'), material: z.string().min(2).max(500), decoration: z.string().max(500).optional(), tileSize: z.number().int().min(16).max(32).default(32), colors: colors.default(16), palette: pixelPalettePresetSchema.optional(), edgeOutline: z.enum(['all', 'outer']).default('all'), ...newCommon }).strict(),
  z.object({ tool: z.literal('tileset47'), ...terrain, ...newCommon }).strict(),
  z.object({ tool: z.literal('rotate'), reference: fileRef, direction: z.enum(['south','south-west','west','north-west','north','north-east','east','south-east','all']).default('east'), ...newCommon }).strict(),
  z.object({ tool: z.literal('resize'), reference: fileRef, size: z.number().int().min(1).max(512).default(48), ...newCommon }).strict(),
  z.object({ tool: z.literal('vfx'), description: z.string().min(3).max(2000), frames: z.number().int().min(4).max(16).default(8), size: z.number().int().min(8).max(128).default(48), colors: z.number().int().min(2).max(64).default(16), ...newCommon }).strict(),
  z.object({ tool: z.literal('interpolate'), start: fileRef.optional(), end: fileRef.optional(), sheet: fileRef.optional(), sheetJson: fileRef.optional(), instruction: z.string().max(2000).optional(), inbetweens: z.number().int().min(1).max(14).default(1), ...newCommon }).strict().refine((x) => Boolean((x.start && x.end && !x.sheet && !x.sheetJson) || (!x.start && !x.end && x.sheet && x.sheetJson && x.instruction?.trim())), 'provide start and end or a sheet, its JSON and an instruction'),

]);
export type CreatePixelJobInput = z.input<typeof createPixelJobInputSchema>;

export const createPixelJobResultSchema = z.object({ jobId: z.string(), status: pixelJobStatusSchema });
export type CreatePixelJobResult = z.infer<typeof createPixelJobResultSchema>;

export const pixelGpuQueueSchema = z.object({
  entries: z.array(z.object({ id: z.string(), tool: pixelJobToolSchema, status: pixelJobStatusSchema, error: z.string().nullable() })),
});
export type PixelGpuQueue = z.infer<typeof pixelGpuQueueSchema>;

export const pixelGpuSyncResultSchema = z.object({ ok: z.boolean(), log: z.string() });
export type PixelGpuSyncResult = z.infer<typeof pixelGpuSyncResultSchema>;

export const pixelUploadResultSchema = z.object({ name: z.string() });
export type PixelUploadResult = z.infer<typeof pixelUploadResultSchema>;

export const pixelExportInputSchema = z.object({ format: z.enum(['web', 'tiled', 'godot', 'unity']) }).strict();
export const pixelExportResultSchema = z.object({ paths: z.record(z.string(), z.string()) });
