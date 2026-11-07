"""Meshy AI as a private MCP server for cezar runs: install, key, register, check, run. Author: Skorowid.

The official server (`@meshy-ai/meshy-mcp-server`) is installed at a pinned version into
`~/.local/share/skorowidny-cezar/meshy-mcp/<version>/`, never fetched by `npx -y` at launch.
The API key lives in one `0600` file, `~/.config/meshy/meshy.env`, and never in a project's
`.ai/cezar/mcp.local.json`, in argv or in this tool's output. `run` is the stdio command that
cezar's private MCP mechanism starts for each run: it reads the key, pins the API host and the
transport so a `.env` in the run's worktree cannot redirect the key, and execs the server.
See docs/skorowidny-cezar/meshy-integration.md.
"""

import argparse
import getpass
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request

PACKAGE = "@meshy-ai/meshy-mcp-server"
DEFAULT_VERSION = "0.6.9"
API_HOST = "https://api.meshy.ai"
SERVER_NAME = "meshy"
KEY_NAME = "MESHY_API_KEY"
MCP_FILE = Path(".ai") / "cezar" / "mcp.local.json"


class SetupError(Exception):
    """A refusal the user can act on; printed without a traceback."""


def install_root(home):
    return Path(home) / ".local" / "share" / "skorowidny-cezar" / "meshy-mcp"


def key_path(home):
    return Path(home) / ".config" / "meshy" / "meshy.env"


def launcher_path(home):
    return install_root(home) / "meshy_mcp.py"


def manifest_path(home):
    return install_root(home) / "launcher.json"


