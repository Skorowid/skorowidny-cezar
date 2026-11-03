# Deploying skorowidny-cezar and returning to the original

Status (2026-10-30): switch of the user service to release `28f4a954` scheduled through a bounded maintenance script that verifies the result and rolls back by itself on failure. The script's local result file, not this document, is the record of whether the switch succeeded. Private paths (backups, logs) stay on the machine and in the task handoff, not in this repository.

## State preserved

- User service `cezar.service`; its unit file and the existing `override.conf` drop-in (`CEZ_AGENT_MODELS_LOCKED=1`) are left untouched.
- Original program: the global npm package `cezar-run@0.17.0` started by the unit's own `ExecStart`. It stays installed and is not overwritten.
- Working directory, port (4321, loopback only), branding and `updateChannel` in `~/.cezar/config.json` are not changed by the switch.
- Copies of the unit and drop-ins were taken before any change; a consistent data backup (`~/.cezar` and each registered project's `.ai/cezar` without `worktrees/`, `tmp/` and `maintenance/`) is taken by the script while the service is stopped. Backups are private, `0700`, and never committed.

## Release

- Built from commit `28f4a954` of `skorowidny/main` (`npm run build`, then `npm pack -w @open-mercato/cezar`).
- Installed from that tarball into `~/.local/share/skorowidny-cezar/releases/28f4a954/` with `npm install --omit=dev`, then made read-only. Production never runs from the checkout that is being rebuilt.
- Smoke-checked before the switch on a separate port and `CEZ_HOME` with synthetic data: health 200, version 0.17.0, `GET /api/v1/scrum` 200, `/p/default/scrum` 200.
- The cockpit's self-update only installs when a user applies it from the update dialog; it never runs on its own. Running from a release directory under `node_modules` it reports itself as an npm install. Do not use the update dialog on this deployment: it would offer upstream `@open-mercato/cezar`, not this fork.

## Switch (what the script does)

1. Waits 25 s, records the number of registered projects, stops `cezar.service` and writes the data backup.
2. Adds only `~/.config/systemd/user/cezar.service.d/90-skorowidny.conf`:

   ```ini
   [Service]
   ExecStart=
   ExecStart=<node 24.21.0> <release>/node_modules/@open-mercato/cezar/dist/index.js
   ```

3. `systemctl --user daemon-reload`, starts the service and verifies for up to 90 s: service active, health 200, same project count, UI 200, `ExecStart` points at the release, `GET /api/v1/scrum` 200 and the Scrum page 200. The checks only read; no Scrum data is written.
4. On any failure it renames the drop-in to `.disabled`, reloads, restarts and verifies the original program.

Restarting the service ends the agent sessions that were open in it; their run records survive and `waiting` runs can be continued.

## Rollback

```bash
systemctl --user stop cezar.service
mv ~/.config/systemd/user/cezar.service.d/90-skorowidny.conf \
   ~/.config/systemd/user/cezar.service.d/90-skorowidny.conf.disabled
systemctl --user daemon-reload
systemctl --user start cezar.service
systemctl --user show cezar.service -p ExecStart   # must be cezar-run again
curl -s http://127.0.0.1:4321/api/v1/health
```

This disables only the fork's drop-in; the original `ExecStart` and the earlier drop-ins apply again. The release directory and the Scrum data (`.ai/cezar/scrum/`, ignored by the original program) are kept so they can be inspected or exported later. Do not restore the data backup as part of a program rollback: it would also undo every change made after it was taken. Restore it only deliberately, with the service stopped, after saving a copy of the current state.

`active` alone is not proof of a working rollback: open the cockpit and check that the projects are there.

## Upgrading to a newer fork release (v0.18.0 base, SCRUM-COORD-01)

Procedure used on 2026-11-03. The script itself and its log stay private on the machine, under the project's `.ai/cezar/maintenance/`, with the rollback script next to them; the handoff of the deploying task names them.

1. Build from the merged commit, pack, install into `releases/<sha>/` with `npm install --omit=dev`, record the commit in `releases/<sha>/SOURCE_SHA`, make it read-only. Smoke it on another port with a sandbox `CEZ_HOME` first.
2. Run the deploy script outside the service, as a transient user unit (`systemd-run --user`), because stopping `cezar.service` ends every process in its control group, including the task that started the deployment.
3. The script waits, records the project count and each project's Scrum revision, stops the service, backs up the unit, its drop-ins, `~/.cezar` and each project's `.ai/cezar` (without `worktrees/`, `tmp/`, `maintenance/`), and replaces `90-skorowidny.conf` with the new release, keeping the old one beside it as `90-skorowidny.conf.prev` (ignored by systemd).
4. It starts the service and verifies: active, health 200 with the expected version, same project count, UI 200, `ExecStart` and the running process both in the release directory, `SOURCE_SHA` as expected, for every project `GET /scrum` 200 with no lost items and `GET /scrum/coordinator` 200 with no blocker, and the Scrum page 200. It also compares hashes of OpenCode's settings and credentials files before and after; it never copies or prints them.
5. On any failure it restores the previous drop-in, restores Scrum states this release changed (keeping the changed file beside it with the release's suffix), restarts and verifies the previous release.

After a restart, the engine resumes interrupted runs with a prompt to read their handoff file, in this release also the same OpenCode 2.x session.

### Going back to the previous fork release

Not the rollback above, which returns to the original program. The private rollback script does this:

1. Stop the service.
2. Put the previous `90-skorowidny.conf.prev` back as `90-skorowidny.conf`, then `systemctl --user daemon-reload`.
3. For each project whose `.ai/cezar/scrum/state.json` was written by the newer release, set it aside and restore the backup's copy, because strict schemas make an older release answer 503 on a newer state. Changes made since the backup then live only in the file set aside.
4. Start the service and check the cockpit.

Upstream 0.18 vault keys: a key created in a new keychain entry cannot be read by older binaries. On a host without a keychain this does not apply; check the vault after going back if one is in use.

## Operating notes for the product coordinator

- **OpenCode.** The runner drives OpenCode 1.x and 2.x. It starts a private `opencode serve` per session on loopback with a random password, independent of OpenCode's own background service. OpenCode's settings and credentials are read by OpenCode, never by cezar.
- **Models.** The service's `CEZ_AGENT_MODELS_LOCKED=1` drop-in makes OpenCode's own settings authoritative: the model fields in the Scrum page are disabled and the coordinator uses OpenCode's configured model. Runners can still be chosen per role, by default the project's default runner.
- **Data.** New files live under each project's `.ai/cezar/scrum/` (`documents/`, `artifacts/`, `items/`, `INDEX.md`) and are covered by the backup of `.ai/cezar`. `INDEX.md` and `items/` are derived and may be deleted. `artifacts/` can hold files of up to 50 MB each.
- **Existing backlogs.** Items that existed before this release have no `autoQueue` flag, so deploying starts no task from them, and a backlog that already has items is not gated.
- **Do not use the update dialog on this deployment:** it would offer upstream `@open-mercato/cezar`, not this fork.
