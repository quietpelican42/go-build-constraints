import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConstraintError,
  ConstraintSyntaxError,
  evaluate,
  exprToString,
  explainFile,
  matchFile,
  matchFileName,
  matchTag,
  parse,
  parseExpr,
  plusBuildLines,
  tagMatcher,
  type BuildContext,
} from '../src/index.ts';

const linux: BuildContext = { goos: 'linux', goarch: 'amd64' };

function included(name: string, content: string, ctx: BuildContext = linux): boolean {
  const r = matchFile(name, content, ctx);
  assert.equal(r.error, null, `unexpected error: ${r.error}`);
  return r.match;
}

test('parseExpr: precedence, parentheses and printing', () => {
  assert.equal(exprToString(parseExpr('a || b && c')), 'a || (b && c)');
  assert.equal(exprToString(parseExpr('(a || b) && c')), '(a || b) && c');
  assert.equal(exprToString(parseExpr('!(a && b)')), '!(a && b)');
  assert.equal(exprToString(parseExpr('  !a\t&&  ( b )')), '!a && b');
  assert.equal(exprToString(parseExpr('go1.21 && x_y && 日本')), 'go1.21 && x_y && 日本');
});

test('parseExpr: errors carry Go messages and byte offsets', () => {
  const cases: [string, string, number][] = [
    ['!!a', 'double negation not allowed', 1],
    ['a &', 'invalid syntax at &', 2],
    ['a b', 'unexpected token b', 2],
    ['(a', 'missing close paren', 0],
    ['', 'unexpected end of expression', 0],
    ['a #', 'invalid syntax at #', 2],
    ['é &', 'invalid syntax at &', 3], // é is two bytes in UTF-8
    ['a && ', 'unexpected end of expression', 5],
    ['a)', 'unexpected token )', 1],
  ];
  for (const [text, message, offset] of cases) {
    assert.throws(
      () => parseExpr(text),
      (e: unknown) => {
        assert.ok(e instanceof ConstraintSyntaxError, text);
        assert.equal(e.message, message, text);
        assert.equal(e.offset, offset, text);
        return true;
      },
    );
  }
});

test('parseExpr: at most 1000 operands', () => {
  const chain = (n: number): string => Array(n).fill('a').join(' && ');
  assert.doesNotThrow(() => parseExpr(chain(1000)));
  assert.throws(() => parseExpr(chain(1001)), /build expression too large/);
});

test('parse: a // +build line is an OR of space-separated ANDs of comma terms', () => {
  const x = parse('// +build linux,amd64 darwin,!cgo');
  assert.equal(exprToString(x), '(linux && amd64) || (darwin && !cgo)');
  assert.equal(evaluate(x, ['linux', 'amd64']), true);
  assert.equal(evaluate(x, ['darwin', 'cgo']), false);
  assert.equal(exprToString(parse('//+build a')), 'a');
  // Words that are not valid tags become "ignore", which is never set.
  assert.equal(exprToString(parse('// +build !!a a-b !')), 'ignore || ignore || ignore');
  assert.equal(exprToString(parse('// +build')), 'ignore');
});

test('parse: only whole constraint lines are accepted', () => {
  assert.throws(() => parse('// go:build x'), ConstraintError);
  assert.throws(() => parse('//go:buildx y'), /not a build constraint/);
  assert.throws(() => parse('//go:build a\n// +build b'), /not a build constraint/);
  assert.throws(() => parse('//go:build'), /unexpected end of expression/);
  assert.equal(exprToString(parse('//go:build a\n')), 'a');
});

test('plusBuildLines converts simple expressions and refuses complex ones', () => {
  assert.deepEqual(plusBuildLines(parseExpr('linux && amd64')), ['// +build linux,amd64']);
  assert.deepEqual(plusBuildLines(parseExpr('linux || darwin')), ['// +build linux darwin']);
  assert.deepEqual(plusBuildLines(parseExpr('(linux || darwin) && !cgo')), [
    '// +build linux darwin',
    '// +build !cgo',
  ]);
  assert.deepEqual(plusBuildLines(parseExpr('!(a && b)')), ['// +build !a !b']);
  assert.throws(() => plusBuildLines(parseExpr('(a && b) || (c && d) && (e || f)')), ConstraintError);
});

