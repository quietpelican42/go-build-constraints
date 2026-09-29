import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from '../src/cli.ts';

const files: Record<string, string> = {
  'pkg/a.go': 'package a\n',
  'pkg/a_windows.go': 'package a\n',
  'pkg/b.go': '//go:build linux\n\npackage a\n',
  'pkg/c.go': '//go:build linux &&\n\npackage a\n',
};

function run(args: string[]): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = runCli(args, {
    out: (s) => (out += s),
    err: (s) => (err += s),
    read: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: no such file, open '${p}'`);
      return new TextEncoder().encode(files[p]);
    },
  });
  return { code, out, err };
}

test('all files included: exit 0', () => {
  const r = run(['--goos', 'linux', '--goarch', 'arm64', 'pkg/a.go', 'pkg/b.go']);
  assert.deepEqual(r, { code: 0, out: 'included\tpkg/a.go\nincluded\tpkg/b.go\n', err: '' });
});

test('an excluded file: exit 1', () => {
  const r = run(['--goos', 'windows', '--goarch', 'amd64', 'pkg/a.go', 'pkg/b.go', 'pkg/a_windows.go']);
  assert.equal(r.code, 1);
  assert.equal(r.out, 'included\tpkg/a.go\nexcluded\tpkg/b.go\nincluded\tpkg/a_windows.go\n');
});

test('--why prints the reason and constraint', () => {
  const r = run(['--goos', 'darwin', '--goarch', 'arm64', '--why', 'pkg/b.go', 'pkg/a_windows.go']);
  assert.equal(r.out, 'excluded\tpkg/b.go\tgo-build\tlinux\nexcluded\tpkg/a_windows.go\tfilename-mismatch\n');
});

test('--tags, --cgo and --go-version feed the context', () => {
  files['t.go'] = '//go:build integration && cgo && go1.20\n\npackage a\n';
  assert.equal(run(['--goos', 'linux', '--goarch', 'amd64', 't.go']).code, 1);
  assert.equal(run(['--goos', 'linux', '--goarch', 'amd64', '--tags', 'integration', '--cgo', 't.go']).code, 0);
  assert.equal(run(['--goos', 'linux', '--goarch', 'amd64', '--tags', 'x,integration', '--cgo', '--go-version', '19', 't.go']).code, 1);
  files['u.go'] = '//go:build goexperiment.arenas\n\npackage a\n';
  assert.equal(run(['--goos', 'linux', '--goarch', 'amd64', '--tool-tags', 'goexperiment.arenas', 'u.go']).code, 0);
});

test('--json prints one object per file', () => {
  const r = run(['--goos', 'linux', '--goarch', 'amd64', '--json', 'pkg/b.go']);
  const o = JSON.parse(r.out);
  assert.equal(o.path, 'pkg/b.go');
  assert.equal(o.match, true);
  assert.equal(o.reason, 'go-build');
});

test('--quiet prints nothing but keeps the exit code', () => {
  const r = run(['--goos', 'windows', '--goarch', 'amd64', '-q', 'pkg/b.go']);
  assert.deepEqual(r, { code: 1, out: '', err: '' });
});

test('a malformed constraint or unreadable file: exit 2', () => {
  const bad = run(['--goos', 'linux', '--goarch', 'amd64', 'pkg/c.go', 'pkg/a.go']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /pkg\/c\.go: c\.go: parsing \/\/go:build line: unexpected end of expression/);
  assert.equal(bad.out, 'included\tpkg/a.go\n', 'other files are still reported');
  const missing = run(['--goos', 'linux', '--goarch', 'amd64', 'nope.go']);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /nope\.go: ENOENT/);
});

test('usage errors: exit 2', () => {
  assert.equal(run(['pkg/a.go']).code, 2);
  assert.match(run(['--goos', 'linux', 'pkg/a.go']).err, /--goos and --goarch are required/);
  assert.equal(run(['--goos', 'linux', '--goarch', 'amd64']).code, 2);
  assert.equal(run(['--goos', 'linux', '--goarch', 'amd64', '--bogus', 'x']).code, 2);
  assert.equal(run(['--goos', 'linux', '--goarch', 'amd64', '--go-version', 'x', 'pkg/a.go']).code, 2);
});

test('--help: exit 0', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /Exit codes/);
});
