# Pixel Studio all-tools verification

Author: Skorowid · Version 0.1 · 2026-11-24 · Status: verified with limitations

Sources: [Pixel Studio](pixel-studio.md), [changes](changes.md), PixelArt_Skorowid_Games D-020/D-021 and `tools/pixelforge/pixelforge/jobcli.py`. Baseline: `origin/skorowidny/main` at `2fba90da` (library compatibility committed at `0b3780cd`).

## Evidence

- **Met:** contract validation and forms cover the 13 pipeline names, their inputs and supported style controls. The focused server test creates and queues all 13 against the current PixelForge CLI; browser tests submit each new form and exercise edit style.
- **Met:** guarded upload and job references cover images and interpolation JSON. Tests exercise endpoint and sheet interpolation, traversal and symlink rejection.
- **Met:** completed jobs export web, Tiled, Godot and Unity through the actual Python module; Tiled is restricted to the three terrain tools. The HTTP test checks a successful export and returned paths.
- **Met:** clean-environment focused suites, including contract, API inventory and route parity: 71 passed, 0 failed. Real CLI integration used `PIXELFORGE_TEST_PKG` pointing to the current PixelForge checkout and its existing venv.
- **Met:** clean-environment `npm run typecheck` and `npm run build` passed; build includes `check:pack`.
- **Partial:** clean-environment full `npm test -- --maxWorkers=2` under an 8 GB cap completed with 14,225 passed, 33 failed and 13 skipped. It ran while implementation files were changing. Three Pixel Studio/inventory failures were subsequently fixed or resolved and passed in the final focused run; six are the known settings/project-groups failures. Of the remaining 24, 22 failures reproduced identically on baseline; the other two are timing-sensitive cases in the same auto-resume suite, which also failed on baseline with different parameter variants. The baseline rerun of the 14 unrelated server suites reported 567 passed and 26 failed.
- **Not exercised:** a real Codex or GPU image-generation run and a live cockpit deployment. Tests queue real jobs without invoking a generator. No deployment or service restart was performed.

Focused command: `env -i HOME="$HOME" PATH="$PATH" TERM=dumb TMPDIR=/tmp USER="$USER" LANG=C.UTF-8 PIXELFORGE_TEST_PKG=<current-checkout>/tools/pixelforge timeout 300 npx vitest run packages/cezar/src/pixel-studio packages/cezar/src/server/pixel-studio-api.test.ts packages/cezar/src/server/bc-route-inventory.test.ts packages/cezar/src/server/route-parity.test.ts packages/web/src/routes/pixel-studio`.
