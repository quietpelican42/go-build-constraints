/**
 * Deterministic generators for the differential tests. Nothing here needs Go:
 * the cases are plain data, so the same corpus can be replayed against any
 * other implementation.
 */
import type { BuildContext } from '../src/index.ts';

export function rng(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  readonly r: () => number;
  /** Tags likely to be satisfied by the case's context; atoms lean toward them. */
  bias: string[] = [];
  ctxOs = '';
  ctxArch = '';
  constructor(seed: number) {
    this.r = rng(seed);
  }
  p(x: number): boolean {
    return this.r() < x;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.r() * (hi - lo + 1));
  }
  os(): string {
    return this.ctxOs && this.p(0.5) ? this.ctxOs : this.pick(OS);
  }
  arch(): string {
    return this.ctxArch && this.p(0.5) ? this.ctxArch : this.pick(ARCH);
  }
  tag(): string {
    return this.bias.length && this.p(0.4) ? this.pick(this.bias) : this.pick(ALL_TAGS);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.r() * xs.length)]!;
  }
  sample<T>(xs: readonly T[], n: number): T[] {
    const c = [...xs];
    const out: T[] = [];
    while (out.length < n && c.length) out.push(c.splice(Math.floor(this.r() * c.length), 1)[0]!);
    return out;
  }
}

export const OS = [
  'linux', 'darwin', 'windows', 'freebsd', 'android', 'ios', 'js', 'wasip1', 'solaris',
  'illumos', 'plan9', 'aix', 'openbsd', 'netbsd', 'dragonfly', 'hurd', 'nacl', 'zos',
];
export const ARCH = [
  'amd64', 'arm64', '386', 'arm', 'wasm', 'riscv64', 's390x', 'ppc64le', 'mips', 'mips64le',
  'loong64', 'amd64p32', 'sparc64',
];
const OTHER_TAGS = [
  'integration', 'debug', 'race', 'netgo', 'cgo', 'unix', 'gc', 'gccgo', 'go1.18', 'go1.21',
  'go1.22', 'go1.27', 'go1.28', 'go1.30', 'go1.9', 'go1.100', 'go1', 'boringcrypto',
  'goexperiment.boringcrypto', 'goexperiment.arenas', 'purego', 'ignore', 'appengine', 'amd64.v1',
  'amd64.v2', 'arm64.v8.0', 'nethelper', 'Linux', 'LINUX', 'x_y', '_x', '9', 'é', '日本語', '١٢٣', 'ǅ',
];
const ALL_TAGS = [...OTHER_TAGS, ...OS, ...ARCH];
const CTX_TAGS = ['integration', 'debug', 'race', 'netgo', 'purego', 'ignore', 'gc', 'gccgo', 'nethelper', 'go1.30', 'é'];
const CTX_TOOL_TAGS = ['goexperiment.arenas', 'goexperiment.boringcrypto', 'amd64.v1', 'amd64.v2', 'arm64.v8.0'];

/** The fixed sweep used for real files. */
export const SWEEP: BuildContext[] = [
  { goos: 'linux', goarch: 'amd64', cgo: true },
  { goos: 'linux', goarch: 'arm64', cgo: false },
  { goos: 'darwin', goarch: 'arm64', cgo: true },
  { goos: 'windows', goarch: 'amd64' },
  { goos: 'android', goarch: 'arm64', cgo: true },
  { goos: 'ios', goarch: 'arm64', cgo: true },
  { goos: 'illumos', goarch: 'amd64' },
  { goos: 'solaris', goarch: 'amd64', cgo: true },
  { goos: 'js', goarch: 'wasm' },
  { goos: 'wasip1', goarch: 'wasm' },
  { goos: 'plan9', goarch: '386' },
  { goos: 'freebsd', goarch: 'riscv64', buildTags: ['purego'] },
  { goos: 'linux', goarch: 's390x', cgo: true, buildTags: ['gccgo_no'], compiler: 'gccgo' },
  { goos: 'linux', goarch: 'amd64', toolTags: ['amd64.v1', 'amd64.v2', 'goexperiment.boringcrypto'], goVersion: 20 },
  { goos: 'aix', goarch: 'ppc64', useAllFiles: true },
];

