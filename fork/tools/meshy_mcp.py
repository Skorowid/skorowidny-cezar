"""Meshy AI as a private MCP server for cezar runs: install, key, register, check, run. Author: Skorowid.

The official server (`@meshy-ai/meshy-mcp-server`) is installed with `npm ci` from the reviewed
lockfile in `fork/tools/meshy-mcp/` into `~/.local/share/skorowidny-cezar/meshy-mcp/<version>/`,
never fetched by `npx -y` at launch. The API key lives in one `0600` file,
`~/.config/meshy/meshy.env`, and never in a project's `.ai/cezar/mcp.local.json`, in argv or in
this tool's output. `run` is the stdio command cezar starts for each run: it reads the key, pins
the API host and transport, and execs the server in a private working directory so the server's
`dotenv.config()` cannot load a repository `.env` (proxy or TLS settings could intercept the key).
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
API_HOST = "https://api.meshy.ai"
SERVER_NAME = "meshy"
KEY_NAME = "MESHY_API_KEY"
MCP_FILE = Path(".ai") / "cezar" / "mcp.local.json"
LOCK_DIR = Path(__file__).resolve().with_name("meshy-mcp")
# Inherited variables the server must not see: they could disable TLS checks or make dotenv load
# another file. Proxy variables stay: they come from the host, not from a repository.
DROPPED_ENV = ("PORT", "NODE_TLS_REJECT_UNAUTHORIZED", "DOTENV_KEY", "DOTENV_CONFIG_PATH",
               "DOTENV_CONFIG_OVERRIDE", "DOTENV_CONFIG_DEBUG", "DOTENV_CONFIG_ENCODING")
MANIFEST_KEYS = ("package", "version", "node", "entry")
ABSENT = object()  # `atomic_write(expect=ABSENT)`: the file must still not exist


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


def work_dir(home):
    """Default cwd of the server: private, outside every repository, so no `.env` is read from a repo."""
    return install_root(home) / "work"


def atomic_write(path, text, mode=0o600, expect=None):
    """Write through a same-directory temp file named `<name>.cez-tmp-*` (cezar git-ignores that
    pattern next to mcp.local.json). With `expect` (text, or ABSENT), refuse when the file changed since it
    was read. Without a lock shared with cezar this narrows the race, it does not close it."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f"{path.name}.cez-tmp-")
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        stale = SetupError(f"{path} changed while it was being updated; nothing was written, run the command again")
        if expect is ABSENT:
            try:
                os.link(tmp, path)  # atomic create-if-absent
            except FileExistsError:
                raise stale from None
            os.unlink(tmp)
            return
        if expect is not None and read_text_or_none(path) != expect:
            raise stale
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def read_text_or_none(path):
    try:
        return Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


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

