import { execFile, spawn } from 'node:child_process';
import { existsSync, openSync, closeSync, statSync, accessSync, constants } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type {
  CreatePixelJobInput,
  PixelGpuQueue,
  PixelJob,
  PixelJobList,
  PixelStudioProject,
  PixelStudioProjectStatus,
  PixelStudioStatus,
} from '@open-mercato/cezar-contract';
import { pixelJobStatusSchema, pixelJobToolSchema } from '@open-mercato/cezar-contract';
import { privateMcpPath } from '../core/private-mcp.ts';
import { parseMcpFile, readTextOrNull, setPrivateMcpServer, type McpWriteOps } from '../core/private-mcp-write.ts';

/**
 * Pixel Studio (fork feature; docs/skorowidny-cezar/pixel-studio.md).
 *
 * PixelForge (repo Skorowid/PixelArt_Skorowid_Games, `tools/pixelforge`) is a Python toolchain:
 * Codex image_gen (or the GPU cezar) draws, PixelForge turns the drawing into true pixel art
 * (8-direction characters, animations, dual-grid tilesets) and writes jobs to
 * `<project>/assets/jobs/<id>/job.json`. This module:
 *  - keeps the path of the PixelForge checkout (`~/.local/share/skorowidny-cezar/pixel-studio.json`);
 *  - adds/removes the `pixelforge` private MCP server of a project (agents get the tools);
 *  - lists and reads jobs, serves their files, starts jobs from the cockpit, and syncs the
 *    `gpu-queue/` directory with the remote for the GPU cezar.
 * Every path from the browser is resolved inside the project's jobs directory.
 *
 * Author: Skorowid
 */

export const PIXEL_SERVER_NAME = 'pixelforge';
const execFileP = promisify(execFile);

export interface PixelStudioPaths {
  config: string;
}

export function pixelStudioPaths(home: string = homedir()): PixelStudioPaths {
  return { config: join(home, '.local', 'share', 'skorowidny-cezar', 'pixel-studio.json') };
}

const configSchema = z.object({ home: z.string().refine((p) => isAbsolute(p)) });

export interface PixelForgeInstall {
  home: string;
  launcher: string;
  python: string;
  pkg: string;
}

export function installFor(home: string): PixelForgeInstall {
  const pkg = join(home, 'tools', 'pixelforge');
  return { home, pkg, launcher: join(pkg, 'mcp_launcher.py'), python: join(home, '.venv', 'bin', 'python') };
}

export async function readPixelHome(paths: PixelStudioPaths): Promise<string | null> {
  const text = await readTextOrNull(paths.config).catch(() => null);
  if (text === null) return null;
  try {
    return configSchema.parse(JSON.parse(text)).home;
  } catch {
    return null;
  }
}

export class PixelStudioRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export function installProblem(install: PixelForgeInstall): string | null {
  if (!existsSync(install.launcher)) return `no PixelForge launcher at ${install.launcher}`;
  if (!existsSync(install.python)) return `no PixelForge venv python at ${install.python} (create it: see tools/pixelforge/README.md)`;
  return null;
}

