/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines`. The TypeScript suite needs type stripping and only runs on 24+.
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { evaluate, explainFile, matchFile, matchFileName, parse, exprToString, plusBuildLines, parseExpr } =
  await import('../dist/index.js');

const linux = { goos: 'linux', goarch: 'amd64' };

test('go:build expressions', () => {
  assert.equal(exprToString(parseExpr('a || b && !c')), 'a || (b && !c)');
  assert.equal(evaluate('linux && !cgo', ['linux']), true);
  assert.throws(() => parse('//go:build a &&'), /unexpected end of expression/);
});

test('+build lines and conversion', () => {
  assert.equal(evaluate('// +build linux,amd64 darwin', ['darwin']), true);
  assert.deepEqual(plusBuildLines(parseExpr('linux && amd64')), ['// +build linux,amd64']);
});

test('file names', () => {
  assert.equal(matchFileName('a_windows.go', linux), false);
  assert.equal(matchFileName('windows.go', linux), true);
  assert.equal(matchFileName('a_linux_amd64_test.go', linux), true);
});

test('matchFile follows go/build', () => {
  assert.deepEqual(matchFile('a.go', '//go:build windows\n\npackage a\n', linux), { match: false, error: null });
  assert.equal(matchFile('a.go', '// +build windows\n\npackage a\n', linux).match, false);
  assert.equal(matchFile('a.go', '// +build windows\npackage a\n', linux).match, true);
  assert.equal(matchFile('a.go', '//go:build linux\n\npackage a\n', { goos: 'android', goarch: 'arm64' }).match, true);
  assert.equal(explainFile('a.go', '//go:build linux\n\npackage a\n', linux).reason, 'go-build');
});

test('CLI exit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbc-'));
  try {
    writeFileSync(join(dir, 'a.go'), '//go:build linux\n\npackage a\n');
    writeFileSync(join(dir, 'bad.go'), '//go:build (\n\npackage a\n');
    const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
    const ok = run('--goos', 'linux', '--goarch', 'arm64', join(dir, 'a.go'));
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /^included\t/);
    const no = run('--goos', 'windows', '--goarch', 'arm64', join(dir, 'a.go'));
    assert.equal(no.status, 1);
    assert.match(no.stdout, /^excluded\t/);
    assert.equal(run('--goos', 'linux', '--goarch', 'arm64', join(dir, 'bad.go')).status, 2);
    assert.equal(run().status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