function expr(g: Gen, d = 0): string {
  const r = g.r();
  if (d > 3 || r < 0.4) return g.tag();
  if (r < 0.55) return g.p(0.85) ? '!' + expr(g, d + 1) : '!!' + g.tag();
  if (r < 0.8) return expr(g, d + 1) + g.pick([' && ', ' && ', '&&', '\t&&\t', ' &&']) + expr(g, d + 1);
  if (r < 0.95) return expr(g, d + 1) + g.pick([' || ', ' || ', '||', ' ||\t']) + expr(g, d + 1);
  return '(' + expr(g, d + 1) + ')';
}

/** An expression that is usually valid and sometimes broken in one specific way. */
function messyExpr(g: Gen): string {
  const e = expr(g);
  if (!g.p(0.12)) return e;
  return g.pick([
    () => e + ' &',
    () => e + ' |',
    () => e + ' &&',
    () => '(' + e,
    () => e + ')',
    () => '',
    () => '!',
    () => e + ' ' + g.pick(ALL_TAGS),
    () => e + ' # comment',
    () => e + ' // trailing',
    () => e.replace(/ /g, '-'),
    () => '$' + e,
    () => '!!' + e,
    () => '()',
    () => e + ' && ' + g.pick(ALL_TAGS),
    () => 'a-b',
    () => '"x"',
    () => '​' + e,
  ])();
}

function plus(g: Gen): string[] {
  const lines: string[] = [];
  for (let i = g.int(1, 2); i > 0; i--) {
    const opts: string[] = [];
    for (let j = g.int(1, 3); j > 0; j--) {
      const terms: string[] = [];
      for (let k = g.int(1, 2); k > 0; k--) {
        let t = (g.p(0.25) ? '!' : '') + g.tag();
        if (g.p(0.03)) t = g.pick(['!!x', '!', 'a-b', '!linux!', ',', '$x', '!!!']);
        terms.push(t);
      }
      opts.push(terms.join(','));
    }
    const prefix = g.pick(['// +build ', '// +build ', '//+build ', '//  +build ', '//\t+build ', '// +build\t']);
    lines.push(prefix + opts.join(g.pick([' ', ' ', '  ', '\t'])));
  }
  if (g.p(0.03)) lines.push(g.pick(['// +build', '// +buildx linux', '//+build', '// +build ' + 'x,'.repeat(60) + 'y']));
  return lines;
}

function goBuildLine(g: Gen): string {
  const r = g.r();
  const e = messyExpr(g);
  if (r < 0.8) return '//go:build ' + e;
  return g.pick([
    '//go:build\t' + e,
    '//go:build',
    '//go:build   ',
    '//go:buildx ' + e,
    '//go:build' + e,
    '// go:build ' + e,
    '//  go:build ' + e,
    '  //go:build ' + e,
    '\t//go:build ' + e + '  ',
    '//go:build ' + e,
    '//go:build　' + e,
    '//GO:BUILD ' + e,
    '/* //go:build ' + e + ' */',
  ]);
}

function header(g: Gen): string[] {
  const L: string[] = [];
  if (g.p(0.5)) L.push('// Copyright 2024 The Authors.', '// Licensed under X.', '');
  if (g.p(0.1)) L.push('/*', 'block license', '*/', '');
  if (g.p(0.05)) L.push('/* one line */');
  if (g.p(0.03)) L.push('/* start', '//go:build ' + expr(g), 'end */', '');
  if (g.p(0.03)) L.push('/* c */ //go:build ' + expr(g));
  if (g.p(0.03)) L.push('/* c', '*/ //go:build ' + expr(g), '');
  if (g.p(0.02)) L.push('/* unterminated', '//go:build ' + expr(g));
  const r = g.r();
  if (r < 0.55) L.push(goBuildLine(g));
  else if (r < 0.7) L.push(...plus(g));
  else if (r < 0.88) {
    L.push(goBuildLine(g));
    L.push(...plus(g));
  } else if (r < 0.9) {
    L.push(...plus(g));
    L.push(goBuildLine(g));
  } else if (r < 0.93) {
    L.push(goBuildLine(g), '', goBuildLine(g));
  } else if (r < 0.95) {
    L.push('// package comment', goBuildLine(g), '// more');
  }
  // a blank line after the constraint, most of the time
  if (g.p(0.88)) L.push('');
  if (g.p(0.05)) L.push('// Package x does things.');
  if (g.p(0.03)) L.push('//go:generate echo', '');
  if (g.p(0.06)) return ['package x', '', goBuildLine(g)];
  return L;
}

