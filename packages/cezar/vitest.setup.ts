import { accessSync, constants, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterAll, afterEach, beforeEach } from 'vitest'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { basename as pathBasename } from 'node:path'

// No unit test may start a real agent CLI. A runner suite whose spawn mock falls through (no fake
// set at that moment) ran the real `opencode serve` with "do it" in the repository, and it edited
// tests for 17 minutes (2026-11-27). Patched on the CommonJS module and synced to the ESM bindings,
// so `vi.mock(..., importOriginal)` hands tests the guarded spawn too. Real-CLI smoke runs opt out.
const AGENT_CLIS = new Set(['claude', 'codex', 'opencode', 'pi', 'omp', 'junie', 'cursor-agent', 'gemini', 'kimi', 'agy', 'copilot'])
if (!Object.keys(process.env).some((name) => name.startsWith('CEZ_') && name.includes('SMOKE') && process.env[name] === '1')) {
  const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process')
  const realSpawn = childProcess.spawn
  childProcess.spawn = ((command: string, ...rest: unknown[]) => {
    const name = pathBasename(String(command)).replace(/\.(cmd|exe)$/i, '')
    // A path that does not exist starts nothing: let the real spawn report its ENOENT.
    const missingPath = String(command).includes('/') && !existsSync(String(command))
    if (AGENT_CLIS.has(name) && !missingPath) throw Object.assign(new Error(`[cez] a unit test tried to start the real ${name} CLI`), { code: 'ENOENT' })
    return (realSpawn as (...args: unknown[]) => unknown)(command, ...rest)
  }) as typeof childProcess.spawn
  syncBuiltinESMExports()
}

// Inside a cezar task TMP is `<repo>/.ai/cezar/tmp/<run>` — the user's own checkout. Cases that
// take a fresh `tmpdir()` folder for "outside any repo" then ran git there: `commitAll` committed
// the user's dirty files and a landing path pushed HEAD to their remote. So before anything else
// takes a temp dir, move TMP/TEMP/TMPDIR to a system temp that no git work tree contains.
function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function insideGitWorkTree(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true
    if (dirname(d) === d) return false
  }
}

// A cockpit also points an agent's TMPDIR into `~/.cezar/tmp/agent/…`; the sandbox home made
// under it would sit inside the real home, and the write guard (`paths.ts`) refused every write.
function insideRealCezarHome(dir: string): boolean {
  const realHome = join(homedir(), '.cezar')
  return dir === realHome || dir.startsWith(realHome + sep)
}

if (insideGitWorkTree(realpathSync(tmpdir())) || insideRealCezarHome(realpathSync(tmpdir()))) {
  const candidates =
    process.platform === 'win32'
      ? [join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Temp'), join(process.env.SystemRoot || 'C:\\Windows', 'Temp')]
      : ['/tmp', '/var/tmp']
  const outside = candidates.find(
    (dir) => existsSync(dir) && isWritable(dir) && !insideGitWorkTree(realpathSync(dir)) && !insideRealCezarHome(realpathSync(dir)),
  )
  if (!outside) {
    throw new Error(`[cez] tmpdir ${tmpdir()} is inside a git work tree and no system temp outside one exists — refusing to run git fixtures in it`)
  }
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = outside
}

// Nothing in this suite may write to the developer's own `~/.cezar`. Most cases pin
// `CEZ_HOME` themselves, but the pin is one global for the whole worker and their
// `afterEach` deletes it — so a write that outlives its test (a timeout is enough)
// used to resolve the real home and replace the project registry with the fixture's.
//
// This file removes the unpinned state entirely: every worker gets a sandbox home,
// and the pin is restored around every test, so a case that drops it can only leave
// the NEXT write pointed at the sandbox. A test that wants the unpinned default
// deletes the variable inside its own body (see `src/paths.test.ts`) — that still
// works, because this hook runs after the test, not during it. The write guard in
// `assertCezarHomeWriteIsSandboxed` catches whatever still slips through.
// Fixture repos commit constantly; a developer's global `commit.gpgsign=true` turns each
// commit into a gpg round-trip (~0.35s) and pushes git-heavy cases past the 5s timeout
// under parallel load. Signing is irrelevant to every fixture, so switch it off here —
// injected through git's env config, so no global or repo config file is touched.
if (!process.env.GIT_CONFIG_COUNT) {
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
  process.env.GIT_CONFIG_VALUE_0 = 'false'
}

// Fixtures under `tmpdir()` that are deliberately NOT repositories must stay that way when the
// temp dir itself sits inside a checkout — a cezar task points TMPDIR into the repo's
// `.ai/cezar/tmp/`, and git would otherwise discover the cezar repo above every fixture.
process.env.GIT_CEILING_DIRECTORIES = [
  ...new Set([tmpdir(), realpathSync(tmpdir())]),
  ...(process.env.GIT_CEILING_DIRECTORIES ? [process.env.GIT_CEILING_DIRECTORIES] : []),
].join(':')

// Every CEZ_* the suite inherits belongs to another cezar: the cockpit that runs this as a task
// sets its own (task id, API URL, bin, artifacts dir) and its server config (CEZ_HOME,
// CEZ_CODEX_FULL_ACCESS_PROJECTS…) reaches agents through process.env. A hand-kept list missed
// new ones, so the whole prefix goes; a case that needs one sets it itself. Real-CLI smoke
// opt-ins (`CEZ_*SMOKE*`) are the operator's explicit choice and stay.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('CEZ_') && !name.includes('SMOKE')) delete process.env[name]
}

