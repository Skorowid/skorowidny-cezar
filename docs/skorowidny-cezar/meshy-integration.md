# Meshy AI integration (3D generation through MCP)

Status (2026-11-07): tooling, tests and documentation in this fork, audited by Codex (findings fixed, see changes.md); server installed on the owner's machine; **not yet used with a real key** (none bought at the time of writing). No cezar runtime code changed.

## What it is, and what it is not

Meshy (<https://www.meshy.ai>) generates 3D models (text to 3D, image to 3D, retexture, remesh, rigging, animation, conversion, 3D printing helpers). It is **not** a language model and **cannot be a cezar runner**: runners (`claude`, `codex`, `opencode`, `cursor`, `pi`, `junie`, `copilot`) are coding agents that read the repo, call tools and edit files. Meshy's API takes a request, runs an asynchronous task and returns files.

So Meshy is attached the way cezar already supports for external services: as a **private MCP server** of a project (spec `.ai/specs/2026-10-07-private-project-mcp.md`, file `<repo>/.ai/cezar/mcp.local.json`). The agent of any run on that project then gets Meshy's tools, and decides when to call them.

We use Meshy's **official** MCP server, `@meshy-ai/meshy-mcp-server` (MIT, <https://github.com/meshy-dev/meshy-mcp-server>), at a pinned version. We do not maintain our own Meshy client.

## Pieces

| Piece | Location | Notes |
|---|---|---|
| Setup tool | `fork/tools/meshy_mcp.py` (+ `test_meshy_mcp.py`) | `install`, `set-key`, `register`, `unregister`, `check`, `run` |
| Reviewed lockfile | `fork/tools/meshy-mcp/package.json`, `package-lock.json` | Pins the server and all 144 transitive packages, each with an integrity hash |
| Pinned server | `~/.local/share/skorowidny-cezar/meshy-mcp/<version>-<random>/` | A fresh directory per `install`; `npm ci --omit=dev --ignore-scripts` from that lockfile; npm verifies every hash at install time |
| Launcher | `~/.local/share/skorowidny-cezar/meshy-mcp/meshy_mcp.py` | A copy of the setup tool made by `install`; cezar starts it with `python3 -I … run` |
| Server working dir | `~/.local/share/skorowidny-cezar/meshy-mcp/work/` | `0700`, outside every repository; default save location (`meshy_output/`) |
| API key | `~/.config/meshy/meshy.env` | `MESHY_API_KEY=msy_…`, file `0600`, directory `0700`. One key for every project |
| Per-project entry | `<repo>/.ai/cezar/mcp.local.json` | `0600`, git-ignored by cezar, **contains no key** |

### Why a launcher instead of `npx -y` and a key in `mcp.local.json`

Meshy's own instructions use `npx -y @meshy-ai/meshy-mcp-server` with the key in the client config. We deliberately deviate:

1. **Pinned code.** `npx -y` fetches whatever version is newest on each run start. The launcher runs the version installed from the reviewed lockfile; an upgrade is a reviewed lockfile change (see "Upgrading the server"). The hashes are checked when `npm ci` installs, not on every launch: the installed tree is trusted as much as the rest of the user's home.
2. **No key in project files.** `mcp.local.json` is readable by the agent of every run in that project; the key would also be copied into each project that uses Meshy. The launcher reads one `0600` file instead.
3. **A repository cannot redirect the key.** The server calls `dotenv.config()`, which loads `.env` from its working directory, and honours `MESHY_API_HOST`. Started in the run's worktree, a repository `.env` could set `https_proxy` and `NODE_TLS_REJECT_UNAUTHORIZED=0` and read the key through a forged certificate (found by the Codex audit). So the launcher:
   - always starts the server in its own `work/` directory (`0700`, owned by the user, not a symlink; re-checked at every launch), never the worktree or another directory a repository could write to, and refuses to start if a `.env` is there. An earlier `--output-dir` option was removed for this reason (second Codex audit): a `.env` created in such a directory after the check would still be loaded;
   - sets `MESHY_API_KEY`, `MESHY_API_HOST=https://api.meshy.ai` and `TRANSPORT=stdio` itself;
   - drops `PORT`, `NODE_TLS_REJECT_UNAUTHORIZED`, `DOTENV_KEY` and `DOTENV_CONFIG_*` from what it inherits.

   Proxy variables and CA settings inherited from the host are kept: they come from the user's environment, not from a repository. Verified live: a repository whose `.env` pointed a proxy and `MESHY_API_HOST` at a dead local port, with TLS checks off, still reached Meshy.
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

`register` merges one entry and keeps every other server in the file. It refuses a broken JSON file and leaves it as it is. The write goes through a `mcp.local.json.cez-tmp-*` temp file (the name cezar already git-ignores), and is refused when the file changed between read and write (for example a simultaneous cockpit edit) or, on first registration, when the file appeared meanwhile (atomic create-if-absent); run the command again in that case. For an existing file this narrows the window, it is not a lock shared with cezar: avoid editing the file in the cockpit while `register` runs. `check --project` validates the project's own entry and starts it the way a run does:

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

By default the server saves downloads under `meshy_output/` in its **private working directory** (`~/.local/share/skorowidny-cezar/meshy-mcp/work/meshy_output/`), not in the run's worktree. To put a model into a project:

- ask the agent to pass `save_to` (an absolute path) to `meshy_download_model`, e.g. into the worktree's assets folder; the model then appears in the task's diff and reaches the branch only through cezar's review gate;
- or copy it from `work/meshy_output/` afterwards.

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
- **Residual risk:** the key file is readable by the user account that runs cezar, therefore by any agent run with shell access. That is inherent to giving agents the tool. The key's credit limit bounds the damage; revoke the key if it leaks. The key and MCP files assume trusted parent directories (the user's own home); parent symlinks are not hardened against.
- **Concurrency:** Meshy limits concurrent tasks per plan (Pro 10, Premium 30, Studio 60, Ultra 100) and 20 requests per second; parallel cezar tasks share these limits.
- **Server instructions** of the official server tell the agent to present a plan and confirm before executing. This is a prompt, not an enforcement.

