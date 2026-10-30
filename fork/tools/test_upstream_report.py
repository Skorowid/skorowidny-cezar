"""Exercise comparison against real, independent Git histories. Author: Skorowid."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("upstream_report", Path(__file__).with_name("upstream_report.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")
        self.write("packages/cezar/core.txt", "base")
        self.git("add", ".")
        self.git("commit", "-m", "baseline")
        self.base = self.git("rev-parse", "HEAD")

    def git(self, *args):
        return MODULE.git(self.root, *args)

    def write(self, path, text):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)

    def save(self, message):
        self.git("add", ".")
        self.git("commit", "-m", message)
        return self.git("rev-parse", "HEAD")

    def test_identical_history_has_no_changes(self):
        data = MODULE.report(self.root, self.base, "HEAD")
        self.assertEqual(data["upstream_commit_count"], 0)
        self.assertEqual(data["fork_changes"], [])
        self.assertIn("No incoming commits", MODULE.markdown(data))

    def test_divergent_backend_and_ui_are_reported_separately(self):
        self.git("switch", "-c", "incoming")
        self.write("packages/cezar/core.txt", "upstream fix")
        incoming = self.save("fix upstream")
        self.git("switch", "main")
        self.write("packages/web/theme.txt", "own theme")
        fork = self.save("custom UI")
        data = MODULE.report(self.root, self.base, incoming, fork)
        self.assertEqual(data["upstream_changes"], [{"path": "packages/cezar/core.txt", "category": "backend"}])
        self.assertEqual(data["fork_changes"][0]["category"], "presentation")
        self.assertEqual(data["overlapping_paths"], [])
        self.assertEqual(data["upstream_commit_count"], 1)

    def test_overlap_is_visible(self):
        self.write("packages/cezar/core.txt", "changed")
        tip = self.save("change")
        data = MODULE.report(self.root, self.base, tip, tip)
        self.assertEqual(data["overlapping_paths"], ["packages/cezar/core.txt"])

    def test_filename_with_newline_is_not_split(self):
        self.write("packages/web/a\nb.txt", "UI")
        tip = self.save("unusual filename")
        self.assertEqual(MODULE.changed_files(self.root, self.base, tip), ["packages/web/a\nb.txt"])

    def test_unrelated_history_is_rejected(self):
        self.git("checkout", "--orphan", "unrelated")
        self.git("commit", "--allow-empty", "-m", "new root")
        with self.assertRaises(subprocess.CalledProcessError):
            MODULE.report(self.root, self.base, "HEAD", self.base)

    def test_invalid_ref_is_rejected(self):
        with self.assertRaises(subprocess.CalledProcessError):
            MODULE.report(self.root, self.base, "--help")

    def test_contract_and_fork_paths_have_explicit_categories(self):
        self.assertEqual(MODULE.category("packages/contract/src/x.ts"), "shared-contract")
        self.assertEqual(MODULE.category("fork/upstream.json"), "fork-addition")
        self.assertEqual(MODULE.category("package-lock.json"), "shared-infrastructure")

    def test_cli_writes_report_without_stdout_and_refuses_overwrite(self):
        self.write("fork/upstream.json", json.dumps({"baseline_commit": self.base, "integration_ref": "HEAD"}))
        output = self.root / "report.json"
        with contextlib.redirect_stdout(io.StringIO()) as stream:
            MODULE.main(["--repo", str(self.root), "--format", "json", "--output", str(output)])
        self.assertEqual(stream.getvalue(), "")
        self.assertEqual(json.loads(output.read_text())["baseline"], self.base)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            MODULE.main(["--repo", str(self.root), "--output", str(output)])
        self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
