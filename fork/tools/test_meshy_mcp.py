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
                   "PORT": "8080", "MESHY_API_KEY": "msy_SomeoneElsesKey99"}
        argv, env, cwd = MODULE.launch_plan(self.home, hostile)
        self.assertEqual(argv, ["/usr/bin/node", "/opt/meshy/index.js"])
        self.assertEqual(env["MESHY_API_HOST"], "https://api.meshy.ai")
        self.assertEqual(env["TRANSPORT"], "stdio")
        self.assertEqual(env["MESHY_API_KEY"], KEY)
        self.assertNotIn("PORT", env)
        self.assertEqual(env["PATH"], "/usr/bin")
        self.assertIsNone(cwd)

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

    def test_registered_entry_is_accepted_by_cezar_name_rule(self):
        # cezar's private-mcp.ts: names [A-Za-z0-9_-]{1,64}; stdio needs "command".
        self.assertRegex(MODULE.SERVER_NAME, r"^[A-Za-z0-9_-]{1,64}$")


if __name__ == "__main__":
    unittest.main()
