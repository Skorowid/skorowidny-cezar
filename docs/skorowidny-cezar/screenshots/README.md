# skorowidny-cezar screenshots

Taken 2026-10-30 with headless Chromium from the real cockpit built from this checkout — not mock-ups. The earlier prototype images (`cockpit-demo.png`, `backend-example.png` and its JSON) were removed: they showed the inherited Tasks page and the Python reference example, not the native Scrum module.

| File | What it shows |
|---|---|
| `scrum-backlog.png` | The Scrum page (`/p/:projectId/scrum`): Product Goal, active Sprint Goal, ordered Product Backlog and the PBI editor |
| `scrum-readiness-refusal.png` | "Start implementation" on a PBI that is not READY: the server refuses with 409 and names every unmet readiness rule |
| `scrum-sprints.png` | Sprint planning: Sprint Goal, calendar dates (at most one month) and the Sprint Backlog |
| `scrum-notebook.png` | The notebook with Sprint Planning, question and Retrospective entries linked to a PBI or Sprint |
| `scrum-linked-run.png` | An implementation run started from a PBI, open on the existing Tasks page in its own `cez/<id8>` worktree |
| `upstream-comparison.png` | Documentation view of the upstream difference report ([JSON](upstream-report.json)) |

## How they were made

A separate `CEZ_HOME`, two throw-away git repositories and `CEZ_DRY_RUN=1` (agent CLIs mocked; the run's chat text, token counts and the "draft PR #123" in `scrum-linked-run.png` come from that mock), with `CEZ_TELEMETRY=0`, `CEZ_SKILLS_AUTO_UPDATE=0` and `CEZ_NO_BANNER=1`, on a free loopback port, 1440 px wide. All backlog content is synthetic. No user session, project, attachment or model account was used, and the preview was stopped afterwards; it is not a deployment.