test('evaluate takes a set, an array or a predicate, and a bare expression or a line', () => {
  assert.equal(evaluate('a && !b', new Set(['a'])), true);
  assert.equal(evaluate('//go:build a && !b', ['a', 'b']), false);
  assert.equal(evaluate('// +build a b', (t) => t === 'b'), true);
  assert.throws(() => evaluate('a &&', []), ConstraintSyntaxError);
});

test('implied tags: android, illumos, ios, unix, cgo, compiler, releases', () => {
  const t = (ctx: BuildContext, tag: string): boolean => matchTag(tag, ctx);
  assert.equal(t({ goos: 'android', goarch: 'arm64' }, 'linux'), true);
  assert.equal(t({ goos: 'linux', goarch: 'arm64' }, 'android'), false);
  assert.equal(t({ goos: 'illumos', goarch: 'amd64' }, 'solaris'), true);
  assert.equal(t({ goos: 'solaris', goarch: 'amd64' }, 'illumos'), false);
  assert.equal(t({ goos: 'ios', goarch: 'arm64' }, 'darwin'), true);
  assert.equal(t({ goos: 'darwin', goarch: 'arm64' }, 'ios'), false);
  assert.equal(t({ goos: 'ios', goarch: 'arm64' }, 'unix'), true);
  assert.equal(t({ goos: 'windows', goarch: 'amd64' }, 'unix'), false);
  assert.equal(t({ goos: 'js', goarch: 'wasm' }, 'unix'), false);
  assert.equal(t({ goos: 'linux', goarch: 'amd64' }, 'cgo'), false);
  assert.equal(t({ goos: 'linux', goarch: 'amd64', cgo: true }, 'cgo'), true);
  assert.equal(t(linux, 'gc'), true);
  assert.equal(t(linux, 'gccgo'), false);
  assert.equal(t({ ...linux, compiler: 'gccgo' }, 'gccgo'), true);
  assert.equal(t(linux, 'go1.27'), true);
  assert.equal(t(linux, 'go1.28'), false);
  assert.equal(t({ ...linux, goVersion: 20 }, 'go1.21'), false);
  assert.equal(t({ ...linux, goVersion: 20 }, 'go1.20'), true);
  assert.equal(t({ ...linux, releaseTags: ['go1.5'] }, 'go1.4'), false);
  assert.equal(t(linux, 'go1'), false);
  assert.equal(t({ ...linux, buildTags: ['integration'] }, 'integration'), true);
  assert.equal(t({ ...linux, toolTags: ['goexperiment.arenas', 'amd64.v2'] }, 'amd64.v2'), true);
  assert.equal(t(linux, 'amd64.v1'), false, 'GOARCH feature tags are never derived');
  assert.equal(t({ ...linux, toolTags: ['goexperiment.boringcrypto'] }, 'boringcrypto'), true);
  assert.equal(t(linux, 'boringcrypto'), false);
  assert.equal(tagMatcher(linux)('linux'), true);
});

test('file names: suffix rules', () => {
  const n = (name: string, ctx: BuildContext = linux): boolean => matchFileName(name, ctx);
  assert.equal(n('a_linux.go'), true);
  assert.equal(n('a_windows.go'), false);
  assert.equal(n('a_amd64.go'), true);
  assert.equal(n('a_arm64.go'), false);
  assert.equal(n('a_linux_amd64.go'), true);
  assert.equal(n('a_linux_arm64.go'), false);
  assert.equal(n('a_windows_amd64.go'), false);
  assert.equal(n('a_windows_test.go'), false);
  assert.equal(n('a_linux_test.go'), true);
  assert.equal(n('a_arm64_test.go'), false);
  assert.equal(n('a_test.go'), true);
  assert.equal(n('a_unix.go'), true, 'unix is not a file-name suffix');
  assert.equal(n('a_unix.go', { goos: 'windows', goarch: 'amd64' }), true);
  assert.equal(n('a_linux_windows.go', { goos: 'windows', goarch: 'amd64' }), true, 'os_os is not os_arch');
  assert.equal(n('a_linux_windows.go'), false, 'only the last element counts');
  assert.equal(n('a_amd64_linux.go', { goos: 'windows', goarch: 'amd64' }), false, 'arch_os is not os_arch, so only linux counts');
  assert.equal(n('a_b_windows.go'), false);
  assert.equal(n('a_Windows.go'), true, 'suffixes are case-sensitive');
  assert.equal(n('a_windows.tar.go'), false, 'only the part before the first dot counts');
  assert.equal(n('a_windows.x_linux.go'), false);
  assert.equal(n('a.windows_go.go'), true);
  assert.equal(n('a_android.go'), false);
  assert.equal(n('a_linux.go', { goos: 'android', goarch: 'arm64' }), true);
  assert.equal(n('a_android.go', { goos: 'android', goarch: 'arm64' }), true);
  assert.equal(n('a_solaris.go', { goos: 'illumos', goarch: 'amd64' }), true);
  assert.equal(n('a_darwin_arm64.go', { goos: 'ios', goarch: 'arm64' }), true);
  assert.equal(n('a_zos.go'), false, 'zos is a known GOOS');
  assert.equal(n('a_hurd.go'), false);
  assert.equal(n('a_nacl.go'), false);
  assert.equal(n('a_amd64p32.go'), false);
  assert.equal(n('a_wasip1.go', { goos: 'wasip1', goarch: 'wasm' }), true);
});