const PACKAGE = [
  'package x', 'package x', 'package x', 'package x;', 'package  x // c', 'package\tx', 'package', 'package 1x',
  'packagex', 'pkg x', '', 'package /* c */ x', 'package é',
];
const IMPORTS = [
  '', '', '', 'import "fmt"', 'import (\n\t"fmt"\n\t"os"\n)', 'import _ "unsafe"', 'import . "strings"', 'import "C"',
  'import (', 'import "fmt', 'import fmt', 'import (\n\t"a"\n\t// c\n\t"b"\n)\nimport "c"', 'import ( ; )',
  'import x "y"; import z "w"', 'import `raw`', 'import "a\\"b"', 'importx "q"',
];
const BODY = [
  '', 'func main() {}', 'var s = "//go:build linux"', 'const x = 1 /* //go:build linux */',
  '//go:build linux', '// +build linux', 'var x = 1\x00', '\x00',
];

function goContent(g: Gen): string {
  const h = header(g);
  const parts = [...h];
  if (!(h.length && h[0] === 'package x')) {
    parts.push(g.pick(PACKAGE));
    parts.push('');
    const imp = g.pick(IMPORTS);
    if (imp) parts.push(imp, '');
    if (g.p(0.15)) parts.push(g.pick(BODY));
  }
  let text = parts.join('\n') + '\n';
  if (g.p(0.06)) text = text.replace(/\n/g, '\r\n');
  if (g.p(0.03)) text = '﻿' + text;
  if (g.p(0.02)) text = text.slice(0, g.int(0, text.length));
  if (g.p(0.02)) text = text.replace(/\n$/, '');
  return text;
}

function otherContent(g: Gen, ext: string): string {
  const cstyle = ['.c', '.h', '.cc', '.cpp', '.m', '.hpp', '.swig'].includes(ext);
  const cm = (s: string): string => (cstyle && g.p(0.5) ? `/* ${s} */` : `// ${s}`);
  const L: string[] = [];
  if (g.p(0.5)) L.push('// Copyright 2024 The Authors.', '');
  const r = g.r();
  if (r < 0.5) L.push(goBuildLine(g));
  else if (r < 0.7) L.push(...plus(g));
  else if (r < 0.75) L.push(cm('//go:build ' + expr(g)));
  if (g.p(0.85)) L.push('');
  L.push(g.pick(['TEXT ·f(SB),0,$0-0', '#include <x.h>', 'int x;', 'RET', '/* unterminated', '/x', '']));
  if (g.p(0.3)) L.push(g.pick(['//go:build linux', '// +build linux', 'x\x00y']));
  return L.join('\n') + '\n';
}

function fname(g: Gen): { name: string; ext: string } {
  const base = g.pick(['file', 'util', 'net_helper', 'sys', 'zsyscall', 'x', 'linux', 'windows', 'a_b_c', 'impl', 'z_os', 'go_amd64']);
  const r = g.r();
  let stem: string;
  if (r < 0.55) stem = base;
  else if (r < 0.65) stem = base + '_' + g.pick([...OS, ...OS, 'unix', 'test', 'foo']);
  else if (r < 0.7) stem = base + '_' + g.pick([...ARCH, 'x86']);
  else if (r < 0.8) stem = base + '_' + g.os() + '_' + g.arch();
  else if (r < 0.9) stem = base + '_' + g.os() + '_test';
  else if (r < 0.94) stem = base + '_' + g.os() + '_' + g.arch() + '_test';
  else if (r < 0.97) stem = g.pick(['linux', 'amd64', 'windows_amd64', '_linux', '.hidden', 'x_test', 'x_test_test', 'x_linux_test_linux', 'a_linux_amd64_linux']);
  else stem = base + '_' + g.os() + '.' + g.pick(['test', 'gen', 'x_linux']);
  const q = g.r();
  let ext = '.go';
  if (q > 0.72) ext = g.pick(['.s', '.S', '.c', '.h', '.syso', '.cc', '.m', '.f90', '.txt', '.GO', '.md', '.sx', '.swig', '.hpp', '.go', '']);
  let name = stem + ext;
  if (g.p(0.02)) name = g.pick(['_' + name, '.' + name, '.go', '_.go', 'a.go.bak', 'a.', 'a_linux.go.']);
  const i = name.lastIndexOf('.');
  return { name, ext: i < 0 ? '' : name.slice(i) };
}

