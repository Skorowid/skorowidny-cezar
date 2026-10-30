# skorowidny-cezar changes

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