test('file names: no underscore means no constraint', () => {
  for (const name of ['linux.go', 'windows.go', 'amd64.go', 'windows_.go'.replace('_', ''), 'linux.test.go']) {
    assert.equal(matchFileName(name, { goos: 'solaris', goarch: 'arm' }), true, name);
  }
  assert.equal(matchFileName('_linux.go', { goos: 'windows', goarch: 'arm' }), false);
});

test('file names: ignored and unsupported files', () => {
  const src = 'package a\n';
  assert.equal(explainFile('_a.go', src, linux).reason, 'ignored-name');
  assert.equal(explainFile('.a.go', src, linux).reason, 'ignored-name');
  assert.equal(explainFile('a.GO', src, linux).reason, 'unsupported-extension');
  assert.equal(explainFile('a.txt', src, linux).reason, 'unsupported-extension');
  assert.equal(explainFile('a', src, linux).reason, 'unsupported-extension');
  assert.equal(explainFile('a.go', src, linux).match, true);
  assert.equal(explainFile('a.s', '// x\n', linux).match, true);
  assert.equal(explainFile('a_windows.s', '', linux).reason, 'filename-mismatch');
  assert.equal(explainFile('a_linux.syso', '\x00\x01', linux).match, true, '.syso is not read');
  assert.equal(explainFile('a_windows.go', src, { ...linux, useAllFiles: true }).match, true);
});

test('//go:build header placement', () => {
  const go = (header: string): boolean => included('a.go', `${header}\npackage a\n`);
  assert.equal(go('//go:build windows\n'), false);
  assert.equal(go('//go:build linux\n'), true);
  assert.equal(go('// Copyright\n\n//go:build windows\n'), false, 'after a comment and blank line');
  assert.equal(go('//go:build windows'), false, 'no blank line needed for //go:build');
  assert.equal(go('\n\n\n//go:build windows\n'), false, 'leading blank lines');
  assert.equal(go('/* block */\n//go:build windows\n'), false, 'after a /* */ comment');
  assert.equal(go('/* a\nb */\n//go:build windows\n'), false, 'after a multi-line block comment');
  assert.equal(go('/* //go:build windows */\n'), true, 'inside a block comment');
  assert.equal(go('/*\n//go:build windows\n*/\n'), true, 'on its own line inside a block comment');
  assert.equal(go('//go:generate x\n//go:build windows\n'), false);
  assert.equal(included('a.go', 'package a\n\n//go:build windows\n'), true, 'after the package clause');
  assert.equal(included('a.go', 'package a\n//go:build windows\nfunc f() {}\n'), true);
  assert.equal(go('//go:build windows\n\n\n'), false);
  assert.equal(included('a.go', '﻿//go:build windows\n\npackage a\n'), false, 'UTF-8 BOM');
  assert.equal(included('a.go', '//go:build windows\r\n\r\npackage a\r\n'), false, 'CRLF');
  assert.equal(go('  //go:build windows'), false, 'indented lines are trimmed');
  assert.equal(go('//go:buildwindows'), true, 'needs a space after go:build');
  assert.equal(go('// go:build windows'), true, 'a space after // makes it an ordinary comment');
});

