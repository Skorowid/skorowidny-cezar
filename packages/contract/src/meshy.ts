import { z } from 'zod';

// ---- Meshy AI (`GET /workspace/meshy`, `PUT /workspace/meshy/projects/:projectId`) ----------
// Fork feature (docs/skorowidny-cezar/meshy-integration.md): Meshy's MCP server attached per
// project through `.ai/cezar/mcp.local.json`. The key never crosses the API: only whether its
// file exists and is private.

/** How one registered project relates to the Meshy server. */
export const meshyProjectStatusSchema = z.enum([
  /** `mcp.local.json` has the `meshy` entry this machine's launcher expects. */
  'connected',
  /** No `meshy` entry (or no file). */
  'disconnected',
  /** A `meshy` entry exists but starts something else; cezar never overwrites it. */
  'foreign',
  /** `mcp.local.json` is not valid JSON or not an `mcpServers` object. */
  'broken',
  /** The project's folder is gone. */
  'missing',
]);
export type MeshyProjectStatus = z.infer<typeof meshyProjectStatusSchema>;

export const meshyProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: meshyProjectStatusSchema,
  problem: z.string().optional(),
});
export type MeshyProject = z.infer<typeof meshyProjectSchema>;

export const meshyStatusSchema = z.object({
  /** The pinned server and launcher are installed (`fork/tools/meshy_mcp.py install`). */
  installed: z.boolean(),
  version: z.string().optional(),
  /** `~/.config/meshy/meshy.env` exists… */
  keyPresent: z.boolean(),
  /** …and is `0600`-class and owned by the cezar user (the launcher refuses it otherwise). */
  keyPrivate: z.boolean(),
  /** Where downloads land (`set-output`); absent = the launcher's private work dir. */
  outputDir: z.string().optional(),
  /** Connect/Disconnect are local-machine writes; false on a hosted cockpit. */
  writable: z.boolean(),
  problems: z.array(z.string()),
  projects: z.array(meshyProjectSchema),
});
export type MeshyStatus = z.infer<typeof meshyStatusSchema>;

export const setMeshyProjectInputSchema = z.object({ connected: z.boolean() }).strict();
export type SetMeshyProjectInput = z.infer<typeof setMeshyProjectInputSchema>;
