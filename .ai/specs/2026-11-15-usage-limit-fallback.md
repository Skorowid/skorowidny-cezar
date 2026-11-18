# Usage-limit monitor, limit-low parking and default fallback

> Author: Skorowid. Status: implemented (skorowidny-cezar fork). Extends
> `2026-10-20-agent-usage-limit-fallback.md` and `2026-08-03-auto-resume-after-usage-limit.md`;
> does not replace either.

## Owner requirement (2026-11-15)

> „Jak skończy się limit na jakimś procesie i cezar to wykryje, to sam ma przełączyć na agenta, który
> nie ma limitu. Cezar ma mieć funkcję monitorowania limitu i przy 10% informować o kończącym się
> limicie wszystkie zadania korzystające z danego dostawcy i agenta; przy 10% mają zapisać swoją
> pracę. Następnie główny builder/nadzorca ma sprawdzić, kiedy jest reset (godzinowy) i tak
> zorganizować pracę, aby zminimalizować zużycie (…), reszta zapisuje i wypycha zmiany aż do czasu
> resetu, a potem (…) powoli stopniowo wracają uruchomione procesy.”

The owner was absent and delegated decisions; those marked **executor decision under delegation**
below were made by the implementing task and are open to the owner's revision.

## 1. Monitor

`workspace/usage-limit-monitor.ts` — one process-wide `UsageLimitMonitor`, keyed by the queue's
account key `provider:profileId`.

- **Input, no new requests.** Every Claude/Codex step's `onUsageWindows` callback (built in
  `RunManager.agentEnvForStep`) feeds it, for Codex now also without a bound identity (the
  attributed `usage-windows.json` store keeps its old rule). A usage-exhaustion failure
  (`scheduleAutoResumeIfLimited`) marks the failed step's account exhausted with the parsed reset.
- **Summary.** The tightest window that covers every model (`applicability: 'all'`) and has not
  reset; `blocked` counts as 100 % used. Model-specific buckets never speak for the account.
- **States.** `ok` / `low` (remaining ≤ `CEZ_LIMIT_LOW_PCT`, default 10) / `exhausted`. A state
  clears at its reset (timer → `tick`) or when a fresh observation is above the threshold.
- **Persistence.** `cezarHomeDir()/usage-limits.json`, salvaged per row, written on transitions only
  (a chatty stream is not I/O). Deleting it loses nothing that the next stream event cannot rebuild.
- **API.** `GET /api/v1/workspace/usage-limits` → `usageLimitsResponseSchema`
  (`packages/contract/src/usage-windows.ts`). *Executor decision under delegation:* workspace-level
  route under `/workspace/` instead of a bare `/api/v1/limits`, to follow the surface rules; no
  cockpit widget beyond the queue label (below) in this increment.

## 2. LIMIT-LOW warning

On the first `low` (or `exhausted`) transition of a window — one per window, reset jitter < 2 min
ignored — every manager sends, through the ordinary live-session delivery
(`deliverMessage`, else `enqueueMessage`):

- to every live task on the account: `LIMIT-LOW <account>: ~N% … resets at HH:MM UTC` and either
  "save your work now: commit, push your branch, update the handoff, end your turn" or, for the kept
  tasks, "finish the most important work first, save often";
- to tree roots and supervisors (dispatch parents), whether on the account or above a task that is:
  additionally the list of their descendants on that account and the instruction to dispatch nothing
  new on it before the reset.

Each delivery leaves a `LIMIT-LOW … warning sent — <role>` note in the task's thread.
*Executor decision:* the session message is the channel; no extra inbox file is written (the inbox
is for task-to-task mail, and a delivered message already wakes a parked root).

## 3. Parking until the reset

While an account is low **with a known reset**, `pump()` admits only the kept tasks on it:

- **Kept set** = the `CEZ_LIMIT_KEEP` (default 2) most important tasks on the account — tree roots,
  then supervisors, then the rest, oldest first — frozen per window. A window that went low with
  fewer tasks around fills up to K as tasks arrive; a kept task that finishes frees no slot
  (*executor decision*: otherwise parked work drains the rest of the allowance one task at a time).
- Every other queued start or continuation waits with `queueWaitReason: {kind: 'limit-low', resetsAt}`
  (cockpit label "Parked while this account's usage is low · resets HH:MM UTC"). A usage-limit hold's
  own reason wins over it.
- A low state without a known reset is advisory only (warned, never parks): nothing could lift it.
- The queue watchdog treats a pending reset as a reason to sit still.
- *Executor decision:* the kept set is per project manager (each project ranks its own tasks).
  Live sessions are not interrupted; they were told to save and stop. Monitoring wake-ups of
  parked sessions are not suppressed in this increment.

## 4. Default fallback on exhaustion

`effectiveAgentFallbackPolicySync` (`workspace/agent-fallback.ts`): when the project never saved a
policy (revision 0, disabled) and `CEZ_LIMIT_FALLBACK` is not `0`, the engine uses an **implicit
policy** — Claude default, Codex default, then named Claude/Codex accounts (re-derived at admission).
Everything else is the 2026-10-20 mechanism: same task, branch, worktree, handoff prompt; one
handover line with source and target; skipped candidates noted; holds for the exhausted account.

- Tasks created before this change take the implicit policy at their first exhaustion.
- The implicit snapshot carries the fixed incarnation/revocation `implicit-default`. Saving any
  policy in Settings (on or off) withdraws it from tasks that captured it.
- **No candidate left** under the implicit policy: the task fails as before, the episode is cleared
  and the reset-time auto-resume is armed ("no other agent has usage left — waiting for this
  account's reset"), so it "waits for the reset as today" and may hand over again next time. An
  explicit policy keeps its documented manual stop.
- The settings API still returns the saved policy only; the implicit default is visible as
  `fallback: true` in the usage-limits response. AGENTS.md records the owner-approved exception.
- The vitest setup pins `CEZ_LIMIT_FALLBACK=0`: the dry run does not mock Codex, so a `mock:limit`
  in any suite would otherwise start a real, paid CLI. The feature's own tests enable it with the
  Codex app-server fixture.

## 5. Ramp after the reset

On `cleared`, an account with parked tasks enters a ramp: one queued task per `CEZ_LIMIT_RAMP_SEC`
(default 120 s), parked important tasks first, the ones that parked last before the rest
(`rampOrder`); new tasks on that account queue behind them until the ramp drains. A renewed `low`
ends the ramp and parks again. Ramp state is in memory; after a restart the queue simply resumes.

## Environment

`CEZ_LIMIT_LOW_PCT` (0–100, default 10), `CEZ_LIMIT_KEEP` (0–100, default 2), `CEZ_LIMIT_RAMP_SEC`
(0–3600, default 120), `CEZ_LIMIT_FALLBACK=0`. Read on every use; an invalid value keeps the
default. Documented in `.env.example` and `docs/reference.md`.

## Verification

- `workspace/usage-limit-monitor.test.ts` — Claude/Codex fixtures, thresholds, once-per-window,
  reset/clear, exhaustion, persistence and salvage, config parsing.
- `workflows/limit-guard.test.ts` — roles, ranking, message texts, ramp order.
- `workspace/agent-fallback-implicit.test.ts` — implicit policy, opt-out, saved policy wins.
- `workflows/usage-limit-guard-run.test.ts` — real engine (dry run): default Claude→Codex handover,
  wait-for-reset with no candidate, LIMIT-LOW delivery, parking with K=1 and the 1 s ramp.
- `server/usage-limits-api.test.ts`, `contract-parity.workspace.test.ts`, BC inventory.
