# Agent resource discipline

Author: Skorowid

Cezar runs many agents on one machine. They share CPU, memory and, above all, the disk with each other and with the cockpit. When one agent saturates the disk or takes most of the memory, every other task slows down and the cockpit stops responding. This page is the full set of rules; a condensed copy is part of every agent's system prompt (`## Resources (cezar)` in `packages/cezar/src/handoff.ts`).

## What cezar enforces on its own

| Mechanism | What it does | Opt-out |
|---|---|---|
| Host memory guard | When the host or cezar's own cgroup has less than `CEZ_HOST_MEMORY_GUARD_PCT` % (default 10) of memory available, cezar pauses the task with the largest process tree, including processes it detached, and stops that tree. The task resumes with Continue. | `CEZ_HOST_MEMORY_GUARD_PCT=0` |
| Process reaping | Cancel, finish, pause and worktree removal stop the whole process tree of the task, including processes that were detached and re-parented (found by `CEZ_TASK_ID` in their environment). | none |
| Build cache cleanup | When a task is done, cancelled or archived, git-ignored directories in its worktree that carry a valid `CACHEDIR.TAG` (for example a Rust `target/`) are deleted at idle I/O priority. A Continue before the cleanup fires keeps the build. | `CEZ_CLEAN_BUILD_ARTIFACTS=0` |
| Bounded transcripts | Images in agent events are written to `<runId>-images/` and only referenced; a single event is capped at 256 KB; history is read as a stream. A note appears in the task thread every 100 MB of transcript. | none |
| Per-task memory limit | Settings → per-task memory limit pauses a single task whose tree exceeds it. | unset by default |

These are the safety net, not the plan. An agent that hits them has already slowed every other task down.

## Rules for agents

### Processes
- Run builds and tests in the foreground with a time limit: `timeout 900 cargo test -p <crate>`.
- Never detach work that outlives the turn: no `&`, `nohup`, `setsid`, `bash -c '… > log &'`.
- If something must run in the background, record its pid and stop it by pid before the turn ends. Never `pkill -f` a generic pattern; it can match your own shell.
- Before ending a turn, check `ps -u "$USER" -o pid,etime,rss,args` for anything you started.
- A test or binary running far longer than usual is hung: stop it, do not wait.

### CPU and builds
- One heavy job per task at a time: build, full test suite, bundler, image or model generation. Do not run `cargo build`, `cargo clippy` and `cargo test` in parallel.
- Bounded parallelism: `-j` / `CARGO_BUILD_JOBS` at most half of the CPUs.
- Build only what you changed: `cargo check -p <crate>`, `cargo test -p <crate>`; the full workspace once at the end.
- Prefer the dev profile. Use release/LTO only when the task needs release behaviour or performance numbers.

### Memory
- Anything that can take more than a few GB (model inference, LTO links, large test suites) runs under a hard cap:
  `systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 <command>`.
  A soft limit (`MemoryHigh`) only throttles and swaps; it does not protect the host.
- Check `free -h` before a heavy job. Below about 20 % available, wait or ask.
- Never load large files whole. Read logs with `tail`, `grep` or offsets.
- If cezar paused the task for memory, do not restart the same heavy job unchanged: shrink it (fewer jobs, smaller scope, a cap) or ask.
- Image and model generation on CPU is a memory-heavy job: never run it next to other heavy jobs, and prefer a GPU host when one is configured.

### Disk
- Check `df -h .` before writing a lot (builds, downloads, datasets, models). Below about 10 % free, stop and ask.
- Every worktree has its own build directory, often several GB. Do not create extra clones or extra build directories.
- Keep scratch files in the task tmp dir (`$TMPDIR`) and delete large ones when done.
- Never run `du` or `find` across the home directory or other worktrees; scope searches to your worktree.

### Output and transcripts
- Keep tool output small. Never put images, base64 or multi-megabyte logs into the conversation: save them to a file and give the path.
- Screenshots only when the task is visual verification or the owner asked for them.
- Report at milestones and at the end with the evidence that matters, not step by step.

## For the operator

- Run cezar under a hard memory limit (`MemoryMax`) with `OOMPolicy=continue`, so the kernel kills one agent instead of the whole service, and keep the sum of hard limits below physical memory.
- Keep `maxParallel` proportionate to memory: a coding agent with a build commonly needs 2–8 GB.
- Set a per-task memory limit in Settings when tasks build large projects.
- A user-space OOM killer (`earlyoom` or `systemd-oomd`) is a useful second line of defence.