test('// +build header placement: needs a following blank line', () => {
  const go = (header: string, rest = 'package a\n'): boolean => included('a.go', `${header}${rest}`);
  assert.equal(go('// +build windows\n\n'), false);
  assert.equal(go('// +build linux\n\n'), true);
  assert.equal(go('// +build windows\n'), true, 'a +build line directly above package is a doc comment');
  assert.equal(go('// Copyright\n\n// +build windows\n\n'), false);
  assert.equal(go('// +build windows\n\n// Package a.\n'), false);
  assert.equal(go('// +build windows\n// +build linux\n\n'), false, 'lines are ANDed');
  assert.equal(go('// +build linux\n// +build amd64\n\n'), true);
  assert.equal(go('// +build windows linux\n\n'), true, 'space-separated terms are ORed');
  assert.equal(go('// +build linux,!amd64\n\n'), false, 'comma terms are ANDed');
  assert.equal(go('// +build !windows,!plan9\n\n'), true);
  assert.equal(go('//+build windows\n\n'), false);
  assert.equal(go('// +build windows\n\n', 'package a\n// +build linux\n'), false);
});

test('//go:build wins over // +build, which is then not consulted', () => {
  assert.equal(included('a.go', '//go:build linux\n// +build windows\n\npackage a\n'), true);
  assert.equal(included('a.go', '//go:build windows\n// +build linux\n\npackage a\n'), false);
});

test('malformed constraints', () => {
  const r = matchFile('a.go', '//go:build linux &&\n\npackage a\n', linux);
  assert.deepEqual(r, { match: false, error: 'a.go: parsing //go:build line: unexpected end of expression' });
  const two = matchFile('a.go', '//go:build linux\n//go:build amd64\n\npackage a\n', linux);
  assert.deepEqual(two, { match: false, error: 'a.go: multiple //go:build comments' });
  // A // +build line with more than 100 operators is skipped, not an error.
  assert.equal(included('a.go', `// +build ${'a,'.repeat(101)}b\n\npackage a\n`), true);
});

test('read errors: NUL is reported together with match=true, like go/build', () => {
  const r = matchFile('a.go', 'package a\n\x00', linux);
  assert.deepEqual(r, { match: true, error: 'read a.go: unexpected NUL in input' });
  // Bytes after the imports are never read, so a NUL there is fine.
  assert.equal(included('a.go', 'package a\n\nfunc f() {}\n\x00'), true);
});

test('the header reader stops at the end of the imports', () => {
  assert.equal(included('a.go', 'package a\n\nimport "fmt"\n\n//go:build windows\n'), true);
  assert.equal(included('a.go', 'package a\n\nimport (\n\t"fmt"\n)\nimport "os"\n\n// +build windows\n\n'), true);
  // With no package clause the whole file is the header, and it still parses.
  assert.equal(included('a.go', '//go:build windows\n\nnot go at all'), false);
});

test('accepts bytes as well as strings', () => {
  const bytes = new TextEncoder().encode('//go:build windows\n\npackage a\n');
  assert.equal(included('a.go', bytes as unknown as string), false);
  assert.equal(matchFile('a.go', bytes, linux).match, false);
});

test('explainFile reports the deciding constraint and consulted tags', () => {
  const d = explainFile('a_linux.go', '//go:build amd64 && !cgo\n\npackage a\n', linux);
  assert.equal(d.match, true);
  assert.equal(d.reason, 'go-build');
  assert.equal(d.constraint, 'amd64 && !cgo');
  assert.deepEqual(d.tags, ['linux', 'amd64', 'cgo']);
  const p = explainFile('a.go', '// +build windows\n// +build linux\n\npackage a\n', linux);
  assert.deepEqual([p.match, p.reason, p.constraint], [false, 'plus-build', '// +build windows']);
  assert.equal(explainFile('a.go', 'package a\n', linux).reason, 'no-constraint');
});

test('BuildContext needs goos and goarch', () => {
  assert.throws(() => matchFile('a.go', '', { goos: '', goarch: 'amd64' }), TypeError);
  assert.throws(() => matchFile('a.go', '', {} as BuildContext), TypeError);
});
