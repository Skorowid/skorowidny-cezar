import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { SCRUM_ARTIFACT_MAX_BYTES, SCRUM_ARTIFACTS_PER_RESULT, type ScrumArtifact } from '@open-mercato/cezar-contract';

/**
 * SCRUM-COORD-01 result presentation: what an agent says it produced is only a claim. A declared
 * file must be a regular file inside the run's own working directory, on an allow-list, and a
 * screenshot must really be an image; it is then copied with its hash, so the record outlives the
 * worktree. A preview link must be a plain loopback URL and is only ever probed or linked: cezar
 * starts nothing from it. Anything else is recorded as `rejected` with the reason.
 *
 * @author Skorowid
 */

export const declaredArtifactSchema = z.object({
  kind: z.enum(['screenshot', 'file', 'preview']),
  label: z.string().trim().max(300).default(''),
  path: z.string().trim().max(2000).optional(),
  url: z.string().trim().max(2000).optional(),
});
export type DeclaredArtifact = z.infer<typeof declaredArtifactSchema>;

/** Inline-safe images only: no SVG, which can carry scripts. */
const IMAGE_TYPES: Record<string, { mediaType: string; magic: (head: Buffer) => boolean }> = {
  '.png': { mediaType: 'image/png', magic: head => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  '.jpg': { mediaType: 'image/jpeg', magic: head => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  '.jpeg': { mediaType: 'image/jpeg', magic: head => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  '.gif': { mediaType: 'image/gif', magic: head => ['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('latin1')) },
  '.webp': { mediaType: 'image/webp', magic: head => head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP' },
};
/** Delivered as a download, never opened in the cockpit's origin. */
const FILE_EXTENSIONS = new Set(['.pdf', '.txt', '.md', '.json', '.csv', '.log', '.zip', '.tar', '.gz', '.tgz', '.apk', '.aab', '.msi', '.exe', '.dmg', '.deb', '.rpm', '.appimage', '.html', ...Object.keys(IMAGE_TYPES)]);

export const artifactsDir = (dataDir: string, workId: string) => join(dataDir, 'scrum', 'artifacts', workId);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Returns the normalized URL, or why it is refused. `forbiddenHost` is the cockpit itself. */
export function validatePreviewUrl(raw: string, forbiddenHost?: string): { url: string } | { problem: string } {
  let url: URL;
  try { url = new URL(raw); } catch { return { problem: 'not a valid URL' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { problem: `the ${url.protocol} scheme is not allowed; only http and https` };
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return { problem: 'only a local preview on localhost, 127.0.0.1 or [::1] is allowed' };
  if (url.username || url.password) return { problem: 'a URL with credentials is not allowed' };
  if (!url.port) return { problem: 'a local preview URL must name its port' };
  if (forbiddenHost && url.host.toLowerCase() === forbiddenHost.toLowerCase()) return { problem: 'the URL points at the cockpit itself' };
  return { url: url.toString() };
}

/** One bounded request to a validated loopback URL. Redirects are not followed, so it cannot leave loopback. */
export async function probePreview(url: string): Promise<{ status: 'reachable' | 'unreachable'; reason: string }> {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(3000) });
    await response.body?.cancel().catch(() => undefined);
    return { status: 'reachable', reason: `answered HTTP ${response.status}` };
  } catch (error) {
    return { status: 'unreachable', reason: `no answer: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) };
  }
}

function base(declared: DeclaredArtifact, runId: string): Pick<ScrumArtifact, 'id' | 'kind' | 'label' | 'declared' | 'runId' | 'capturedAt'> {
  return {
    id: randomUUID(), kind: declared.kind, label: declared.label.slice(0, 300),
    declared: (declared.kind === 'preview' ? declared.url : declared.path)?.slice(0, 2000) ?? '', runId, capturedAt: new Date().toISOString(),
  };
}

async function captureFile(declared: DeclaredArtifact, workDir: string | undefined, dataDir: string, workId: string, runId: string): Promise<ScrumArtifact> {
  const fields = base(declared, runId);
  const rejected = (reason: string): ScrumArtifact => ({ ...fields, status: 'rejected', reason: reason.slice(0, 500) });
  if (!declared.path) return rejected('no path was declared');
  if (!workDir) return rejected('the run has no working directory any more, so the file could not be verified');
  if (isAbsolute(declared.path) || declared.path.split(/[\\/]/).includes('..')) return rejected('the path must be relative to the run\'s working directory');
  const target = resolve(workDir, declared.path);
  let info;
  try { info = await lstat(target); } catch { return rejected('the file does not exist'); }
  if (!info.isFile()) return rejected('not a regular file (symbolic links are refused)');
  // A parent directory may still be a link pointing out of the worktree.
  const [realRoot, realTarget] = await Promise.all([realpath(workDir), realpath(target)]);
  if (relative(realRoot, realTarget).startsWith(`..${sep}`) || isAbsolute(relative(realRoot, realTarget))) return rejected('the file is outside the run\'s working directory');
  if (info.size > SCRUM_ARTIFACT_MAX_BYTES) return rejected(`the file is ${info.size} bytes, over the ${SCRUM_ARTIFACT_MAX_BYTES}-byte limit`);
  const extension = extname(target).toLowerCase();
  const image = IMAGE_TYPES[extension];
  if (declared.kind === 'screenshot') {
    if (!image) return rejected(`a screenshot must be PNG, JPEG, GIF or WebP, not "${extension}"`);
    const handle = await open(target, 'r');
    try {
      const head = Buffer.alloc(16);
      await handle.read(head, 0, 16, 0);
      if (!image.magic(head)) return rejected('the file does not contain the image its extension claims');
    } finally { await handle.close(); }
  } else if (!FILE_EXTENSIONS.has(extension)) {
    return rejected(`files of type "${extension}" are not presented`);
  }
  const content = await readFile(target);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const storedAs = `${sha256}${extension}`;
  const directory = artifactsDir(dataDir, workId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await copyFile(target, join(directory, storedAs));
  return {
    ...fields, status: 'verified', reason: 'copied from the run\'s working directory', sha256, bytes: info.size,
    mediaType: declared.kind === 'screenshot' && image ? image.mediaType : 'application/octet-stream', storedAs,
  };
}

/** Validate what one result declared. Over the per-result limit is reported, not silently dropped. */
export async function captureArtifacts(
  declared: readonly unknown[], workDir: string | undefined, dataDir: string, workId: string, runId: string,
): Promise<ScrumArtifact[]> {
  const captured: ScrumArtifact[] = [];
  for (const raw of declared.slice(0, SCRUM_ARTIFACTS_PER_RESULT)) {
    const parsed = declaredArtifactSchema.safeParse(raw);
    if (!parsed.success) {
      captured.push({ id: randomUUID(), kind: 'file', label: '', declared: JSON.stringify(raw)?.slice(0, 2000) ?? '', runId, capturedAt: new Date().toISOString(), status: 'rejected', reason: 'the declaration does not match the expected shape' });
      continue;
    }
    const entry = parsed.data;
    if (entry.kind === 'preview') {
      const checked = validatePreviewUrl(entry.url ?? '');
      captured.push('url' in checked
        ? { ...base(entry, runId), status: 'unchecked', reason: 'a valid local address; not probed yet', url: checked.url }
        : { ...base(entry, runId), status: 'rejected', reason: checked.problem });
      continue;
    }
    try {
      captured.push(await captureFile(entry, workDir, dataDir, workId, runId));
    } catch (error) {
      captured.push({ ...base(entry, runId), status: 'rejected', reason: `could not be read: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) });
    }
  }
  if (declared.length > SCRUM_ARTIFACTS_PER_RESULT && captured.length) {
    const last = captured[captured.length - 1]!;
    captured[captured.length - 1] = { ...last, reason: `${last.reason}; ${declared.length - SCRUM_ARTIFACTS_PER_RESULT} more declared items were not examined`.slice(0, 500) };
  }
  return captured;
}
