# Pixel Studio — PixelForge pixel-art tools in cezar

Author: Skorowid · Version 0.2 · 2026-11-24 · Status: implemented on branch `feat/pixel-studio-all-tools`, not deployed

Requirements: repo `Skorowid/PixelArt_Skorowid_Games` — `docs/BRD.md` BR-04, `docs/frd/FRD-010-cezar-pixel-studio.md`, decisions D-003, D-008, D-020, D-021, T-003, T-006.

## What it is

PixelForge (`PixelArt_Skorowid_Games/tools/pixelforge`, Python) is a local PixelLab-style toolchain: Codex built-in
`image_gen` (or the GPU cezar's open models) draws on a guide canvas; PixelForge fits the pixel grid, locks one palette,
removes the key background, aligns feet, enforces tile seams and writes sheets + Aseprite JSON + `.aseprite`.
Pixel Studio attaches it to cezar in three ways:

| Piece | Where | What |
|---|---|---|
| Private MCP server `pixelforge` | `packages/cezar/src/pixel-studio/pixel-studio.ts`, entry in `<project>/.ai/cezar/mcp.local.json` | agents get PixelForge MCP generation, editing, transformation, export, and job-management tools (the configured checkout determines the available tool set) |
| Settings → Pixel Studio | `packages/web/src/routes/settings/pixel-studio-section.tsx` | path of the PixelForge checkout, Codex/Aseprite availability, one switch per project |
| Project page `/pixel-studio` | `packages/web/src/routes/pixel-studio/` | Library (job grid, previews, sprite player, downloads, re-process and export), Generate (all 13 job pipelines, supported style controls, Codex or GPU), GPU queue (list + sync) |

The shared, unchanged-behaviour writer for `mcp.local.json` (Meshy and Pixel Studio) is `packages/cezar/src/core/private-mcp-write.ts`
(extracted from the Meshy module; Meshy tests unchanged and green).

## API

| Route | Notes |
|---|---|
| `GET /api/v1/workspace/pixel-studio` | status; `home` hidden on a hosted cockpit |
| `PUT /api/v1/workspace/pixel-studio` `{home}` | absolute path; refused unless `tools/pixelforge/mcp_launcher.py` and `.venv/bin/python` exist |
| `PUT /api/v1/workspace/pixel-studio/projects/:projectId` `{connected}` | writes/removes the `pixelforge` entry; refuses foreign entries and broken files |
| `GET /api/v1/p/:projectId/pixel-studio/jobs[/:jobId]` | `assets/jobs/*/job.json` (schema `pixelforge.job/1`) |
| `GET /api/v1/p/:projectId/pixel-studio/jobs/:jobId/file?path=` | PNG/JSON/HEX/.aseprite inside the job dir only (realpath check), `nosniff`, sandbox CSP |
| `POST /api/v1/p/:projectId/pixel-studio/jobs` | starts a job (Python worker; answers as soon as the job exists, generation continues in the background, log `assets/jobs/worker.log`) |
| `POST …/jobs/:jobId/export` `{format}` | export a completed job; returns `{paths}` relative to the job directory |
| `POST …/jobs/:jobId/process`, `…/collect` | re-run post-processing; collect a GPU job from `gpu-queue/` |
| `POST /api/v1/p/:projectId/pixel-studio/uploads` | multipart `file` (PNG/JPEG/WebP image or JSON metadata ≤ 10 MB) → `{name}` in `assets/pixel-uploads/`; sketches, concepts, style references, masks, images to edit are referenced by that name |
| `GET …/gpu-queue`, `POST …/gpu-queue/sync` | sync = `git pull --rebase --autostash`, `git add gpu-queue`, commit, push — only that folder |

Writes and process starts need the local-machine capability (hosted cockpit: 409), like Meshy.

## Decision T-006 (technical)

Jobs started by agents in a run worktree also land in the project's main library: the MCP entry sets
`PIXELFORGE_JOBS=<project root>/assets/jobs`, so the Pixel Studio page shows them immediately. The owner commits assets
they keep.

## Setup on a machine

```bash
git clone https://github.com/Skorowid/PixelArt_Skorowid_Games ~/ai-projects/PixelArt_Skorowid_Games
cd ~/ai-projects/PixelArt_Skorowid_Games
~/.local/bin/python3.12 -m venv .venv          # any Python >= 3.11 with venv/pip
.venv/bin/pip install -r tools/pixelforge/requirements.txt
(cd tools/pixelforge && ../../.venv/bin/python -m pytest -q)   # 126 tests
```

Then Settings → Pixel Studio: set the checkout path, switch projects on. Codex must be logged in (`codex` on PATH) for
the Codex generator.

## Tests

- `packages/cezar/src/pixel-studio/pixel-studio.test.ts` — config, status, MCP entry, job listing, file guard, GPU sync
  (fake git), and an integration test with the real checkout when present (`PIXELFORGE_HOME`).
- `packages/cezar/src/server/pixel-studio-api.test.ts` — the routes, validation, path traversal, refusal without install.
- `packages/web/src/routes/pixel-studio/pixel-studio-model.test.ts` — sheet parsing, tag playback timing, forms.
- Nav/settings expectation lists updated (`nav-items.test.ts`, `app-shell.test.tsx`, `settings.test.tsx`).

## All PixelForge tools (D-021)

Generate supports `character8`, `animate`, `tileset`, `image`, `ui`, `edit`, `isometric`, `platformer`, `interpolate`, `rotate`, `resize`, `vfx`, and `tileset47`. The library recognizes all 13 types and falls back to the sheet or first frame when no preview is available. Interpolation accepts two uploaded or library frames, or a sheet and its JSON from uploads or a finished library job. Rotate and resize accept an uploaded image or library frame. Style controls expose quality (HD by default), outline, shading and detail for pipelines that support them; isometric and platformer also expose edge outline. The edit pipeline has no native style parameters, so the worker updates its generation prompt with PixelForge’s resolved style wording while retaining the edit instruction. PixelForge's UI pipeline internally assumes HD, so the worker resolves the standard-quality style before passing it to that pipeline.

The create worker maps validated inputs to `pixelforge.jobcli`'s parser and `create` function. Files are resolved through upload names or job-relative references, with realpath checks; arbitrary client paths are refused. The configured PixelForge checkout must contain the current 13-tool CLI and export modules.

Finished jobs offer Export to web, Godot or Unity; tileset, platformer and tileset47 also offer Tiled. The fixed output directory is `<job>/export/<format>`, and the API returns job-relative paths. The server rejects unfinished jobs, unsupported Tiled inputs and symlinks in the export directory.

Verification: contract, server/API and web tests cover each added tool, styles, file references and export. Set `PIXELFORGE_TEST_PKG` to the current checkout's `tools/pixelforge` directory to enable the real-CLI integration tests, which use the PixelForge venv at `~/ai-projects/PixelArt_Skorowid_Games/.venv`.

Verification evidence and limitations: [pixel-studio-verification.md](pixel-studio-verification.md).
