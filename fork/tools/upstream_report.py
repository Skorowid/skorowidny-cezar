"""Read-only upstream comparison driver. Author: Skorowid."""

import argparse
import json
from pathlib import Path
import subprocess


def git(root, *args):
    result = subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=30, check=True,
    )
    return result.stdout.strip()


def commit(root, ref):
    return git(root, "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}")


def changed_files(root, start, end):
    result = subprocess.run(
        ["git", "-C", str(root), "diff", "--name-only", "-z", start, end, "--"],
        capture_output=True, check=True, timeout=30,
    )
    return sorted(result.stdout.decode("utf-8", errors="replace").strip("\0").split("\0")) if result.stdout else []


def category(path):
    if path.startswith("packages/cezar/"):
        return "backend"
    if path.startswith(("packages/contract/", "packages/api-client/")):
        return "shared-contract"
    if path.startswith(("packages/web/", "packages/desktop/")):
        return "presentation"
    if path.startswith(("fork/", "examples/skorowidny-scrum/", "docs/skorowidny-cezar/")):
        return "fork-addition"
    return "shared-infrastructure"


def report(root, baseline, target, fork_ref="HEAD"):
    base_sha, target_sha, fork_sha = [commit(root, ref) for ref in (baseline, target, fork_ref)]
    for sha in (target_sha, fork_sha):
        subprocess.run(
            ["git", "-C", str(root), "merge-base", "--is-ancestor", base_sha, sha],
            check=True, capture_output=True, timeout=30,
        )
    incoming = changed_files(root, base_sha, target_sha)
    local = changed_files(root, base_sha, fork_sha)
    count = int(git(root, "rev-list", "--count", f"{base_sha}..{target_sha}"))
    return {
        "baseline": base_sha,
        "upstream": target_sha,
        "fork": fork_sha,
        "upstream_commit_count": count,
        "incoming_commits": git(root, "log", "--format=%h %s", "-n", "200", f"{base_sha}..{target_sha}").splitlines(),
        "commits_truncated": count > 200,
        "upstream_changes": [{"path": p, "category": category(p)} for p in incoming],
        "fork_changes": [{"path": p, "category": category(p)} for p in local],
        "overlapping_paths": sorted(set(incoming) & set(local)),
        "warning": "Path overlap is a review hint, not a merge simulation or proof of compatibility. Review contract, lockfile and UI dependencies even without overlap.",
    }


def markdown(data):
    lines = ["# Upstream comparison", "", f"- Baseline: `{data['baseline']}`", f"- Upstream: `{data['upstream']}`", f"- Fork: `{data['fork']}`", f"- Incoming commits: {data['upstream_commit_count']}", "", data["warning"], "", "## Incoming commits", ""]
    lines.extend(f"- {line}" for line in data["incoming_commits"])
    if not data["incoming_commits"]:
        lines.append("No incoming commits.")
    if data["commits_truncated"]:
        lines.append("Commit list truncated to 200 entries; use git log for the full range.")
    for key, title in (("upstream_changes", "Upstream changes"), ("fork_changes", "Fork changes")):
        lines.extend(["", f"## {title}", ""])
        lines.extend(f"- `{item['path']}` — {item['category']}" for item in data[key])
        if not data[key]:
            lines.append("No changes.")
    lines.extend(["", "## Overlapping paths", ""])
    lines.extend(f"- `{path}`" for path in data["overlapping_paths"])
    if not data["overlapping_paths"]:
        lines.append("No overlapping paths; this does not establish compatibility.")
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--upstream-ref")
    parser.add_argument("--fork-ref", default="HEAD")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument("--output", type=Path)
    destination.add_argument("--stdout", action="store_true")
    args = parser.parse_args(argv)
    try:
        manifest = json.loads((args.repo / "fork/upstream.json").read_text())
        data = report(args.repo, manifest["baseline_commit"], args.upstream_ref or manifest["integration_ref"], args.fork_ref)
        content = json.dumps(data, indent=2, ensure_ascii=False) + "\n" if args.format == "json" else markdown(data)
        if args.output:
            # Refuse clobbering tracked source or an existing report by accident.
            with args.output.open("x", encoding="utf-8") as output:
                output.write(content)
        else:
            print(content, end="")
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(2, f"Cannot generate upstream report: {error}\n")


if __name__ == "__main__":
    main()
