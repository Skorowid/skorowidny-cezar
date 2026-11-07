# skorowidny-cezar changes

## 2026-11-07 — Meshy AI 3D generation as a private MCP server

Meshy is a 3D generation API, not a coding agent, so it cannot be a runner. It is attached as a private MCP server of a project (`.ai/cezar/mcp.local.json`), which every runner with an MCP channel already receives. Meshy's official server `@meshy-ai/meshy-mcp-server` is installed at a pinned version, with the key in one `0600` file outside every project, and a launcher that pins the API host so a repository `.env` cannot redirect the key. Setup, costs, safety and open decisions: [meshy-integration.md](meshy-integration.md). No cezar runtime code changed; no project is registered by this change.

### Verification

| Check | Result |
|---|---|
| `python3 -m unittest test_meshy_mcp test_upstream_report` (in `fork/tools`) | 30 tests PASS; the 9 regression cases for the audit fixes fail against the first commit |
| `install` of 0.6.9 into a sandbox `HOME` and into the real one | installed; after the audit, `npm ci` from the reviewed lockfile |
| Repository `.env` with `https_proxy`, `MESHY_API_HOST` at a dead port and `NODE_TLS_REJECT_UNAUTHORIZED=0`, Claude run | request still reached Meshy (401): the `.env` is not loaded |
| `check` (MCP handshake over stdio, no credits) | 28 tools |
| `check --balance` with an invalid key | Meshy 401, reported without the key |
| Claude Code `--mcp-config` + `--allowedTools mcp__meshy` in `dontAsk` | the agent called `meshy_check_balance`; Meshy answered 401 |
| OpenCode 2.2.5 `opencode serve` with `OPENCODE_CONFIG_CONTENT` | `GET /api/mcp`: `meshy` `connected` |
| Codex `mcp_servers.meshy` override | `enabled` |
| `npm run typecheck`, `npm run build` with `check:pack` | PASS |

Codex audit (`codex exec`, read-only), verdict `changes`, all fixed: a repository `.env` could intercept the key through a proxy with TLS checks off (HIGH; the server now never runs in the worktree); transitive dependencies were unpinned (lockfile + `npm ci`); temp file name escaped cezar's ignore pattern; `install` from the installed launcher failed half-way; lost updates on concurrent edits (stale-write check); `check` reported a broken entry as registered; unhandled errors and an undrained stderr in the handshake.

Not exercised: a real key and a real paid task (no key bought yet), `junie` and `copilot` (not installed), the cockpit editor for the file.

## 2026-11-03 — Codex takes over when OpenCode cannot do the work