def locked_version(lock_dir=LOCK_DIR):
    """The server version the reviewed lockfile pins."""
    try:
        lock = json.loads((Path(lock_dir) / "package-lock.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SetupError(f"no reviewed lockfile in {lock_dir}; run install from the fork checkout "
                         "(fork/tools/meshy_mcp.py), not from the installed launcher") from None
    entry = lock.get("packages", {}).get(f"node_modules/{PACKAGE}", {})
    if not entry.get("version") or not entry.get("integrity"):
        raise SetupError(f"{lock_dir}/package-lock.json does not pin {PACKAGE} with an integrity hash")
    return entry["version"], entry["integrity"]


def install(home, node, npm, lock_dir=LOCK_DIR):
    version, integrity = locked_version(lock_dir)
    root = install_root(home)
    root.mkdir(parents=True, exist_ok=True)
    # A fresh directory per install: the one the current manifest names is never touched.
    target = Path(tempfile.mkdtemp(prefix=f"{version}-", dir=root))
    os.chmod(target, 0o755)
    for name in ("package.json", "package-lock.json"):
        shutil.copyfile(Path(lock_dir) / name, target / name)
    # `npm ci` installs exactly the lockfile and checks every package's integrity hash.
    subprocess.run([npm, "ci", "--prefix", str(target), "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
                   check=True, timeout=600, stdout=sys.stderr)
    package_dir = target / "node_modules" / "@meshy-ai" / "meshy-mcp-server"
    installed = json.loads((package_dir / "package.json").read_text(encoding="utf-8"))["version"]
    if installed != version:
        raise SetupError(f"npm installed {installed}, the lockfile pins {version}")
    entry = package_dir / "dist" / "index.js"
    if not entry.is_file():
        raise SetupError(f"{entry} is missing")
    ensure_work_dir(home)
    source, launcher = Path(__file__).resolve(), launcher_path(home)
    if not (launcher.exists() and os.path.samefile(source, launcher)):
        atomic_write(launcher, source.read_text(encoding="utf-8"), 0o755)
    # The manifest is published last: a failure above leaves the previous install in use.
    manifest = {"package": PACKAGE, "version": version, "node": str(node), "entry": str(entry), "integrity": integrity}
    atomic_write(manifest_path(home), json.dumps(manifest, indent=2) + "\n", 0o644)
    return manifest


def ensure_work_dir(home):
    """Create or re-check the server's private cwd: a real directory, ours, mode 0700."""
    path = work_dir(home)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise SetupError(f"{path} must be a directory owned by the current user, not a symlink")
    os.chmod(path, 0o700)
    return path


def output_config_path(home):
    return install_root(home) / "output.json"


def output_link(home):
    """The server saves under `<cwd>/meshy_output`; a symlink there points it at the chosen directory."""
    return work_dir(home) / "meshy_output"


def read_output_dir(home):
    try:
        text = read_text_or_none(output_config_path(home))
    except UnicodeDecodeError:
        text = "{}"  # treated as damaged below
    if text is None:
        return None
    try:
        value = json.loads(text).get("dir")
    except (json.JSONDecodeError, AttributeError):
        value = None
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise SetupError(f"{output_config_path(home)} is damaged; run: meshy_mcp.py set-output --dir <absolute dir>")
    return Path(value)


def set_output_dir(home, directory):
    """Validate, point the link, then publish the config: a refusal leaves the previous setting intact."""
    directory = Path(directory).expanduser()
    if not directory.is_absolute():
        raise SetupError("--dir must be an absolute path")
    if directory.exists() and not directory.is_dir():
        raise SetupError(f"{directory} exists and is not a directory")
    link_output(home, directory)
    atomic_write(output_config_path(home), json.dumps({"dir": str(directory)}, indent=2) + "\n", 0o644)
    return directory


def link_output(home, directory):
    """Point `work/meshy_output` at `directory`. The server's cwd stays the private work dir, so
    dotenv never reads a `.env` from the output directory."""
    ensure_work_dir(home)
    link = output_link(home)
    if link.is_symlink():
        if os.readlink(link) == str(directory):
            directory.mkdir(parents=True, exist_ok=True)
            return directory
    elif link.exists():
        raise SetupError(f"{link} is an existing file or directory, not a link; move its contents to "
                         f"{directory} and remove it, then run the command again")
    directory.mkdir(parents=True, exist_ok=True)
    tmp = link.with_name(f"{link.name}.cez-tmp-{os.getpid()}")
    if tmp.is_symlink():
        tmp.unlink()
    tmp.symlink_to(directory, target_is_directory=True)
    os.replace(tmp, link)  # atomic swap, also over a dangling or stale link
    return directory


def ensure_output_link(home):
    directory = read_output_dir(home)
    return None if directory is None else link_output(home, directory)


def read_manifest(home):
    path = manifest_path(home)
    text = read_text_or_none(path)
    if text is None:
        raise SetupError("Meshy MCP server is not installed; run: fork/tools/meshy_mcp.py install")
    try:
        manifest = json.loads(text)
    except json.JSONDecodeError:
        manifest = None
    if not isinstance(manifest, dict) or not all(isinstance(manifest.get(k), str) for k in MANIFEST_KEYS):
        raise SetupError(f"{path} is damaged; run install again")
    return manifest


# ---- run ---------------------------------------------------------------------------------------

def launch_plan(home, environ):
    """The argv, env and cwd `run` execs. Pure apart from reading the manifest, the key and the cwd.
    The cwd is always the private work dir: the server's dotenv reads `<cwd>/.env` at startup."""
    manifest = read_manifest(home)
    env = {k: v for k, v in environ.items() if k not in DROPPED_ENV}
    env.update({KEY_NAME: read_key(home), "MESHY_API_HOST": API_HOST, "TRANSPORT": "stdio",
                "MESHY_CLIENT": "skorowidny-cezar"})
    cwd = work_dir(home)
    if (cwd / ".env").exists():
        raise SetupError(f"{cwd / '.env'} exists; the server would load it, remove it")
    return [manifest["node"], manifest["entry"]], env, cwd


def run(home):
    argv, env, cwd = launch_plan(home, os.environ)
    ensure_work_dir(home)
    try:
        ensure_output_link(home)
    except (SetupError, OSError, ValueError) as err:
        # The download location is optional: a broken setting must not block every run.
        print(f"meshy_mcp: downloads stay in {output_link(home)}: {err}", file=sys.stderr)
    os.chdir(cwd)
    os.execve(argv[0], argv, env)


# ---- register ----------------------------------------------------------------------------------

def parse_mcp_text(path, text):
    if text is None or not text.strip():
        return {"mcpServers": {}}
    try:
        data = json.loads(text)
    except json.JSONDecodeError as err:
        raise SetupError(f"{path} is not valid JSON ({err}); fix it first, nothing was changed") from None
    if not isinstance(data, dict) or not isinstance(data.get("mcpServers", {}), dict):
        raise SetupError(f"{path} must be an object with an \"mcpServers\" object; nothing was changed")
    data.setdefault("mcpServers", {})
    return data


def load_mcp_file(path):
    return parse_mcp_text(path, read_text_or_none(path))


def server_entry(home, python):
    return {"type": "stdio", "command": str(python), "args": ["-I", str(launcher_path(home)), "run"]}


def entry_problem(home, entry):
    """Why a project's `meshy` entry would not start this launcher, or None when it would."""
    if entry is None:
        return "not registered"
    if not isinstance(entry, dict) or not isinstance(entry.get("command"), str) or not entry["command"]:
        return "entry has no \"command\" string"
    args = entry.get("args", [])
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        return "entry \"args\" is not a list of strings"
    env = entry.get("env", {})
    if not isinstance(env, dict) or not all(isinstance(v, str) for v in env.values()):
        return "entry \"env\" is not an object of strings"
    if entry.get("type", "stdio") != "stdio":
        return "entry is not a stdio server"
    if args != ["-I", str(launcher_path(home)), "run"]:
        return f"entry does not start {launcher_path(home)} run"
    return None


def register(home, project, python, name=SERVER_NAME):
    project = Path(project).resolve()
    if not (project / ".git").exists():
        raise SetupError(f"{project} is not the root of a git repository")
    path = project / MCP_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    before = read_text_or_none(path)
    data = parse_mcp_text(path, before)
    data["mcpServers"][name] = server_entry(home, python)
    atomic_write(path, json.dumps(data, indent=2) + "\n", expect=ABSENT if before is None else before)
    return path


def unregister(project, name=SERVER_NAME):
    path = Path(project).resolve() / MCP_FILE
    before = read_text_or_none(path)
    data = parse_mcp_text(path, before)
    if name not in data["mcpServers"]:
        return False
    del data["mcpServers"][name]
    atomic_write(path, json.dumps(data, indent=2) + "\n", expect=before)
    return True


def git_ignored(project, path):
    result = subprocess.run(["git", "-C", str(project), "check-ignore", "-q", "--", str(path)],
                            capture_output=True, timeout=30)
    return result.returncode == 0


# ---- check -------------------------------------------------------------------------------------

def mcp_handshake(argv, cwd, env, timeout=60):
    """Start the server as cezar would, list its tools over stdio and stop it. Uses no credits."""
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "skorowidny-cezar-check", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    with tempfile.TemporaryFile(mode="w+") as stderr:
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=stderr, text=True)
        timed_out = threading.Event()

        def expire():
            timed_out.set()
            proc.kill()

        watchdog = threading.Timer(timeout, expire)
        watchdog.start()
        try:
            for message in requests:
                proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()
            while True:
                line = proc.stdout.readline()
                if not line:
                    if timed_out.is_set():
                        raise SetupError(f"no answer from the server within {timeout} s")
                    proc.wait(timeout=30)
                    stderr.seek(0)
                    raise SetupError(f"the server exited during the handshake: {stderr.read()[-400:]}")
                reply = json.loads(line)
                if not isinstance(reply, dict) or reply.get("id") not in (1, 2):
                    continue  # notifications and logs
                if reply.get("error") is not None:
                    raise SetupError(f"the server refused the handshake: {reply['error']}")
                if reply["id"] == 2:
                    try:
                        return [tool["name"] for tool in reply["result"]["tools"]]
                    except (KeyError, TypeError):
                        raise SetupError("the server answered tools/list in an unexpected shape") from None
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
    directory = ensure_output_link(home)
    lines.append(f"downloads: {directory or output_link(home)} (via {output_link(home)})" if directory
                 else f"downloads: {output_link(home)} (default; set with set-output)")
    env = {**os.environ, "HOME": str(home)}
    if project:
        project = Path(project).resolve()
        path = project / MCP_FILE
        entry = load_mcp_file(path)["mcpServers"].get(SERVER_NAME)
        problem = entry_problem(home, entry)
        if problem:
            raise SetupError(f"{path}: {problem}")
        mode = stat.S_IMODE(path.stat().st_mode)
        lines.append(f"project: {path} registered, mode {mode:o}, git-ignored: {git_ignored(project, path)}")
        # The project's own entry, started from the project the way a run starts it.
        tools = mcp_handshake([entry["command"], *entry.get("args", [])], project, {**env, **entry.get("env", {})})
    else:
        tools = mcp_handshake([sys.executable, "-I", str(launcher_path(home)), "run"], tempfile.gettempdir(), env)
    lines.append(f"handshake: {len(tools)} tools ({', '.join(sorted(tools)[:4])}, …)")
    if with_balance:
        lines.append(f"balance: {balance(key).get('balance')} credits")
    return lines


# ---- CLI ---------------------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("install", help="install the server pinned by fork/tools/meshy-mcp/package-lock.json")
    p.add_argument("--node", default=shutil.which("node"))
    p.add_argument("--npm", default=shutil.which("npm"))
    p = sub.add_parser("set-key", help="store the API key in ~/.config/meshy/meshy.env (0600)")
    p.add_argument("--stdin", action="store_true", help="read the key from stdin instead of a hidden prompt")
    p = sub.add_parser("register", help="add the server to a project's .ai/cezar/mcp.local.json")
    p.add_argument("--project", required=True)
    p.add_argument("--python", default=shutil.which("python3") or sys.executable,
                   help="interpreter cezar starts; kept unresolved so a minor Python upgrade does not break it")
    p = sub.add_parser("unregister", help="remove the server from a project's mcp.local.json")
    p.add_argument("--project", required=True)
    p = sub.add_parser("check", help="verify install, key and handshake; --balance also calls Meshy (free)")
    p.add_argument("--project")
    p.add_argument("--balance", action="store_true")
    p = sub.add_parser("set-output", help="directory the server saves downloads in (default: its private work dir)")
    p.add_argument("--dir", required=True)
    p = sub.add_parser("run", help="stdio entry point started by cezar for each run")
    args = parser.parse_args(argv)
    home = Path.home()
    try:
        if args.command == "install":
            if not args.node or not args.npm:
                raise SetupError("node and npm must be on PATH, or pass --node and --npm")
            manifest = install(home, Path(args.node).resolve(), args.npm)
            print(f"installed {manifest['package']}@{manifest['version']}, launcher {launcher_path(home)}")
        elif args.command == "set-key":
            key = sys.stdin.readline() if args.stdin else getpass.getpass("Meshy API key: ")
            print(f"key stored in {write_key(home, key)}")
        elif args.command == "register":
            read_manifest(home)
            path = register(home, args.project, Path(args.python).absolute())
            print(f"registered '{SERVER_NAME}' in {path}")
            if not git_ignored(Path(args.project).resolve(), path):
                print(f"WARNING: git does not ignore {path}; start cezar once on this project "
                      "(it writes .ai/cezar/.gitignore) before committing anything", file=sys.stderr)
        elif args.command == "unregister":
            print("removed" if unregister(args.project) else "not registered; nothing changed")
        elif args.command == "check":
            for line in check(home, args.project, args.balance):
                print(line)
        elif args.command == "set-output":
            print(f"downloads go to {set_output_dir(home, args.dir)} (via {output_link(home)})")
        elif args.command == "run":
            run(home)
    except (SetupError, OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as err:
        print(f"meshy_mcp: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
