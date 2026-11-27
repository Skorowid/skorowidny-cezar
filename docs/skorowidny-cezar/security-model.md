# Security model of this cockpit

Owner's decisions, 2026-11-27 (issue #4). Author: Skorowid.

## What separates projects: nothing

Every project, task and agent runs as the same Linux user (`vix`), with the same home, the same `~/.cezar`, the same agent logins (`~/.claude`, `~/.codex`) and the same `gh` login. A worktree is a working copy, not a security boundary.

- Claude agents run with `Bash` allowed and without a sandbox in every project, so they can already read and change any repository, credential or service file the user can.
- Codex runs in its `workspace-write` sandbox with `auto_review`, except in the projects listed in `CEZ_CODEX_FULL_ACCESS_PROJECTS` (drop-in `~/.config/systemd/user/cezar.service.d/codex-full-access.conf`): `robocraftwars`, `skorowidny-cezar`, `pixelart-skorowid-games`, all owner-approved (the last one confirmed 2026-11-27). There Codex runs `danger-full-access` with approval `never`.
- The project `ai-projects` (`/home/vix/ai-projects`, the parent of every other project) stays registered on purpose: tasks must be able to use the other repositories. A task there works directly in that directory, so even sandboxed Codex can write to every project.

The practical risk is not another person but an agent misled by what it reads (a web page, an issue, a downloaded file): it can use the user's GitHub login or change another project or the cockpit itself.

## What real isolation would take

- A separate VM or a separate WSL distribution per group of projects, with its own cockpit, its own agent logins and a minimal `gh` token.
- A second Linux user in the same WSL distribution is NOT enough: WSL interop (on here; the cockpit uses PowerShell) lets any Linux process start Windows programs as the Windows user and read `/mnt/c`.
- Cheaper steps that reduce the damage: a fine-grained `gh` token limited to the repositories the tasks need, and the Claude Code sandbox for projects that do not need full access.

None of these is set up; the owner accepts the shared model for now.