// `gh`'s signed-in hosts decide which remotes count as GitHub Enterprise (`src/github-hosts.ts`);
// a developer's own `hosts.yml` must not change what the suite classifies. A case that wants
// a host sets `GH_CONFIG_DIR` itself.
process.env.GH_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cez-gh-config-'))
delete process.env.GH_HOST

// LLM task naming is on by default (`autoNamingActive`), so any case that starts a run on
// a real backend spawned `claude -p "[cez-namer] Name this task."` on the developer's own
// subscription — the same canned tasks, every run. Off for the whole suite; a test that
// exercises the namer sets `CEZ_AUTONAME=1` itself (against mock-claude). Forced at load so
// a shell's own value cannot leak in, and re-pinned around every case like `CEZ_HOME`, so a
// case that deletes it cannot hand the next case the default-on namer.
process.env.CEZ_AUTONAME = '0'

const pinAutonameOff = (): void => {
  if (process.env.CEZ_AUTONAME === undefined) process.env.CEZ_AUTONAME = '0'
}

beforeEach(pinAutonameOff)
afterEach(pinAutonameOff)

// mock-claude's demo pacing was most of the suite's wall clock in CI. A case that needs a
// turn held open says `mock:pause`/`mock:slow`, which never scale.
if (process.env.CEZ_MOCK_PACE === undefined) process.env.CEZ_MOCK_PACE = '0'

const sandboxHome = mkdtempSync(join(realpathSync(tmpdir()), 'cez-vitest-home-'))

const pinSandboxHome = (): void => {
  if (!process.env.CEZ_HOME) process.env.CEZ_HOME = sandboxHome
}

pinSandboxHome()
beforeEach(pinSandboxHome)

// Gemini CLI has no `auth status`: cezar reads its credentials from the environment and from
// `<GEMINI_CLI_HOME or ~>/.gemini/.env` (`src/core/gemini-credentials.ts`). Pin that home to the
// sandbox and drop the host's Gemini credentials, so no case depends on whether the developer
// running the suite has a Gemini key. A test that wants one sets it in its own body. The one
// exception is the opt-in real-CLI smoke (`CEZ_GEMINI_SMOKE=1`, `gemini-acp-runner.smoke.test.ts`),
// which needs the real CLI to find the operator's own credentials.
if (process.env.CEZ_GEMINI_SMOKE !== '1') {
  process.env.GEMINI_CLI_HOME = sandboxHome
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA']) {
    delete process.env[name]
  }
}
// The implicit usage-limit fallback (spec 2026-11-15) would hand a `mock:limit` task to Codex,
// which the dry run does not mock — a real, paid CLI. Off for the suite; its own tests enable it
// with the Codex app-server fixture.
const pinLimitFallbackOff = () => {
  process.env.CEZ_LIMIT_FALLBACK = '0'
}
pinLimitFallbackOff()
beforeEach(pinLimitFallbackOff)
// Memory admission (issue #1) reads the real host's memory, which a parallel suite itself eats:
// off for the suite, so a case never waits on the machine; its own tests set the variable.
const pinAdmissionOff = () => {
  process.env.CEZ_ADMIT_MEMORY_GB = '0'
}
pinAdmissionOff()
beforeEach(pinAdmissionOff)
// The usage-limit monitor is a process-wide singleton: a `mock:limit` in one case must not leave
// its account parked for the next.
// Imported here, not at the top: a module this file imports loads before the test file's
// `vi.mock`, so every runner it pulls in kept the real `node:child_process` and the runner
// suites spawned real CLIs instead of their fakes.
beforeEach(async () => {
  const { usageLimitMonitor } = await import('./src/workspace/usage-limit-monitor.ts')
  usageLimitMonitor.resetForTests?.()
  if (process.env.CEZ_HOME) rmSync(join(process.env.CEZ_HOME, 'usage-limits.json'), { force: true })
})
// Registered before any suite's own hooks, so vitest runs it last on the way out —
// after a case's `afterEach` has deleted the pin.
afterEach(pinSandboxHome)
afterAll(() => {
  rmSync(sandboxHome, { recursive: true, force: true })
})
