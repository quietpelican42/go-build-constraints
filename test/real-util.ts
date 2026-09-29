import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { cacheDir } from './oracle-util.ts';

export interface Pin {
  name: string;
  /** GitHub mirror of golang.org/x/<name>. */
  repo: string;
  sha: string;
  /** sha256 of the gunzipped tar, which is stable where the gzip stream is not. */
  tarSha256: string;
}

export const PINS: Pin[] = [
  { name: 'sys', repo: 'golang/sys', sha: '613e2570718ecde85c04e69ebd5585c3881c442c', tarSha256: '1bf017ffbc1730922c6a6f3c01d934da04de34ceca9c2cdc94741e66b37e6d69' },
  { name: 'crypto', repo: 'golang/crypto', sha: '3f62bf119e84c6e35e8518a2958089ade622d1a3', tarSha256: 'bf52c9db5b38d46a83509dae3c85bf4337ac06e33668d6b24341ca1f5d2bfdd6' },
  { name: 'net', repo: 'golang/net', sha: '540d04cfe5028e2655754591a4d3e08c586809f2', tarSha256: 'a8e494d6bf9132cc84d18a97e7b694676f0291247dab4e675a8b1b950842ef0b' },
];

export type Fetched = { dir: string } | { skip: string };

/** Downloads and unpacks a pinned tree into the gitignored .cache directory. */
export async function fetchPin(p: Pin): Promise<Fetched> {
  const dir = join(cacheDir, 'real', `${p.name}-${p.sha}`);
  const marker = `${dir}.fetched`;
  if (existsSync(marker)) return { dir };
  const tar = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (tar.error) return { skip: 'the tar command was not found; it is needed to unpack the pinned x/ trees.' };
  let body: Buffer;
  try {
    const res = await fetch(`https://codeload.github.com/${p.repo}/tar.gz/${p.sha}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return { skip: `download of ${p.repo}@${p.sha} failed with HTTP ${res.status}.` };
    body = gunzipSync(Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    return { skip: `could not download ${p.repo}@${p.sha} (${(e as Error).message}). Check network access.` };
  }
  const got = createHash('sha256').update(body).digest('hex');
  if (got !== p.tarSha256) {
    throw new Error(`sha256 mismatch for ${p.repo}@${p.sha}: expected ${p.tarSha256}, got ${got}`);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const x = spawnSync('tar', ['-xf', '-', '-C', dir, '--strip-components=1'], { input: body });
  if (x.status !== 0) throw new Error(`tar failed: ${x.stderr}`);
  writeFileSync(marker, p.sha + '\n');
  return { dir };
}

/** Relative paths (slash-separated) of every regular file under root. */
export function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

export function readBytes(p: string): Uint8Array {
  return readFileSync(p);
}