def atomic_write(path, text, mode=0o600):
    """Write `text` to `path` through a same-directory temp file created with `mode`."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


# ---- key ---------------------------------------------------------------------------------------

def validate_key(key):
    key = key.strip()
    if not key.startswith("msy_") or len(key) < 12 or any(ch.isspace() for ch in key):
        raise SetupError("that does not look like a Meshy API key (expected msy_<characters>, no spaces)")
    return key


def write_key(home, key):
    path = key_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    atomic_write(path, f"{KEY_NAME}={validate_key(key)}\n")
    return path


def read_key(home):
    """Return the key from the key file. Refuses a file others can read or one owned by someone else."""
    path = key_path(home)
    try:
        info = path.stat()
    except FileNotFoundError:
        raise SetupError(f"no key file at {path}; run: meshy_mcp.py set-key") from None
    if info.st_uid != os.getuid():
        raise SetupError(f"{path} is not owned by the current user")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise SetupError(f"{path} is readable by others; run: chmod 600 {path}")
    for line in path.read_text(encoding="utf-8").splitlines():
        name, sep, value = line.strip().partition("=")
        if sep and name.strip() == KEY_NAME:
            return validate_key(value.strip().strip('"').strip("'"))
    raise SetupError(f"{path} has no {KEY_NAME}= line")


# ---- install -----------------------------------------------------------------------------------

def install(home, version, node, npm):
    root = install_root(home)
    target = root / version
    target.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [npm, "install", "--prefix", str(target), "--omit=dev", "--ignore-scripts", "--no-audit",
         "--no-fund", "--save-exact", f"{PACKAGE}@{version}"],
        check=True, timeout=600, stdout=sys.stderr,
    )
    package_dir = target / "node_modules" / "@meshy-ai" / "meshy-mcp-server"
    installed = json.loads((package_dir / "package.json").read_text(encoding="utf-8"))["version"]
    if installed != version:
        raise SetupError(f"npm installed {installed}, expected {version}")
    entry = package_dir / "dist" / "index.js"
    if not entry.is_file():
        raise SetupError(f"{entry} is missing")
    lock = json.loads((target / "package-lock.json").read_text(encoding="utf-8"))
    integrity = lock.get("packages", {}).get("node_modules/@meshy-ai/meshy-mcp-server", {}).get("integrity")
    manifest = {"package": PACKAGE, "version": version, "node": str(node), "entry": str(entry),
                "integrity": integrity}
    atomic_write(manifest_path(home), json.dumps(manifest, indent=2) + "\n", 0o644)
    shutil.copyfile(Path(__file__).resolve(), launcher_path(home))
    os.chmod(launcher_path(home), 0o755)
    return manifest


def read_manifest(home):
    try:
        return json.loads(manifest_path(home).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SetupError(f"Meshy MCP server is not installed; run: meshy_mcp.py install") from None


# ---- run ---------------------------------------------------------------------------------------

def launch_plan(home, environ, output_dir=None):
    """The argv, env and cwd `run` execs. Pure apart from reading the manifest and the key file."""
    manifest = read_manifest(home)
    env = dict(environ)
    env.update({KEY_NAME: read_key(home), "MESHY_API_HOST": API_HOST, "TRANSPORT": "stdio",
                "MESHY_CLIENT": "skorowidny-cezar"})
    env.pop("PORT", None)
    cwd = None
    if output_dir:
        cwd = Path(output_dir).expanduser()
        if not cwd.is_absolute():
            raise SetupError("--output-dir must be an absolute path")
    return [manifest["node"], manifest["entry"]], env, cwd


def run(home, output_dir):
    argv, env, cwd = launch_plan(home, os.environ, output_dir)
    if cwd is not None:
        cwd.mkdir(parents=True, exist_ok=True)
        os.chdir(cwd)
    os.execve(argv[0], argv, env)


# ---- register ----------------------------------------------------------------------------------

def load_mcp_file(path):
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {"mcpServers": {}}
    if not text.strip():
        return {"mcpServers": {}}
    try:
        data = json.loads(text)
    except json.JSONDecodeError as err:
        raise SetupError(f"{path} is not valid JSON ({err}); fix it first, nothing was changed") from None
    if not isinstance(data, dict) or not isinstance(data.get("mcpServers", {}), dict):
        raise SetupError(f"{path} must be an object with an \"mcpServers\" object; nothing was changed")
    data.setdefault("mcpServers", {})
    return data


def server_entry(home, python, output_dir=None):
    args = ["-I", str(launcher_path(home)), "run"]
    if output_dir:
        args += ["--output-dir", str(output_dir)]
    return {"type": "stdio", "command": str(python), "args": args}


def register(home, project, python, output_dir=None, name=SERVER_NAME):
    project = Path(project).resolve()
    if not (project / ".git").exists():
        raise SetupError(f"{project} is not the root of a git repository")
    if output_dir and not Path(output_dir).is_absolute():
        raise SetupError("--output-dir must be an absolute path")
    path = project / MCP_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    data = load_mcp_file(path)
    data["mcpServers"][name] = server_entry(home, python, output_dir)
    atomic_write(path, json.dumps(data, indent=2) + "\n")
    return path


def unregister(project, name=SERVER_NAME):
    path = Path(project).resolve() / MCP_FILE
    data = load_mcp_file(path)
    if name not in data["mcpServers"]:
        return False
    del data["mcpServers"][name]
    atomic_write(path, json.dumps(data, indent=2) + "\n")
    return True


def git_ignored(project, path):
    result = subprocess.run(["git", "-C", str(project), "check-ignore", "-q", "--", str(path)],
                            capture_output=True, timeout=30)
    return result.returncode == 0


# ---- check -------------------------------------------------------------------------------------

def mcp_handshake(home, timeout=60):
    """Start `run` like cezar does, list the tools over stdio and stop it. Uses no credits."""
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "skorowidny-cezar-check", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    with tempfile.TemporaryDirectory() as scratch:
        proc = subprocess.Popen([sys.executable, "-I", str(launcher_path(home)), "run"], cwd=scratch,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, env={**os.environ, "HOME": str(home)})
        watchdog = threading.Timer(timeout, proc.kill)
        watchdog.start()
        try:
            for message in requests:
                proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()
            tools = None
            while tools is None:
                line = proc.stdout.readline()
                if not line:
                    raise SetupError(f"the server exited during the handshake: {proc.stderr.read()[-400:]}")
                reply = json.loads(line)
                if reply.get("id") == 2:
                    tools = [tool["name"] for tool in reply["result"]["tools"]]
            return tools
        finally:
            watchdog.cancel()
            proc.kill()
            proc.wait(timeout=30)


def balance(key, timeout=30):
    """GET /openapi/v1/balance. Free per Meshy's docs; proves the key is accepted."""
    request = urllib.request.Request(f"{API_HOST}/openapi/v1/balance",
                                     headers={"Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as err:
        raise SetupError(f"Meshy refused the balance request: HTTP {err.code}") from None


def check(home, project=None, with_balance=False):
    lines = []
    manifest = read_manifest(home)
    lines.append(f"server: {manifest['package']}@{manifest['version']} ({manifest['entry']})")
    version = subprocess.run([manifest["node"], "--version"], capture_output=True, text=True,
                             timeout=30, check=True).stdout.strip()
    lines.append(f"node: {manifest['node']} {version}")
    key = read_key(home)
    lines.append(f"key file: {key_path(home)} (0600, key ends …{key[-4:]})")
    tools = mcp_handshake(home)
    lines.append(f"handshake: {len(tools)} tools ({', '.join(sorted(tools)[:4])}, …)")
    if project:
        path = Path(project).resolve() / MCP_FILE
        data = load_mcp_file(path)
        entry = data["mcpServers"].get(SERVER_NAME)
        lines.append(f"project: {path} — {'registered' if entry else 'NOT registered'}")
        if path.exists():
            mode = stat.S_IMODE(path.stat().st_mode)
            lines.append(f"project file mode: {mode:o}, git-ignored: {git_ignored(path.parents[2], path)}")
    if with_balance:
        lines.append(f"balance: {balance(key).get('balance')} credits")
    return lines


# ---- CLI ---------------------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("install", help="install the pinned server and this launcher")
    p.add_argument("--version", default=DEFAULT_VERSION)
    p.add_argument("--node", default=shutil.which("node"))
    p.add_argument("--npm", default=shutil.which("npm"))
    p = sub.add_parser("set-key", help="store the API key in ~/.config/meshy/meshy.env (0600)")
    p.add_argument("--stdin", action="store_true", help="read the key from stdin instead of a hidden prompt")
    p = sub.add_parser("register", help="add the server to a project's .ai/cezar/mcp.local.json")
    p.add_argument("--project", required=True)
    p.add_argument("--output-dir", help="absolute directory the server works in (default: the run's worktree)")
    p.add_argument("--python", default=shutil.which("python3") or sys.executable,
                   help="interpreter cezar starts; kept unresolved so a minor Python upgrade does not break it")
    p = sub.add_parser("unregister", help="remove the server from a project's mcp.local.json")
    p.add_argument("--project", required=True)
    p = sub.add_parser("check", help="verify install, key and handshake; --balance also calls Meshy (free)")
    p.add_argument("--project")
    p.add_argument("--balance", action="store_true")
    p = sub.add_parser("run", help="stdio entry point started by cezar for each run")
    p.add_argument("--output-dir")
    args = parser.parse_args(argv)
    home = Path.home()
    try:
        if args.command == "install":
            if not args.node or not args.npm:
                raise SetupError("node and npm must be on PATH, or pass --node and --npm")
            manifest = install(home, args.version, Path(args.node).resolve(), args.npm)
            print(f"installed {manifest['package']}@{manifest['version']}, launcher {launcher_path(home)}")
        elif args.command == "set-key":
            key = sys.stdin.readline() if args.stdin else getpass.getpass("Meshy API key: ")
            print(f"key stored in {write_key(home, key)}")
        elif args.command == "register":
            read_manifest(home)
            path = register(home, args.project, Path(args.python).absolute(), args.output_dir)
            ignored = git_ignored(Path(args.project).resolve(), path)
            print(f"registered '{SERVER_NAME}' in {path}")
            if not ignored:
                print(f"WARNING: git does not ignore {path}; start cezar once on this project "
                      "(it writes .ai/cezar/.gitignore) before committing anything", file=sys.stderr)
        elif args.command == "unregister":
            print("removed" if unregister(args.project) else "not registered; nothing changed")
        elif args.command == "check":
            for line in check(home, args.project, args.balance):
                print(line)
        elif args.command == "run":
            run(home, args.output_dir)
    except SetupError as err:
        print(f"meshy_mcp: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