By the owner's decision, Codex now takes the role of OpenCode in Scrum: the coordinator's thread and the agents, before starting and after a real failure. Rules and open choices: [scrum-coordinator.md](scrum-coordinator.md#codex-takes-over-when-opencode-cannot-do-the-work). Unchanged: no automatic retry of a failed attempt, human approval, no automatic Done.

Also: read-only OpenCode 2.x runs now refuse reads outside their directory; the author's message is no longer shown twice after a hand-over; `origin/upstream-main` moved to `v0.18.0`.

### Verification

Test suites stay paused: `npm test`, `test:unit`, `test:package`, `test:e2e` NOT run, no tests added, `scrum.test.tsx` still stale.

| Check | Result |
|---|---|
| `npm run typecheck`, `npm run build` with `check:pack` | PASS |
| Sandbox with a simulated broken OpenCode and real Codex | OpenCode thread failed at start; Codex answered the same message; the conversation continued on Codex through a restart with BRD and FRD, approval by chat, item and Sprint |
| Same sandbox, implementer configured for OpenCode | Attempt failed and was NOT retried; the coordinator asked; "try again" ran on Codex |
| Change sent while that attempt ran | `forward-pending`, then `forwarded`, and the committed code reflects the change |
| Real OpenCode 2.2.5, read-only rules | Read outside the directory refused, no write or shell tool available |
| Real OpenCode 2.2.5, `permission.asked` | Observed; the shape matches the runner's reading; reply accepted (204) |
| Real OpenCode in a directory without git | Coordinator answered |

Not exercised: a real usage limit on OpenCode (simulated failure was a server that would not start; `session.retry.scheduled` never seen), a real lost login, and the return to OpenCode after the hour. The takeover UI text was not viewed in a browser.

## 2026-11-03 — decision Q3

The owner decided that a cited quote is sufficient to approve a backlog item. This confirms existing behaviour; no code changed.

## 2026-11-03 — upgrade to upstream v0.18.0, OpenCode 2.x runner, coordinator verified live (OC-1)

**Upstream:** merged the verified release tag `v0.18.0` of `open-mercato/cezar`, commit `0d801132ecc4a628e650c4cc1b5072e5d256ff15`. Verified with `gh release view` (published, not draft or prerelease), the GitHub tag ref API and `git ls-remote`; the commit's `packages/cezar/package.json` says `0.18.0`. Its parent line is 13 commits over the fork's earlier base `eb157816`. No file conflicted and no fork file needed adaptation; `fork/upstream.json` records the new baseline. Behaviour to know from upstream: onboarding for first-run users, OpenCode native question cards, and vault key changes (new keychain keys are unreadable by older binaries).

**OC-1 resolved without changing OpenCode:** the runner now also drives the OpenCode 2.x server API (`opencode-v2-events.ts`, `opencode-server-runner.ts`). It detects 2.x from `GET /api/location`; 1.x keeps its path. Each server gets a random Basic-auth password that stays between cezar and that child. Continue resumes the persisted 2.x session when it is still in the same directory. On 2.x, read-only runs get session rules that remove edit, write and shell, so the coordinator and consultants are read-only by enforcement rather than instruction alone (reading outside the project is not blocked by these rules).

**Found by a real conversation and fixed:**
- A document cited by its code (`BRD-1`) was refused; it now resolves by code as well as id.
- A model can report success for an operation cezar refused. Refusals now appear in the conversation as cezar notices, and `INDEX.md` lists what the last turn had refused. The coordinator is told to word operations as requested, but wording is the model's; the notice is the guarantee.
- After a restart the engine's own resume prompt was shown as the author's message and could have backed a quote. Engine resume prompts are now internal, like agent results.
- Coordinator messages rendered as raw Markdown; they now use the cockpit's Markdown renderer.

### Verification

Test suites stay paused at the user's request: `npm test`, `npm run test:unit`, `npm run test:package`, `npm run test:e2e` were NOT run, and no tests were added. One expectation in `opencode-server-runner.test.ts` was reworded to the new message, unrun. `scrum.test.tsx` was already stale.

| Check | Result |
|---|---|
| `npm run typecheck`, `npm run build` with `check:pack` | PASS |
| Runner against real OpenCode 2.2.5 and the configured Gemini model | Two turns in one session, shell tool, usage and cost events, question form with its answer returned, unknown model reported as an error |
| Built server, sandbox `CEZ_HOME` and repository, real OpenCode and Gemini, no dry run | Initial questions asked, nothing invented; BRD and FRD drafted; first split refused until approved; approval by chat; ×3 estimate stored; Sprint planned inside constraints; consultation, implementation and review ran as real runs and their results returned to the coordinator; screenshot verified with hash; preview link probed, cockpit self-link refused; `.py` file rejected with its reason; stale revision 409; no item reached Done on its own |
| Restart with an implementation running (same sandbox) | `cezar restarted — resuming the interrupted task`, same OpenCode session id, work finished |
| Headless Chromium on the new views | Readiness, Documents with one opened, Agents and results, Backlog, Sprints and Product settings rendered with no page or console errors; coordinator Markdown (lists, bold, inline code) rendered, with no raw `**` in its messages |

Not exercised: retry instructed through chat after a real failure, a forwarded change delivered to a live OpenCode run, a usage-limit hold on 2.x (`session.retry.scheduled` shape read from the binary, never seen), a real permission prompt on 2.x (none appeared), subtask rendering (child sessions are not shown). The run stack on other runners (Claude, Codex) received only the upstream merge, no live check here.

## 2026-11-03 — product coordinator on OpenCode (SCRUM-COORD-01)

The project's Scrum chat becomes one persistent OpenCode coordinator that assists the human Product Owner. Specification, DoR per slice, the Scrum/extension split and limits: [scrum-coordinator.md](scrum-coordinator.md).

- **Coordinator:** the thread runs on OpenCode, with the model resolved from the project's configured OpenCode choice; no model name is hardcoded. An older Codex thread stays readable. A missing OpenCode is reported up front.
- **Initial readiness gate:** on a new project cezar refuses the first decomposition until the initial questions are handled, and the author has approved a minimum BRD and FRD in Markdown. Existing backlogs keep working without it.
- **Documents as memory:** versioned, hashed Markdown (BRD, FRD, stories, decisions, context packets, agent results), approval of one exact version, item traces that block on a changed baseline, a compact `INDEX.md` and per-item cards.
- **Planning:** Sprint Goals and dates may be planned by the coordinator only inside constraints the author agreed. This supersedes the earlier manual-only Sprint rule. Estimates keep a base and a deterministic ×3 buffered value, shown as uncertain.
- **Agents:** consultations, implementation attempts and reviews are real runs on configurable runners and models. Their persisted results return through a durable inbox into the coordinator's thread and leave it only once the coordinator answered. Agent output can never be quoted as the author's decision.
- **Results:** declared screenshots and files are verified and copied with a hash; preview links must be local and are only probed or linked. Anything else is recorded as rejected with the reason.
- **Cockpit:** new Readiness, Documents, and Agents and results views; estimates on items and Sprints; coordinator and agent settings under Product settings.

Unchanged: business approval by the human, no automatic Done, retry only on the author's explicit chat instruction, durable forwarding to active runs, dependencies, the revision guard.

Code: `packages/contract/src/scrum.ts`, `packages/cezar/src/scrum/` (`coordinator-state.ts`, `documents.ts`, `context.ts`, `artifacts.ts`, `work.ts` are new), `packages/cezar/src/server/scrum.ts`, `server.ts`, `packages/web/src/routes/scrum/`, `packages/web/src/api/scrum.ts`.

The first entry above records the blocker this commit left (OC-1) and its resolution.

### Verification

Test suites remain paused at the user's request: `npm test`, `npm run test:unit`, `npm run test:package` and `npm run test:e2e` were NOT run, and no tests were added or updated. The existing `scrum.test.tsx` is stale (it clicks the removed "Add PBI" button and mocks only part of `@/api/scrum`). Contract-parity and route-inventory tests were not run against the new routes.

| Check | Result |
|---|---|
| `npm run typecheck` (contract, client, server, web, release) | PASS |
| `npm run build`, including `check:pack` | PASS — 1151 files, 176 under web/dist |
| Throwaway script on synthetic data with a fake run store (not committed) | 54/54 as expected: gate refusals and passage, code fences inside a document, version-exact approval, exact ×3, Sprint planning inside and outside constraints, one queued run, artifact verification (real image accepted; fake image, traversal, symlink, missing file, `file:`, remote URL refused), one report per result, one automatic review, consultation cap, inbox held, handed over, kept when the session dies, resent after the author spoke, removed once answered, agent text refused as the author's quote, changed baseline blocks an item, server-owned fields kept, legacy state unaffected |
| Built server, sandbox `HOME`/`CEZ_HOME`, temporary repository, `CEZ_DRY_RUN=1` (mock agents through the real RunManager) | Boot sweep queued a ready item; the attempt's result was captured from its transcript into `RESULT-1`; finishing that run started one `REVIEW-1` run in its own worktree; the results waited in the inbox; config save, stale revision 409, foreign model 400, document and artifact 404, Scrum page 200 |
| Built server, sandbox `HOME`/`CEZ_HOME`, no dry-run | The installed OpenCode 2.2.5 is reported in `GET /scrum/coordinator` and `POST /scrum/chat/messages` answers 409 with the reason; no run is started |

Not exercised: **any real coordinator conversation on OpenCode**, because the host's version is unsupported, so the instructions' effect on a real model, reading the memory files, and emitting operations are unverified; real consultation and review agents returning a structured block; delivery of the inbox into a live OpenCode session and through Continue; the cockpit's new views in a browser; artifact serving and the preview probe against real files and servers; restart recovery with open work.

## 2026-10-30 — durable delivery of forwarded Scrum changes (SCRUM-CHAT-01 POL-1, technical correction)

Fixes the delivery gaps the POL-1 implementation documented; the approved policies (forward to active agents, ask before retrying, active Sprint by default) and the run retry policy are unchanged.

- An accepted change is written to a durable outbox (`chat.forwards` in `scrum/state.json`) in the same save as the chat turn, before any delivery; a separate pass delivers it after the save, at boot and when the target run moves, so a restart resumes it.
- Delivery uses only the engine's durable rungs: the live session (transcript row) or the still-queued run's prompt, checked against the same `queuedStackRefusal` bounds as the run message route. The in-memory start-up buffer and Continue are no longer used for forwards. A message over the 100 000-character one-message limit is refused and reported, never shortened.
- Outcomes are separated: `forward-pending` (recorded or queued, NOT received), `forwarded` (change id confirmed in the run's transcript or the prompt the run started with), `forward-failed` (run ended or gone, too long, outbox full). A run with no open session, a provider refusal or an unanswered question of its own holds the change instead of failing it.
- The replay guard checks the transcript and queued prompt before every hand-over, so reconciliation after a crash does not deliver twice. Exact-once is not claimed; the remaining windows are listed in [scrum-chat.md § Forwarding semantics](scrum-chat.md#forwarding-semantics-pol-1-delivery).

Code: `packages/cezar/src/scrum/forward.ts` (new), `packages/cezar/src/server/scrum.ts`, `packages/cezar/src/scrum/chat.ts` (assistant instructions), `packages/contract/src/scrum.ts`, `packages/web/src/routes/scrum/scrum-chat.tsx` (labels).

### Verification

Test suites remain paused at the user's request: `npm test`, `npm run test:unit`, `npm run test:package` and `npm run test:e2e` were NOT run, and no tests were added or updated. No live model run.

| Check | Result |
|---|---|
| `npm run typecheck` (contract, client, server, web, release) | PASS |
| `npm run build`, including `check:pack` | PASS — 1135 files, 175 under web/dist |
| Throwaway script on synthetic data driving `planForwards`/`deliverForwards` with a fake run store and manager in a temporary dir (not committed) | 12/12 as expected: recorded `pending` without any send; a replayed turn not recorded twice; no open session holds it and sends nothing; an unchanged hold writes nothing; an open session delivers it once; a pass replayed on the pre-delivery state (crash before save) records `forwarded` without resending; a queued run stacks it and still reports NOT received; once that run starts it is `forwarded`; a run that ended first gives `forward-failed`; a run waiting for an answer holds it; an over-limit message is refused, not recorded or shortened; a state with an outbox entry passes the contract schema |

Not exercised: delivery against the real RunManager (live session, queued prompt, dequeue fold), the run/event listeners inside a running server, a real restart with a pending entry, and the cockpit rendering of the new notice.

## 2026-10-30 — Scrum chat follow-up policies (SCRUM-CHAT-01 POL-1, POL-2, POL-4)

Implements the user's answers to the open questions Q1, Q2 and Q4 of [scrum-chat.md](scrum-chat.md):

- **Changing a task with an active run** (POL-1): the chat may change an item whose run is queued, running or waiting; cezar forwards the updated item to that run through the engine's existing message ladder (live, queued prompt, start-up buffer, Continue) behind the run's provider gate, never cancels or restarts it, and logs the real outcome per run (`forwarded` / `forward-failed`). A change id in the message prevents a second delivery when a reconcile is replayed. Approval withdrawal on changed requirements stays as before.
- **Retries** (POL-2): a failed automatic attempt is reported once in the conversation and never retried by itself. A new chat operation `retryItem`, accepted only for a user instruction given after the last attempt, allows exactly one further attempt through the automatic queue.
- **Sprint** (POL-4): a chat item that becomes READY with no Sprint named is planned into the single active Sprint; with none, cezar asks in the chat and creates nothing. Explicit Sprint choices are respected.
- The conversation now shows cezar's own notices (role `system`) for these outcomes; the item panel shows a pending retry.

Code: `packages/cezar/src/scrum/policy.ts` (new), `chat.ts`, `autoqueue.ts`, `prompt.ts`, `validate.ts`, `packages/cezar/src/server/scrum.ts`, `packages/contract/src/scrum.ts`, `packages/web/src/routes/scrum/`. `ScrumServices.threadBlocked` is renamed `runBlocked`, since it now also gates item runs.

### Verification

Test suites remain paused at the user's request: `npm test`, `npm run test:unit`, `npm run test:package` and `npm run test:e2e` were NOT run, and no tests were added or updated. The stale `packages/web/src/routes/scrum/scrum.test.tsx` (it clicks the removed "Add PBI" button) is still expected to fail.

| Check | Result |
|---|---|
| `npm run typecheck` (contract, client, server, web, release) | PASS |
| `npm run build`, including `check:pack` | PASS — 1132 files, 175 under web/dist |
| Throwaway script on synthetic data, pure functions with a fake run store (not committed) | 15/15 as expected: auto-plan into the active Sprint; explicit plan op tracked; no active Sprint gives a question and creates nothing; one automatic run; busy item editable with approval withdrawn and forwarding tracked; change message carries the change id and approval state but not the PBI marker; failure reported once; no automatic retry; retry quoting an older message refused; later explicit retry starts exactly one run and is consumed; server-owned fields survive a client save |
| Throwaway script driving `reconcileScrumChat` with a fake store and RunManager in a temporary data dir (not committed) | 7/7 as expected: busy item updated; change delivered into the live session once; `forwarded` logged with the rung; replay after a reset cursor does not deliver again; a closed session logs `forward-failed` "NOT sent"; a provider gate refusal logs `forward-failed` and sends nothing; a failed automatic run logs `run-failed` |

Not exercised: a live Codex conversation (the assistant actually asking about a retry or a Sprint, and emitting `retryItem`), delivery into a real Claude/Codex session, the queued-prompt and start-up-buffer rungs against the real RunManager, the run-status listener inside a running server, and the cockpit rendering of the new notices. These need a sandboxed cezar with a provider login, which this increment did not use.

## 2026-10-30 — conversational Scrum and automatic queue (SCRUM-CHAT-01)

The Add PBI form is replaced by an embedded "Scrum assistant" chat bound to one persistent, project-scoped Codex thread (a real cezar run resumed through Continue). The assistant records problems, work, acceptance criteria, Sprints and guidelines as backlog operations that cite the user's words; cezar applies them under the Scrum lock, keeps provenance and a change log, and queues every chat-made item that becomes executable through the existing launcher and `maxParallel` queue. Done is never set automatically. Design, CHANGE REQUEST/DoR assessment and open questions: [scrum-chat.md](scrum-chat.md).

### Verification

Test suites remain paused at the user's request: `npm test`, `npm run test:unit`, `npm run test:package` and `npm run test:e2e` were NOT run, and no tests were added or updated. The existing `packages/web/src/routes/scrum/scrum.test.tsx` still clicks "Add PBI", which no longer exists, so it is expected to fail until it is updated.

| Check | Result |
|---|---|
| `npm run typecheck` (contract, client, server, web, release) | PASS |
| `npm run build`, including `check:pack` | PASS — 1129 files, 175 under web/dist |
| Throwaway script on synthetic data (not committed): op parsing across split text events, quote refusal, readiness after chat ops, server-owned field protection | as expected |

Not exercised: a live Codex conversation, thread resumption after idle close, and automatic queueing against a running server. These need a sandboxed cezar with a Codex login, which this increment did not use.

## 2026-10-30 — native Scrum module in the cockpit (SCRUM-LOCAL-01)

Added a project-local Scrum page to the cockpit (`/p/:projectId/scrum`, "Scrum" in the navigation) backed by a native API: `GET/PUT /api/v1/scrum` and `POST /api/v1/scrum/items/:id/launch`, also under `/api/v1/p/:projectId`. Contract: `packages/contract/src/scrum.ts`. Service: `packages/cezar/src/scrum/` (validation, locked atomic store, prompt) and `packages/cezar/src/server/scrum.ts`. UI: `packages/web/src/routes/scrum/`, `packages/web/src/api/scrum.ts`. Data stays private in `.ai/cezar/scrum/state.json`. Scope and limitations: [scrum-integration.md](scrum-integration.md). The cockpit's Scrum text is English.

Launches reuse the existing engine (`quick-task`, the provider gate, `RunManager.startRun`): implementation in an isolated worktree, refinement read-only. Screenshots of the real page on synthetic data replaced the earlier prototype images: [screenshots](screenshots/README.md).

### Verification

The user asked to stop running test suites for this increment. `npm test`, `npm run test:unit`, `npm run test:package`, `npm run test:e2e` were NOT run after the Scrum code was added, and no new automated Scrum tests were written; the existing `scrum.test.tsx` and `nav-items.test.ts` were updated to the English text but not re-run.

| Check | Result |
|---|---|
| `npm run typecheck` (contract, client, server, web, release) | PASS |
| `npm run build`, including `check:pack` | PASS — 1122 files, 174 under web/dist |
| Manual API scenarios against the built server (sandbox `CEZ_HOME`, `CEZ_DRY_RUN=1`, synthetic data) | 23 of 24 PASS at first run; the one FAIL was the check reading a still-queued run, re-checked a few seconds later: the implementation run had worktree branch `cez/<id8>` and the refinement run `readOnly: true` without a worktree |

Scenarios covered manually: empty state, save, stale revision 409, dangling dependency, dependency cycle, duplicate id, two active Sprints, Sprint over one month, invalid calendar date, Done without evidence, client-edited `runIds`, unknown field, implementation of a not-ready PBI 409, unknown PBI 404, two concurrent launches of one PBI (one 200, one 409), run linked to the PBI, implementation of a ready PBI, duplicate launch while the run is active 409, second project with independent state, corrupt file 503 on GET and PUT with the file left byte-identical, state surviving a server restart. Not covered: a refused agent start (the provider gate cannot refuse under `CEZ_DRY_RUN=1`); the code path writes nothing when the callback throws.

## 2026-10-30 — własne README i aktualne screeny

Zastąpiono skopiowaną stronę główną upstreamu opisem skorowidny-cezar: zakresem gotowych dodatków, ich statusem, uruchamianiem z checkoutu forka i planem niezależnego rozwoju UI. Usunięto z głównego README oryginalne materiały promocyjne, nagranie, odznaki npm i odziedziczoną galerię screenów. Pochodzenie projektu i odnośnik do bazowej dokumentacji pozostają jawne.

Dodano trzy własne screeny: rzeczywisty cockpit z izolowanej sesji dry-run oraz widoki dokumentacyjne rzeczywistych wyników backendu i porównania upstreamu. Podpisy rozróżniają istniejące UI od przykładów, które nie są jeszcze ekranami aplikacji. Obok obrazów zapisano źródłowe JSON-y i opis ich pochodzenia. Nie użyto danych ani sesji użytkownika.

Ta aktualizacja dotyczy dokumentacji i obrazów; nie zmienia kodu aplikacji, domyślnego brandingu ani działającej usługi. Samodzielne uruchomienie repozytorium nadal pokazuje odziedziczony cockpit, a nazwę jak na screenie można ustawić funkcją brandingu profilu.

## 2026-10-30 — fundament publicznego forka

Baza: `open-mercato/cezar`, commit `eb157816aac7e0d4676c007e2f7d14b397588784`, wersja pakietu `0.17.0` na `main`.

Dodano dokumentację kierunku Scrum + AI, notatkę projektową, procedurę utrzymania upstreamu i narzędzie raportujące różnice. Przykłady backendu pokazują lokalne mechanizmy na danych syntetycznych. README odróżnia ten przyrost od gotowej aplikacji Scrum i od oryginalnej dystrybucji npm.

Core backendu, klienta API, kontraktów, UI i desktopu pozostaje bez zmian względem bazy. W tym przyroście nie wprowadzamy własnego updatera, nowej nazwy pakietu npm ani wdrożenia na serwerze. Przyszłe zmiany wyglądu oraz produkcyjny moduł backlogu będą osobnymi przyrostami.

### Weryfikacja

Weryfikacja lokalna: Linux, Node 24.21.0, Python 3.14.4. Claude przygotował przykłady backendu, Codex przejrzał kod i powtórzył testy; po przeglądzie dodano 11 testów regresji i poprawki.

| Sprawdzenie | Wynik |
|---|---|
| `npm ci` | PASS |
| `npm run typecheck` | PASS |
| Przykłady backendu, `unittest` | PASS — 54 testy |
| Narzędzie porównania upstreamu, `unittest` | PASS — 8 testów |
| Demo backendu | PASS — JSON obejmujący 12 kroków |
| `npm run test:unit` | PASS — 48 testów |
| `npm run build`, w tym `check:pack` | PASS — 1102 pliki w paczce, 167 plików web |
| `npm run test:package` | PASS — 33 testy |
| Pełny Vitest w odziedziczonym środowisku cockpit | FAIL — 12798 passed, 68 failed, 4 skipped; część błędów dotyczy `CEZ_AGENT_MODELS_LOCKED=1` |
| Pełny Vitest po usunięciu zmiennych sesji, `--maxWorkers=4` | TIMEOUT po 600 s; nie uznajemy tej próby za zakończony lub zielony suite |
| Osobne powtórzenie 4 plików UI, `--maxWorkers=1` | 76 passed, 2 failed — oczekiwanie na załadowanie diffu |

Pozostałe błędy w osobnym uruchomieniu dotyczą `packages/web/src/components/diff/line-comments.test.tsx` (przypadek bez komentarzy) i `packages/web/src/routes/task-git/task-commits.test.tsx` (kolumna diffu commita). W tej maszynie testy czekały na treść diffu zbyt krótko; pliki testów i kod UI są identyczne z bazą upstream. Nie rozstrzygamy tu, czy to problem czasu środowiska czy usterka upstreamu. Nie zmieniano testów ani core, aby ukryć wynik. Pełna walidacja upstreamu pozostaje niezielona.

Przykłady są samodzielną referencją, nie produkcyjnym backendem Scrum. SQLite jest testowane lokalnie, bez pracy wielohostowej; nie ma uprawnień, migracji ani heartbeat. Kontekst nie ma limitu rozmiaru/FTS i nie jest podpisany kryptograficznie. Kalkulator jawnie ujawnia precyzję 50 cyfr i utratę precyzji; nie deklaruje dowolnej dokładności.

GitHub Actions w forku są wyłączone. Własny workflow testów jest przygotowany, ale nie ogłaszamy zdalnego CI jako wykonanego. Przed jego włączeniem trzeba ograniczyć odziedziczone mechanizmy publikacji upstreamu.
