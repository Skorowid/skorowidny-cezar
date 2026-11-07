# Meshy AI integration (3D generation through MCP)

Status (2026-11-07): tooling, tests and documentation in this fork; server installed on the owner's machine; **not yet used with a real key** (none bought at the time of writing). No cezar runtime code changed.

## What it is, and what it is not

Meshy (<https://www.meshy.ai>) generates 3D models (text to 3D, image to 3D, retexture, remesh, rigging, animation, conversion, 3D printing helpers). It is **not** a language model and **cannot be a cezar runner**: runners (`claude`, `codex`, `opencode`, `cursor`, `pi`, `junie`, `copilot`) are coding agents that read the repo, call tools and edit files. Meshy's API takes a request, runs an asynchronous task and returns files.

So Meshy is attached the way cezar already supports for external services: as a **private MCP server** of a project (spec `.ai/specs/2026-10-07-private-project-mcp.md`, file `<repo>/.ai/cezar/mcp.local.json`). The agent of any run on that project then gets Meshy's tools, and decides when to call them.

We use Meshy's **official** MCP server, `@meshy-ai/meshy-mcp-server` (MIT, <https://github.com/meshy-dev/meshy-mcp-server>), at a pinned version. We do not maintain our own Meshy client.

## Pieces

| Piece | Location | Notes |
|---|---|---|
| Setup tool | `fork/tools/meshy_mcp.py` (+ `test_meshy_mcp.py`) | `install`, `set-key`, `register`, `unregister`, `check`, `run` |
| Pinned server | `~/.local/share/skorowidny-cezar/meshy-mcp/<version>/` | `npm install --omit=dev --ignore-scripts --save-exact`; version and npm integrity recorded in `launcher.json` |
| Launcher | `~/.local/share/skorowidny-cezar/meshy-mcp/meshy_mcp.py` | A copy of the setup tool made by `install`; cezar starts it with `python3 -I … run` |
| API key | `~/.config/meshy/meshy.env` | `MESHY_API_KEY=msy_…`, file `0600`, directory `0700`. One key for every project |
| Per-project entry | `<repo>/.ai/cezar/mcp.local.json` | `0600`, git-ignored by cezar, **contains no key** |

### Why a launcher instead of `npx -y` and a key in `mcp.local.json`

Meshy's own instructions use `npx -y @meshy-ai/meshy-mcp-server` with the key in the client config. We deliberately deviate:

1. **Pinned code.** `npx -y` fetches whatever version is newest on each run start. The launcher runs the reviewed, installed version; an upgrade is an explicit `install --version X`.
2. **No key in project files.** `mcp.local.json` is readable by the agent of every run in that project; the key would also be copied into each project that uses Meshy. The launcher reads one `0600` file instead.
3. **The key cannot be redirected.** The server calls `dotenv.config()` in its working directory, which is the run's worktree, and honours `MESHY_API_HOST`. A `.env` in a repository could otherwise point the key at another host. The launcher sets `MESHY_API_KEY`, `MESHY_API_HOST=https://api.meshy.ai` and `TRANSPORT=stdio` itself (dotenv never overrides set variables) and drops `PORT`.
4. **Nothing in argv.** The key is never a command-line argument (argv is world-readable through `ps`). `set-key` prompts with hidden input or reads stdin.

## Setup

Prerequisites: a paid Meshy plan (API keys need one; see "Plans and credits"), `node` ≥ 18 and `npm` on PATH, Python 3.

```bash
T=~/ai-projects/skorowidny-cezar/fork/tools/meshy_mcp.py
L=~/.local/share/skorowidny-cezar/meshy-mcp/meshy_mcp.py

python3 -I $T install                 # done on 2026-11-07: @meshy-ai/meshy-mcp-server@0.6.9
python3 -I $L set-key                 # paste the key at the hidden prompt
python3 -I $L check --balance         # install, key file, MCP handshake, credits (free call)
python3 -I $L register --project ~/ai-projects/<project>
python3 -I $L check --project ~/ai-projects/<project>
```

`register` merges one entry and keeps every other server in the file. It refuses a broken JSON file and leaves it as it is:

```json
{
  "mcpServers": {
    "meshy": { "type": "stdio", "command": "/usr/bin/python3",
               "args": ["-I", "/home/<user>/.local/share/skorowidny-cezar/meshy-mcp/meshy_mcp.py", "run"] }
  }
}
```

The file can also be edited in the cockpit (Settings → agent config, entry `cezar.private.mcp`). cezar re-reads it at every launch, Continue and resume, so **no service restart is needed**. Each run that attaches it shows the note `private MCP servers from .ai/cezar/mcp.local.json: meshy`.

To remove it from a project: `python3 -I $L unregister --project <repo>`. To revoke access everywhere: revoke the key on Meshy's API Keys page and delete `~/.config/meshy/meshy.env`.

### Where the files go

By default the server saves downloads under `meshy_output/` in its working directory, which is **the run's worktree**. The models then appear in the task's diff and reach the branch only through cezar's normal review gate. Alternatives:

- ask the agent to pass `save_to` (an absolute path) to `meshy_download_model`, for example into the project's assets folder;
- register with `--output-dir /absolute/dir` so the server works in a fixed directory outside the worktree.

Which one a project uses is the project's decision; none is set by default. Meshy deletes generated files from its servers after **3 days** (all plans except Enterprise), so download what you need.

## Runner support

Verified on 2026-11-07 with the installed 0.6.9 launcher and a deliberately invalid key, through each runner's own cezar injection channel:

| Runner | Channel used by cezar | Result |
|---|---|---|
| `claude` (Claude Code) | `--mcp-config` + `--allowedTools mcp__meshy`, `--permission-mode dontAsk` | the agent called `meshy_check_balance`; Meshy answered 401 for the invalid key, so the request went all the way to the API |
| `opencode` 2.2.5 | `OPENCODE_CONFIG_CONTENT` on `opencode serve` | `GET /api/mcp`: `meshy` `connected` (OpenCode 2.x migrates the 1.x `mcp` entry to `mcp.servers` itself). `opencode mcp list` does not show inline config, so it is not a valid check |
| `codex` | `mcp_servers.meshy` config override | listed as `enabled` |
| `junie`, `copilot` | ACP `mcpServers` (stdio) | not verified (CLIs not installed); stdio is mandatory for ACP agents |
| `cursor`, `pi` | none | cannot attach; the run gets a note |

MCP handshake without credits: 28 tools (`check` lists them). See the upstream server's README for the tool list.

## Costs and safety

- **Every tool call that creates a task costs credits** at the REST API's price (e.g. text to 3D preview 20 with Meshy 7.1 or 5 with Meshy 6 Lite, refine 10, image to 3D 30 textured, rigging 5; Meshy's pricing page is authoritative). Failed tasks are refunded automatically. `meshy_check_balance`, `meshy_list_animations` and `meshy_analyze_printability` are free.
- **cezar allows all of the server's tools** in a headless Claude run (`mcp__meshy`), because `dontAsk` would deny them otherwise. That includes `meshy_cancel_task`, which deletes a task. There is no per-call confirmation inside a run.
- **The brake is on Meshy's side:** set a **monthly credit limit on the API key** when you create it (Developer Platform → API Keys → Monthly credit limit). It caps what that key can spend whatever the agents do. An IP allowlist on the key further limits a leaked key. This is RECOMMENDED before registering the server in any project.
- **Residual risk:** the key file is readable by the user account that runs cezar, therefore by any agent run with shell access. That is inherent to giving agents the tool. The key's credit limit bounds the damage; revoke the key if it leaks.
- **Concurrency:** Meshy limits concurrent tasks per plan (Pro 10, Premium 30, Studio 60, Ultra 100) and 20 requests per second; parallel cezar tasks share these limits.
- **Server instructions** of the official server tell the agent to present a plan and confirm before executing. This is a prompt, not an enforcement.

