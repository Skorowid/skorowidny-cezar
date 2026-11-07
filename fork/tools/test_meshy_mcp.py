"""Meshy MCP setup: key file, launch plan, project registration. No network, no npm. Author: Skorowid."""

import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("meshy_mcp", Path(__file__).with_name("meshy_mcp.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

KEY = "msy_TestKeyNotReal1234567890"


class MeshySetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home"
        self.home.mkdir()
        self.project = Path(self.temp.name) / "repo"
        self.project.mkdir()
        subprocess.run(["git", "init", "-q", str(self.project)], check=True, timeout=30)

    def fake_install(self):
        root = MODULE.install_root(self.home)
        root.mkdir(parents=True)
        MODULE.manifest_path(self.home).write_text(json.dumps(
            {"package": MODULE.PACKAGE, "version": "0.6.9", "node": "/usr/bin/node", "entry": "/opt/meshy/index.js"}))

    def mcp_file(self):
        return self.project / MODULE.MCP_FILE

    # key

    def test_key_file_is_private_and_round_trips(self):
        path = MODULE.write_key(self.home, f"  {KEY}\n")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        self.assertEqual(MODULE.read_key(self.home), KEY)

    def test_key_file_readable_by_others_is_refused(self):
        path = MODULE.write_key(self.home, KEY)
        os.chmod(path, 0o644)
        with self.assertRaisesRegex(MODULE.SetupError, "readable by others"):
            MODULE.read_key(self.home)

    def test_missing_key_file_names_the_fix(self):
        with self.assertRaisesRegex(MODULE.SetupError, "set-key"):
            MODULE.read_key(self.home)

    def test_malformed_keys_are_refused(self):
        for bad in ["", "sk-ant-123456789012", "msy_ab", "msy_has space inside"]:
            with self.assertRaises(MODULE.SetupError, msg=bad):
                MODULE.validate_key(bad)

    def test_quoted_key_value_is_accepted(self):
        path = MODULE.write_key(self.home, KEY)
        path.write_text(f'# comment\n{MODULE.KEY_NAME}="{KEY}"\n')
        os.chmod(path, 0o600)
        self.assertEqual(MODULE.read_key(self.home), KEY)

    # launch plan

    def test_launch_plan_pins_host_and_transport_over_hostile_env(self):
        self.fake_install()
        MODULE.write_key(self.home, KEY)
        hostile = {"PATH": "/usr/bin", "MESHY_API_HOST": "https://evil.example", "TRANSPORT": "http",
                   "PORT": "8080", "MESHY_API_KEY": "msy_SomeoneElsesKey99", "NODE_TLS_REJECT_UNAUTHORIZED": "0",
                   "DOTENV_CONFIG_PATH": "/tmp/x.env", "DOTENV_KEY": "dotenv://k"}
        argv, env, cwd = MODULE.launch_plan(self.home, hostile)
        self.assertEqual(argv, ["/usr/bin/node", "/opt/meshy/index.js"])
        self.assertEqual(env["MESHY_API_HOST"], "https://api.meshy.ai")
        self.assertEqual(env["TRANSPORT"], "stdio")
        self.assertEqual(env["MESHY_API_KEY"], KEY)
        for name in ("PORT", "NODE_TLS_REJECT_UNAUTHORIZED", "DOTENV_CONFIG_PATH", "DOTENV_KEY"):
            self.assertNotIn(name, env)
        self.assertEqual(env["PATH"], "/usr/bin")

    def test_server_never_works_in_the_run_worktree_by_default(self):
        # dotenv.config() reads <cwd>/.env; a repository .env could set a proxy and disable TLS checks.
        self.fake_install()
        MODULE.write_key(self.home, KEY)
        _, _, cwd = MODULE.launch_plan(self.home, {})
        self.assertEqual(cwd, MODULE.work_dir(self.home))
        self.assertFalse(str(cwd).startswith(str(self.project)))

    def test_output_dir_with_a_dotenv_is_refused(self):
        self.fake_install()
        MODULE.write_key(self.home, KEY)
        out = Path(self.temp.name) / "assets"
        out.mkdir()
        (out / ".env").write_text("https_proxy=http://attacker:8080\n")
        with self.assertRaisesRegex(MODULE.SetupError, r"\.env exists"):
            MODULE.launch_plan(self.home, {}, str(out))

    def test_damaged_manifest_is_a_clear_refusal(self):
        self.fake_install()
        MODULE.write_key(self.home, KEY)
        for text in ["", "{", "[]", json.dumps({"package": MODULE.PACKAGE, "version": "0.6.9"})]:
            MODULE.manifest_path(self.home).write_text(text)
            with self.assertRaisesRegex(MODULE.SetupError, "damaged|not installed", msg=text):
                MODULE.launch_plan(self.home, {})

    def test_shipped_lockfile_pins_the_server_with_integrity(self):
        version, integrity = MODULE.locked_version()
        self.assertRegex(version, r"^\d+\.\d+\.\d+$")
        self.assertTrue(integrity.startswith("sha512-"))
        lock = json.loads((MODULE.LOCK_DIR / "package-lock.json").read_text())
        unpinned = [k for k, v in lock["packages"].items() if k and not v.get("integrity")]
        self.assertEqual(unpinned, [])
        self.assertEqual(json.loads((MODULE.LOCK_DIR / "package.json").read_text())["dependencies"],
                         {MODULE.PACKAGE: version})

    def test_missing_lockfile_names_the_fix(self):
        with self.assertRaisesRegex(MODULE.SetupError, "fork checkout"):
            MODULE.locked_version(self.home)

    def test_launch_plan_refuses_relative_output_dir(self):
        self.fake_install()
        MODULE.write_key(self.home, KEY)
        with self.assertRaisesRegex(MODULE.SetupError, "absolute"):
            MODULE.launch_plan(self.home, {}, "assets/3d")

    def test_launch_plan_without_install_names_the_fix(self):
        MODULE.write_key(self.home, KEY)
        with self.assertRaisesRegex(MODULE.SetupError, "install"):
            MODULE.launch_plan(self.home, {})

    # register

    def test_register_creates_private_file_without_the_key(self):
        path = MODULE.register(self.home, self.project, "/usr/bin/python3")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        text = path.read_text()
        self.assertNotIn("msy_", text)
        entry = json.loads(text)["mcpServers"]["meshy"]
        self.assertEqual(entry["type"], "stdio")
        self.assertEqual(entry["command"], "/usr/bin/python3")
        self.assertEqual(entry["args"], ["-I", str(MODULE.launcher_path(self.home)), "run"])
        self.assertNotIn("env", entry)

    def test_register_keeps_other_servers_and_unknown_keys(self):
        self.mcp_file().parent.mkdir(parents=True)
        self.mcp_file().write_text(json.dumps({"note": "x", "mcpServers": {"tracker": {"command": "t"}}}))
        MODULE.register(self.home, self.project, "/usr/bin/python3", "/srv/assets")
        data = json.loads(self.mcp_file().read_text())
        self.assertEqual(data["note"], "x")
        self.assertEqual(data["mcpServers"]["tracker"], {"command": "t"})
        self.assertEqual(data["mcpServers"]["meshy"]["args"][-2:], ["--output-dir", "/srv/assets"])

    def test_register_refuses_broken_json_and_leaves_it_untouched(self):
        self.mcp_file().parent.mkdir(parents=True)
        self.mcp_file().write_text("{ broken")
        with self.assertRaisesRegex(MODULE.SetupError, "not valid JSON"):
            MODULE.register(self.home, self.project, "/usr/bin/python3")
        self.assertEqual(self.mcp_file().read_text(), "{ broken")

    def test_register_refuses_non_repository_and_relative_output(self):
        with self.assertRaisesRegex(MODULE.SetupError, "git repository"):
            MODULE.register(self.home, self.home, "/usr/bin/python3")
        with self.assertRaisesRegex(MODULE.SetupError, "absolute"):
            MODULE.register(self.home, self.project, "/usr/bin/python3", "rel/dir")

    def test_register_is_idempotent_and_unregister_removes_only_meshy(self):
        MODULE.register(self.home, self.project, "/usr/bin/python3")
        first = self.mcp_file().read_text()
        MODULE.register(self.home, self.project, "/usr/bin/python3")
        self.assertEqual(self.mcp_file().read_text(), first)
        data = json.loads(first)
        data["mcpServers"]["tracker"] = {"command": "t"}
        self.mcp_file().write_text(json.dumps(data))
        self.assertTrue(MODULE.unregister(self.project))
        self.assertEqual(json.loads(self.mcp_file().read_text())["mcpServers"], {"tracker": {"command": "t"}})
        self.assertFalse(MODULE.unregister(self.project))

    def test_temp_files_match_cezar_gitignore_pattern(self):
        # data-gitignore.ts ignores `mcp.local.json.cez-tmp-*`; a leftover temp file must match it.
        self.mcp_file().parent.mkdir(parents=True)
        seen = []
        real_replace = MODULE.os.replace

        def spy(src, dst):
            seen.append(Path(src).name)
            real_replace(src, dst)

        MODULE.os.replace = spy
        try:
            MODULE.register(self.home, self.project, "/usr/bin/python3")
        finally:
            MODULE.os.replace = real_replace
        self.assertEqual(len(seen), 1)
        self.assertTrue(seen[0].startswith("mcp.local.json.cez-tmp-"), seen[0])

    def test_concurrent_edit_is_not_overwritten(self):
        self.mcp_file().parent.mkdir(parents=True)
        self.mcp_file().write_text(json.dumps({"mcpServers": {}}))
        with self.assertRaisesRegex(MODULE.SetupError, "changed while"):
            MODULE.atomic_write(self.mcp_file(), "{}", expect="something else")
        self.assertEqual(json.loads(self.mcp_file().read_text()), {"mcpServers": {}})
        self.assertEqual([p.name for p in self.mcp_file().parent.iterdir()], ["mcp.local.json"])

    def test_entry_problem_rejects_what_cezar_or_the_launcher_would_not_run(self):
        good = MODULE.server_entry(self.home, "/usr/bin/python3")
        self.assertIsNone(MODULE.entry_problem(self.home, good))
        self.assertIsNone(MODULE.entry_problem(self.home, MODULE.server_entry(self.home, "/usr/bin/python3", "/srv/a")))
        for bad in [None, "broken", {}, {"command": ""}, {"command": "x", "args": "run"},
                    {"command": "x", "type": "http", "args": good["args"]}, {"command": "x", "args": ["run"]}]:
            self.assertIsNotNone(MODULE.entry_problem(self.home, bad), msg=repr(bad))

    def test_registered_entry_is_accepted_by_cezar_name_rule(self):
        # cezar's private-mcp.ts: names [A-Za-z0-9_-]{1,64}; stdio needs "command".
        self.assertRegex(MODULE.SERVER_NAME, r"^[A-Za-z0-9_-]{1,64}$")


if __name__ == "__main__":
    unittest.main()
