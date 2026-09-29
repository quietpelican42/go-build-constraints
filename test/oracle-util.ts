import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const cacheDir = join(root, '.cache');
const oracleSrc = join(root, 'scripts', 'oracle');
const oracleBin = join(cacheDir, 'oracle-bin');

/** Returns null when the oracle is usable, else the reason it is not. */
export function oracleUnavailable(): string | null {
  const v = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (v.error || v.status !== 0) {
    return 'go was not found on PATH. Install Go (https://go.dev/dl/) to run the differential tests against real go/build.';
  }
  return null;
}

export function goVersion(): string {
  return spawnSync('go', ['version'], { encoding: 'utf8' }).stdout.trim();
}

/** Builds scripts/oracle into .cache once per run (rebuilt when main.go is newer). */
export function buildOracle(): string {
  mkdirSync(cacheDir, { recursive: true });
  const src = join(oracleSrc, 'main.go');
  if (!existsSync(oracleBin) || statSync(oracleBin).mtimeMs < statSync(src).mtimeMs) {
    const r = spawnSync('go', ['build', '-o', oracleBin, '.'], { cwd: oracleSrc, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`building the Go oracle failed:\n${r.stderr}`);
  }
  return oracleBin;
}

export function runOracle(queries: object[]): Record<string, any>[] {
  const bin = buildOracle();
  const input = queries.map((q) => JSON.stringify(q)).join('\n') + '\n';
  const r = spawnSync(bin, [], { input, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`oracle exited ${r.status}: ${r.stderr}`);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function ctxToOracle(c: import('../src/index.ts').BuildContext): object {
  return {
    goos: c.goos,
    goarch: c.goarch,
    tags: c.buildTags ?? [],
    toolTags: c.toolTags ?? [],
    cgo: c.cgo ?? false,
    goVersion: c.releaseTags ? 0 : (c.goVersion ?? 27),
    compiler: c.compiler ?? 'gc',
    useAllFiles: c.useAllFiles ?? false,
  };
}

export function readText(p: string): string {
  return readFileSync(p, 'utf8');
}