export async function setPixelHome(paths: PixelStudioPaths, home: string): Promise<void> {
  const problem = installProblem(installFor(home));
  if (problem) throw new PixelStudioRefusal(problem, 409);
  await mkdir(dirname(paths.config), { recursive: true });
  const tmp = `${paths.config}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify({ home }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, paths.config);
}

export function jobsDir(projectRoot: string): string {
  return join(projectRoot, 'assets', 'jobs');
}

/** The MCP entry: venv python, isolated mode, launcher; jobs land in the project's main library. */
export function pixelEntry(install: PixelForgeInstall, projectRoot: string) {
  return {
    type: 'stdio' as const,
    command: install.python,
    args: ['-I', install.launcher],
    env: { PIXELFORGE_JOBS: jobsDir(projectRoot) },
  };
}

export function isOurPixelEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.command === 'string' &&
    (e.type === undefined || e.type === 'stdio') &&
    Array.isArray(e.args) &&
    e.args.length === 2 &&
    e.args[0] === '-I' &&
    typeof e.args[1] === 'string' &&
    e.args[1].endsWith(`${sep}tools${sep}pixelforge${sep}mcp_launcher.py`)
  );
}

export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    try {
      const p = join(dir, name);
      if (statSync(p).isFile()) {
        accessSync(p, constants.X_OK);
        return true;
      }
    } catch {
      // not here
    }
  }
  return false;
}

export interface PixelProjectRef {
  id: string;
  name: string;
  root: string;
  missing: boolean;
}

async function projectState(root: string): Promise<{ status: PixelStudioProjectStatus; problem?: string }> {
  let text: string | null;
  try {
    text = await readTextOrNull(privateMcpPath(root));
  } catch {
    return { status: 'broken', problem: 'mcp.local.json could not be read' };
  }
  const file = parseMcpFile(text);
  if (!file.ok) return { status: 'broken', problem: 'mcp.local.json is not valid' };
  const entry = file.data.mcpServers[PIXEL_SERVER_NAME];
  if (entry === undefined) return { status: 'disconnected' };
  return isOurPixelEntry(entry)
    ? { status: 'connected' }
    : { status: 'foreign', problem: 'a "pixelforge" entry that does not start the PixelForge launcher; edit it in Agent config' };
}

export async function readPixelStudioStatus(
  paths: PixelStudioPaths,
  projects: readonly PixelProjectRef[],
  writable: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PixelStudioStatus> {
  const problems: string[] = [];
  const home = await readPixelHome(paths);
  let installed = false;
  if (home === null) {
    problems.push('PixelForge is not configured: set the path of the PixelArt_Skorowid_Games checkout.');
  } else {
    const problem = installProblem(installFor(home));
    installed = problem === null;
    if (problem) problems.push(writable ? problem : 'The PixelForge checkout or its venv is missing on the host.');
  }
  const codex = onPath('codex', env);
  if (!codex) problems.push('codex is not on PATH: Codex image_gen is the default generator.');
  const rows: PixelStudioProject[] = await Promise.all(
    projects.map(async (p): Promise<PixelStudioProject> => {
      if (p.missing) return { id: p.id, name: p.name, status: 'missing' };
      const { status, problem } = await projectState(p.root);
      return { id: p.id, name: p.name, status, ...(problem ? { problem } : {}) };
    }),
  );
  return {
    installed,
    ...(writable && home ? { home } : {}),
    codex,
    aseprite: onPath('aseprite', env),
    writable,
    problems,
    projects: rows,
  };
}

export async function setProjectPixelStudio(
  paths: PixelStudioPaths,
  root: string,
  connected: boolean,
  ops?: McpWriteOps,
): Promise<void> {
  const home = await readPixelHome(paths);
  const install = home ? installFor(home) : null;
  await setPrivateMcpServer(root, {
    name: PIXEL_SERVER_NAME,
    next: connected ? (install ? pixelEntry(install, root) : null) : undefined,
    isOurs: isOurPixelEntry,
    assertInstalled: () => {
      const problem = install ? installProblem(install) : 'PixelForge is not configured';
      if (problem) throw new PixelStudioRefusal(problem, 409);
    },
    refuse: (message) => new PixelStudioRefusal(message, 409),
    messages: {
      broken: (problem) => `${problem}; fix it in Agent config first`,
      foreign: 'this project has its own "pixelforge" entry; change or remove it in Agent config',
      stale: 'mcp.local.json changed while it was being updated; nothing was written, try again',
      exdev: 'mcp.local.json links to another filesystem; add or remove the "pixelforge" entry in Agent config',
    },
    ...(ops ? { ops } : {}),
  });
}

// ---- jobs ---------------------------------------------------------------------------------------

const rawJobSchema = z.object({
  schema: z.literal('pixelforge.job/1'),
  id: z.string(),
  tool: pixelJobToolSchema,
  backend: z.enum(['codex', 'gpu']),
  status: pixelJobStatusSchema,
  created: z.string(),
  updated: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  generation: z.array(z.object({ raw: z.array(z.string()).optional() }).passthrough()).default([]),
  outputs: z.record(z.string(), z.unknown()).default({}),
  qa: z.record(z.string(), z.unknown()).default({}),
  error: z.string().nullable().default(null),
});

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;

function toPixelJob(raw: z.infer<typeof rawJobSchema>): PixelJob {
  const o = raw.outputs;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const outputs: PixelJob['outputs'] = {};
  for (const key of ['sheet', 'json', 'aseprite', 'palette', 'preview'] as const) {
    const v = str(o[key]);
    if (v) outputs[key] = v;
  }
  if (Array.isArray(o.frames)) outputs.frames = o.frames.filter((f): f is string => typeof f === 'string');
  return {
    id: raw.id,
    tool: raw.tool,
    backend: raw.backend,
    status: raw.status,
    created: raw.created,
    updated: raw.updated,
    params: raw.params,
    outputs,
    qa: raw.qa,
    error: raw.error,
    raw: raw.generation.flatMap((s) => s.raw ?? []),
  };
}

export async function readJob(dir: string): Promise<PixelJob> {
  const text = await readFile(join(dir, 'job.json'), 'utf8');
  return toPixelJob(rawJobSchema.parse(JSON.parse(text)));
}

export async function listJobs(projectRoot: string, root: string = jobsDir(projectRoot)): Promise<PixelJobList> {
  const problems: string[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`cannot read ${relative(projectRoot, root)}`);
  }
  const jobs: PixelJob[] = [];
  for (const name of names.sort().reverse()) {
    if (!JOB_ID_RE.test(name) || !existsSync(join(root, name, 'job.json'))) continue;
    try {
      jobs.push(await readJob(join(root, name)));
    } catch {
      problems.push(`job ${name}: job.json is not valid`);
    }
  }
  return { jobs, problems };
}

export function jobDirFor(projectRoot: string, jobId: string): string {
  if (!JOB_ID_RE.test(jobId)) throw new PixelStudioRefusal('invalid job id', 400);
  const dir = join(jobsDir(projectRoot), jobId);
  if (!existsSync(join(dir, 'job.json'))) throw new PixelStudioRefusal(`unknown job ${jobId}`, 404);
  return dir;
}

const FILE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.json': 'application/json',
  '.hex': 'text/plain; charset=utf-8',
  '.aseprite': 'application/octet-stream',
  '.log': 'text/plain; charset=utf-8',
};

/** A job file for the browser: inside the job dir (symlinks resolved), known type only. */
export async function resolveJobFile(projectRoot: string, jobId: string, rel: string): Promise<{ path: string; type: string }> {
  const dir = await realpath(jobDirFor(projectRoot, jobId));
  if (!rel || rel.includes('\0') || isAbsolute(rel)) throw new PixelStudioRefusal('invalid path', 400);
  let path: string;
  try {
    path = await realpath(resolve(dir, rel));
  } catch {
    throw new PixelStudioRefusal('file not found', 404);
  }
  if (!path.startsWith(dir + sep)) throw new PixelStudioRefusal('path outside the job', 400);
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const type = FILE_TYPES[ext];
  if (!type) throw new PixelStudioRefusal('file type not served', 400);
  return { path, type };
}

/** Python snippet run by the cockpit: create (or reuse) the job, then generate + process. */
const WORKER = [
  'import sys, json',
  'sys.path.insert(0, sys.argv[1])',
  'from pathlib import Path',
  'from pixelforge import jobcli, jobs',
  'from pixelforge.backends import gpu',
  'from pixelforge.pipelines import animate, character8, tileset',
  'mode, root, arg = sys.argv[2], Path(sys.argv[3]), json.loads(sys.argv[4])',
  'if mode == "create":',
  '    t = arg["tool"]',
  '    if t == "character8": d, j = character8.prepare(root, arg["description"], arg["size"], arg["colors"], arg["view"], backend=arg["backend"])',
  '    elif t == "animate": d, j = animate.prepare(root, arg["reference"], arg["action"], arg["frames"], arg["direction"], arg["size"], arg["colors"], backend=arg["backend"])',
  '    else: d, j = tileset.prepare(root, arg["lower"], arg["upper"], arg["tileSize"], arg["colors"], backend=arg["backend"])',
  '    if j["backend"] == "gpu": gpu.submit(d, Path(arg["queue"]))',
  '    print(json.dumps({"jobId": j["id"], "status": jobs.load(d)["status"]}), flush=True)',
  '    sys.stdout.close()',
  '    if j["backend"] == "codex":',
  '        j = jobcli.generate(d)',
  '        if j["status"] == "generated": jobcli.process(d)',
  'elif mode == "process":',
  '    jobcli.process(root / arg["jobId"])',
  'elif mode == "collect":',
  '    d = root / arg["jobId"]',
  '    j = gpu.collect(d, Path(arg["queue"]))',
  '    if j["status"] == "generated": jobcli.process(d)',
].join('\n');

export interface StartedJob {
  jobId: string;
  status: PixelJob['status'];
}

/**
 * Start a job: the worker prints {jobId, status} as soon as the job exists, then keeps generating
 * in the background (Codex takes 1–3 minutes per step). Its output goes to `<jobs>/worker.log`.
 */
export async function startJob(install: PixelForgeInstall, projectRoot: string, input: CreatePixelJobInput & Record<string, unknown>): Promise<StartedJob> {
  const root = jobsDir(projectRoot);
  await mkdir(root, { recursive: true });
  const arg: Record<string, unknown> = { ...input, queue: join(projectRoot, 'gpu-queue') };
  if (input.tool === 'animate') {
    const [jobId, ...rest] = String(input.reference).split('/');
    arg.reference = (await resolveJobFile(projectRoot, jobId ?? '', rest.join('/'))).path;
  }
  const logFd = openSync(join(root, 'worker.log'), 'a');
  try {
    const child = spawn(install.python, ['-I', '-c', WORKER, install.pkg, 'create', root, JSON.stringify(arg)], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', logFd],
      detached: false,
    });
    const first = await new Promise<string>((resolveLine, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new PixelStudioRefusal('PixelForge did not create the job in time', 409)), 30_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          clearTimeout(timer);
          resolveLine(buf.slice(0, nl));
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (!buf.includes('\n')) reject(new PixelStudioRefusal(`PixelForge exited with ${code}; see assets/jobs/worker.log`, 409));
      });
    });
    child.unref();
    return z.object({ jobId: z.string(), status: pixelJobStatusSchema }).parse(JSON.parse(first));
  } finally {
    closeSync(logFd);
  }
}

/** Re-run post-processing (done/generated jobs) or collect a GPU job; waits for completion. */
export async function runWorker(install: PixelForgeInstall, projectRoot: string, mode: 'process' | 'collect', jobId: string): Promise<PixelJob> {
  const dir = jobDirFor(projectRoot, jobId);
  try {
    await execFileP(install.python, ['-I', '-c', WORKER, install.pkg, mode, jobsDir(projectRoot), JSON.stringify({ jobId, queue: join(projectRoot, 'gpu-queue') })], {
      cwd: projectRoot,
      timeout: 300_000,
      maxBuffer: 1 << 20,
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    throw new PixelStudioRefusal(`PixelForge ${mode} failed: ${stderr.trim().split('\n').slice(-1)[0] ?? 'error'}`, 409);
  }
  return readJob(dir);
}

// ---- GPU queue ----------------------------------------------------------------------------------

export async function readGpuQueue(projectRoot: string): Promise<PixelGpuQueue> {
  const root = join(projectRoot, 'gpu-queue');
  const entries: PixelGpuQueue['entries'] = [];
  let names: string[] = [];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { entries };
  }
  for (const name of names.sort().reverse()) {
    if (!JOB_ID_RE.test(name)) continue;
    try {
      const job = await readJob(join(root, name));
      entries.push({ id: job.id, tool: job.tool, status: job.status, error: job.error });
    } catch {
      // not a job directory
    }
  }
  return { entries };
}

/**
 * Exchange `gpu-queue/` with the remote: pull --rebase, then commit and push only that
 * directory. A user-initiated button: it never touches other paths and refuses when the pull
 * does not apply cleanly.
 */
export async function syncGpuQueue(projectRoot: string, git: (args: string[]) => Promise<string> = defaultGit(projectRoot)): Promise<{ ok: boolean; log: string }> {
  const log: string[] = [];
  const step = async (args: string[]) => {
    log.push(`$ git ${args.join(' ')}`);
    const out = await git(args);
    if (out.trim()) log.push(out.trim());
  };
  try {
    await step(['pull', '--rebase', '--autostash']);
    await step(['add', '--', 'gpu-queue']);
    const staged = await git(['diff', '--cached', '--name-only', '--', 'gpu-queue']);
    if (staged.trim()) {
      await step(['commit', '-m', 'gpu-queue: sync PixelForge jobs', '--', 'gpu-queue']);
      await step(['push']);
    } else {
      log.push('nothing to push');
    }
    return { ok: true, log: log.join('\n') };
  } catch (err) {
    log.push(String((err as { stderr?: string }).stderr ?? (err as Error).message).trim());
    return { ok: false, log: log.join('\n') };
  }
}

function defaultGit(cwd: string) {
  return async (args: string[]) => (await execFileP('git', args, { cwd, timeout: 120_000, maxBuffer: 1 << 20 })).stdout;
}