## Plans and credits

From Meshy's documentation (2026-11-07): API keys need a **paid plan**; on the Free plan only the Playground works. The shared test-mode key that once returned sample results without credits was **retired on 2026-09-16** and now answers 401, so there is no credit-free end-to-end test; the cheapest real check is `check --balance` (free) followed by one Meshy 6 Lite preview (5 credits).

## Upgrading the server

```bash
python3 -I ~/ai-projects/skorowidny-cezar/fork/tools/meshy_mcp.py install --version <new>
python3 -I ~/.local/share/skorowidny-cezar/meshy-mcp/meshy_mcp.py check
```

Read the server's CHANGELOG first: 0.6.3 changed `list_tasks` and `list_models` defaults, and `lowpoly` was retired on 2026-10-30. Older version directories stay in place; deleting them is safe once `check` passes. Going back is the same `install` with the old version.

## Open decisions (owner)

| # | Question | Impact |
|---|---|---|
| M-1 | Which projects get the server registered | Nothing is registered by this change |
| M-2 | Monthly credit limit on the key | The only hard spending brake |
| M-3 | Where models are saved: worktree (`meshy_output/`), `save_to` per request, or `--output-dir` | Whether models reach branches through review |
| M-4 | Default formats (`glb`, `fbx`, `obj`, `usdz`, `stl`) and `ai_model` per project | Cost and fitness for the engine; today chosen per request by the agent |
