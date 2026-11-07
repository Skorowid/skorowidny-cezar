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

    def test_work_dir_with_a_dotenv_is_refused(self):
        self.fake_install()
        MODULE.write_key(self.home, KEY)
        MODULE.ensure_work_dir(self.home)
        (MODULE.work_dir(self.home) / ".env").write_text("https_proxy=http://attacker:8080\n")
        with self.assertRaisesRegex(MODULE.SetupError, r"\.env exists"):
            MODULE.launch_plan(self.home, {})

    def test_work_dir_is_made_private_and_symlinks_are_refused(self):
        MODULE.install_root(self.home).mkdir(parents=True)
        MODULE.work_dir(self.home).mkdir(mode=0o777)
        os.chmod(MODULE.work_dir(self.home), 0o777)
        MODULE.ensure_work_dir(self.home)
        self.assertEqual(stat.S_IMODE(MODULE.work_dir(self.home).stat().st_mode), 0o700)
        MODULE.work_dir(self.home).rmdir()
        MODULE.work_dir(self.home).symlink_to(self.project)
        with self.assertRaisesRegex(MODULE.SetupError, "symlink"):
            MODULE.ensure_work_dir(self.home)

    def test_reinstall_never_touches_the_tree_in_use_and_publishes_manifest_last(self):
        fake_npm = Path(self.temp.name) / "npm"
        fake_npm.write_text("#!/bin/sh\n"
                            "[ -n \"$FAIL\" ] && exit 1\n"
                            "d=\"$3/node_modules/@meshy-ai/meshy-mcp-server\"; mkdir -p \"$d/dist\"\n"
                            "v=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))[\"packages\"][\"node_modules/@meshy-ai/meshy-mcp-server\"][\"version\"])' \"$3/package-lock.json\")\n"
                            "echo \"{\\\"version\\\": \\\"$v\\\"}\" > \"$d/package.json\"; touch \"$d/dist/index.js\"\n")
        os.chmod(fake_npm, 0o755)
        first = MODULE.install(self.home, "/usr/bin/node", str(fake_npm))
        self.assertTrue(Path(first["entry"]).is_file())
        os.environ["FAIL"] = "1"
        try:
            with self.assertRaises(subprocess.CalledProcessError):
                MODULE.install(self.home, "/usr/bin/node", str(fake_npm))
        finally:
            del os.environ["FAIL"]
        self.assertEqual(MODULE.read_manifest(self.home)["entry"], first["entry"])
        self.assertTrue(Path(first["entry"]).is_file())
        second = MODULE.install(self.home, "/usr/bin/node", str(fake_npm))
        self.assertNotEqual(second["entry"], first["entry"])
        self.assertTrue(Path(first["entry"]).is_file())
        self.assertTrue(MODULE.launcher_path(self.home).is_file())

    def test_output_dir_is_reached_through_a_link_while_cwd_stays_private(self):
        self.fake_install()
        MODULE.write_key(self.home, KEY)
        out = Path(self.temp.name) / "ai-projects" / "mesh_outputs"
        MODULE.set_output_dir(self.home, str(out))
        link = MODULE.output_link(self.home)
        self.assertTrue(out.is_dir())
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.resolve(), out.resolve())
        (out / ".env").write_text("https_proxy=http://attacker:8080\n")  # not the server's cwd
        _, _, cwd = MODULE.launch_plan(self.home, {})
        self.assertEqual(cwd, MODULE.work_dir(self.home))
        other = Path(self.temp.name) / "other"
        MODULE.set_output_dir(self.home, str(other))
        self.assertEqual(link.resolve(), other.resolve())

    def test_output_dir_must_be_absolute_and_earlier_downloads_are_not_hidden(self):
        with self.assertRaisesRegex(MODULE.SetupError, "absolute"):
            MODULE.set_output_dir(self.home, "mesh_outputs")
        MODULE.ensure_work_dir(self.home)
        (MODULE.output_link(self.home) / "old").mkdir(parents=True)
        with self.assertRaisesRegex(MODULE.SetupError, "not a link"):
            MODULE.set_output_dir(self.home, str(Path(self.temp.name) / "out"))
        self.assertTrue((MODULE.output_link(self.home) / "old").is_dir())
        self.assertIsNone(MODULE.read_output_dir(self.home))  # refusal published nothing

    def test_failed_set_output_keeps_the_previous_setting(self):
        good = Path(self.temp.name) / "good"
        MODULE.set_output_dir(self.home, str(good))
        afile = Path(self.temp.name) / "afile"
        afile.write_text("x")
        with self.assertRaisesRegex(MODULE.SetupError, "not a directory"):
            MODULE.set_output_dir(self.home, str(afile))
        self.assertEqual(MODULE.read_output_dir(self.home), good)
        self.assertEqual(MODULE.output_link(self.home).resolve(), good.resolve())

    def test_dangling_relative_and_file_links_are_replaced(self):
        MODULE.ensure_work_dir(self.home)
        link = MODULE.output_link(self.home)
        target = Path(self.temp.name) / "target"
        afile = Path(self.temp.name) / "afile"
        afile.write_text("x")
        for stale in [Path(self.temp.name) / "gone", Path("relative/dir"), afile]:
            if link.is_symlink():
                link.unlink()
            link.symlink_to(stale)
            MODULE.set_output_dir(self.home, str(target))
            self.assertEqual(os.readlink(link), str(target))
        self.assertEqual([p.name for p in MODULE.work_dir(self.home).iterdir()], ["meshy_output"])

    def test_damaged_output_config_does_not_block_run(self):
        self.fake_install()
        MODULE.write_key(self.home, KEY)
        calls = []
        real_execve, real_chdir = MODULE.os.execve, MODULE.os.chdir
        MODULE.os.execve = lambda *a: calls.append(a)
        MODULE.os.chdir = lambda d: None
        try:
            for damaged in [b"{ broken", b"\xff\xfe\x00", b'{"dir": "relative"}', b"[]"]:
                MODULE.output_config_path(self.home).write_bytes(damaged)
                MODULE.run(self.home)
        finally:
            MODULE.os.execve, MODULE.os.chdir = real_execve, real_chdir
        self.assertEqual(len(calls), 4)
        with self.assertRaisesRegex(MODULE.SetupError, "damaged"):
            MODULE.ensure_output_link(self.home)  # check stays strict

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
        MODULE.register(self.home, self.project, "/usr/bin/python3")
        data = json.loads(self.mcp_file().read_text())
        self.assertEqual(data["note"], "x")
        self.assertEqual(data["mcpServers"]["tracker"], {"command": "t"})
        self.assertEqual(data["mcpServers"]["meshy"]["args"][-1], "run")

    def test_register_refuses_broken_json_and_leaves_it_untouched(self):
        self.mcp_file().parent.mkdir(parents=True)
        self.mcp_file().write_text("{ broken")
        with self.assertRaisesRegex(MODULE.SetupError, "not valid JSON"):
            MODULE.register(self.home, self.project, "/usr/bin/python3")
        self.assertEqual(self.mcp_file().read_text(), "{ broken")

    def test_register_refuses_non_repository(self):
        with self.assertRaisesRegex(MODULE.SetupError, "git repository"):
            MODULE.register(self.home, self.home, "/usr/bin/python3")

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
        real_replace, real_link = MODULE.os.replace, MODULE.os.link
        MODULE.os.replace = lambda src, dst: (seen.append(Path(src).name), real_replace(src, dst))
        MODULE.os.link = lambda src, dst: (seen.append(Path(src).name), real_link(src, dst))
        try:
            MODULE.register(self.home, self.project, "/usr/bin/python3")  # creates: link
            MODULE.register(self.home, self.project, "/usr/bin/python3")  # updates: replace
        finally:
            MODULE.os.replace, MODULE.os.link = real_replace, real_link
        self.assertEqual(len(seen), 2)
        for name in seen:
            self.assertTrue(name.startswith("mcp.local.json.cez-tmp-"), name)

    def test_concurrent_edit_is_not_overwritten(self):
        self.mcp_file().parent.mkdir(parents=True)
        self.mcp_file().write_text(json.dumps({"mcpServers": {}}))
        with self.assertRaisesRegex(MODULE.SetupError, "changed while"):
            MODULE.atomic_write(self.mcp_file(), "{}", expect="something else")
        self.assertEqual(json.loads(self.mcp_file().read_text()), {"mcpServers": {}})
        self.assertEqual([p.name for p in self.mcp_file().parent.iterdir()], ["mcp.local.json"])

    def test_file_created_meanwhile_is_not_overwritten(self):
        self.mcp_file().parent.mkdir(parents=True)
        self.mcp_file().write_text('{"mcpServers": {"other": {"command": "o"}}}')
        with self.assertRaisesRegex(MODULE.SetupError, "changed while"):
            MODULE.atomic_write(self.mcp_file(), "{}", expect=MODULE.ABSENT)
        self.assertIn("other", self.mcp_file().read_text())
        self.assertEqual([p.name for p in self.mcp_file().parent.iterdir()], ["mcp.local.json"])

    def test_entry_problem_rejects_what_cezar_or_the_launcher_would_not_run(self):
        good = MODULE.server_entry(self.home, "/usr/bin/python3")
        self.assertIsNone(MODULE.entry_problem(self.home, good))
        self.assertIsNone(MODULE.entry_problem(self.home, {**good, "env": {"A": "b"}}))
        for bad in [None, "broken", {}, {"command": ""}, {"command": "x", "args": "run"},
                    {**good, "env": []}, {**good, "env": {"A": 1}}, {**good, "args": good["args"] + ["--output-dir", "/x"]},
                    {"command": "x", "type": "http", "args": good["args"]}, {"command": "x", "args": ["run"]}]:
            self.assertIsNotNone(MODULE.entry_problem(self.home, bad), msg=repr(bad))

    def test_registered_entry_is_accepted_by_cezar_name_rule(self):
        # cezar's private-mcp.ts: names [A-Za-z0-9_-]{1,64}; stdio needs "command".
        self.assertRegex(MODULE.SERVER_NAME, r"^[A-Za-z0-9_-]{1,64}$")


if __name__ == "__main__":
    unittest.main()