export function randomContext(g: () => number): BuildContext {
  const gg = new Gen(Math.floor(g() * 2 ** 32));
  const c: BuildContext = {
    goos: gg.pick(OS),
    goarch: gg.pick(ARCH),
    cgo: gg.p(0.5),
    buildTags: gg.sample(CTX_TAGS, gg.int(0, 3)),
  };
  if (gg.p(0.15)) c.toolTags = gg.sample(CTX_TOOL_TAGS, gg.int(0, 3));
  if (gg.p(0.1)) c.compiler = 'gccgo';
  if (gg.p(0.15)) c.goVersion = gg.pick([1, 8, 17, 18, 20, 21, 22, 26, 27, 28, 40]);
  if (gg.p(0.03)) c.useAllFiles = true;
  return c;
}

export interface MatchCase {
  id: number;
  name: string;
  content: string;
  ctx: BuildContext;
}

export function matchCases(seed: number, n: number): MatchCase[] {
  const g = new Gen(seed);
  const out: MatchCase[] = [];
  for (let id = 0; id < n; id++) {
    const ctx = randomContext(g.r);
    g.ctxOs = ctx.goos;
    g.ctxArch = ctx.goarch;
    g.bias = [ctx.goos, ctx.goarch, ...(ctx.buildTags ?? []), 'unix', 'gc', 'cgo', 'go1.18', 'go1.21'];
    const { name, ext } = fname(g);
    const content = ext === '.go' || g.p(0.1) ? goContent(g) : otherContent(g, ext);
    out.push({ id, name, content, ctx });
  }
  return out;
}

export interface ParseCase {
  id: number;
  line: string;
  tagSets: string[][];
}

export function parseCases(seed: number, n: number): ParseCase[] {
  const g = new Gen(seed);
  const out: ParseCase[] = [];
  for (let id = 0; id < n; id++) {
    const r = g.r();
    let line: string;
    if (r < 0.55) line = '//go:build ' + messyExpr(g);
    else if (r < 0.8) line = plus(g)[0]!;
    else if (r < 0.9) line = g.pick(['// +build', '//go:build', 'not a constraint', '//go:build x\n// +build y', '//go:build a\n', '//go:build a\n\n', '// +build a\n', '\n', '', '//go:build ' + '!'.repeat(g.int(1, 3)) + 'x', '/* //go:build x */']);
    else if (r < 0.95) line = '//go:build ' + '('.repeat(g.int(1, 30)) + expr(g) + ')'.repeat(g.int(0, 30));
    else line = '//go:build ' + Array.from({ length: g.int(1, 40) }, () => expr(g, 2)).join(g.pick([' && ', ' || ']));
    const tagSets = Array.from({ length: 4 }, () => g.sample(ALL_TAGS, g.int(0, 12)));
    out.push({ id, line, tagSets });
  }
  // Fixed size-limit probes: Go counts each unary parse, and bounds +build operators at 100.
  const big = (k: number) => '//go:build ' + Array.from({ length: k }, () => 'a').join(' && ');
  out.push({ id: n, line: big(999), tagSets: [['a']] });
  out.push({ id: n + 1, line: big(1000), tagSets: [['a']] });
  out.push({ id: n + 2, line: big(1001), tagSets: [['a']] });
  const oldTerms = (k: number) => '// +build ' + Array.from({ length: k }, () => 'a').join(',');
  out.push({ id: n + 3, line: oldTerms(101), tagSets: [['a']] });
  out.push({ id: n + 4, line: oldTerms(102), tagSets: [['a']] });
  out.push({ id: n + 5, line: '// +build ' + Array.from({ length: 101 }, () => 'a').join(' '), tagSets: [['a']] });
  out.push({ id: n + 6, line: '// +build ' + Array.from({ length: 102 }, () => 'a').join(' '), tagSets: [['a']] });
  return out;
}