## Plans and credits

From Meshy's documentation (2026-11-07): API keys need a **paid plan**; on the Free plan only the Playground works. The shared test-mode key that once returned sample results without credits was **retired on 2026-09-16** and now answers 401, so there is no credit-free end-to-end test; the cheapest real check is `check --balance` (free) followed by one Meshy 6 Lite preview (5 credits).

## Upgrading the server

```bash
cd ~/ai-projects/skorowidny-cezar/fork/tools/meshy-mcp
npm install --package-lock-only --ignore-scripts --save-exact @meshy-ai/meshy-mcp-server@<new>
git diff package-lock.json            # review every changed package, then commit
python3 -I ../meshy_mcp.py install    # npm ci from the new lockfile
python3 -I ~/.local/share/skorowidny-cezar/meshy-mcp/meshy_mcp.py check
```

`install` runs only from the fork checkout (the installed launcher has no lockfile and says so). Each install goes into a new directory and the manifest `launcher.json` is switched last, so a failed or interrupted install leaves the previous installation untouched and in use.

Read the server's CHANGELOG first: 0.6.3 changed `list_tasks` and `list_models` defaults, and `lowpoly` was retired on 2026-10-30. Older installation directories stay in place; deleting one that `launcher.json` does not name is safe once `check` passes. Going back is `git checkout <old commit> -- fork/tools/meshy-mcp` and `install`.

## Open decisions (owner)

| # | Question | Impact |
|---|---|---|
| M-1 | Which projects get the server registered | Nothing is registered by this change |
| M-2 | Monthly credit limit on the key | The only hard spending brake |
| M-3 | Where models are saved: private `work/meshy_output/` (default) or `save_to` per request, e.g. a fixed assets path in the agent's instructions | Whether models reach branches through review |
| M-4 | Default formats (`glb`, `fbx`, `obj`, `usdz`, `stl`) and `ai_model` per project | Cost and fitness for the engine; today chosen per request by the agent |
