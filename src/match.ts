// Derived from the Go standard library, go/build/build.go (Go 1.27):
// Context.MatchFile, matchFile, shouldBuild, matchTag and goodOSArchFile.
// Copyright 2011 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be found
// in LICENSE-go.

import {
  ConstraintSyntaxError,
  evaluateExpr,
  exprToString,
  isPlusBuild,
  parse,
  parseExpr,
  type Expr,
} from './expr.ts';
import {
  MULTIPLE_GO_BUILD,
  decodeBytes,
  parseFileHeader,
  readCommentsHeader,
  readGoHeader,
} from './header.ts';
import { KNOWN_ARCH, KNOWN_OS, UNIX_OS } from './syslist.ts';
import { trimSpace } from './unicode.ts';

/** The Go release the release tags are generated up to when `goVersion` is omitted. */
export const DEFAULT_GO_VERSION = 27;

/** The build configuration a file is matched against. Mirrors go/build.Context. */
export interface BuildContext {
  /** Target operating system, e.g. `linux`. */
  goos: string;
  /** Target architecture, e.g. `arm64`. */
  goarch: string;
  /** Compiler tag. Default `gc`. */
  compiler?: string;
  /** Whether the `cgo` tag is satisfied. Default false. */
  cgo?: boolean;
  /** Extra tags, as passed with `-tags`. */
  buildTags?: readonly string[];
  /** Toolchain tags such as `goexperiment.arenas` or `amd64.v2`. Never derived. */
  toolTags?: readonly string[];
  /** Replaces the generated `go1.1` through `go1.N` tags when set. */
  releaseTags?: readonly string[];
  /** Minor version N of Go 1.N for the generated release tags. Default 27. */
  goVersion?: number;
  /** Ignore file-name and constraint exclusions, as go/build's UseAllFiles does. */
  useAllFiles?: boolean;
}

/** Why a file was included or excluded. */
export type Reason =
  | 'ignored-name'
  | 'unsupported-extension'
  | 'filename-mismatch'
  | 'go-build'
  | 'plus-build'
  | 'no-constraint'
  | 'use-all-files'
  | 'error';

export interface FileDecision {
  /** Same value go/build's `Context.MatchFile` returns as its first result. */
  match: boolean;
  /** Same as MatchFile's error. Note that a read error comes with `match: true`. */
  error: string | null;
  reason: Reason;
  /** The `//go:build` expression, or the `// +build` line(s) that decided, or null. */
  constraint: string | null;
  /** Tags that were consulted, in first-use order. */
  tags: string[];
}

interface Resolved {
  goos: string;
  goarch: string;
  compiler: string;
  cgo: boolean;
  extra: Set<string>;
  useAllFiles: boolean;
}

const resolved = new WeakMap<BuildContext, { key: string; value: Resolved }>();

function ctxKey(c: BuildContext): string {
  return JSON.stringify([
    c.goos,
    c.goarch,
    c.compiler,
    c.cgo,
    c.buildTags,
    c.toolTags,
    c.releaseTags,
    c.goVersion,
    c.useAllFiles,
  ]);
}

function resolve(ctx: BuildContext): Resolved {
  if (typeof ctx?.goos !== 'string' || typeof ctx.goarch !== 'string' || !ctx.goos || !ctx.goarch) {
    throw new TypeError('BuildContext needs non-empty goos and goarch strings');
  }
  const key = ctxKey(ctx);
  const hit = resolved.get(ctx);
  if (hit && hit.key === key) return hit.value;
  const extra = new Set<string>([...(ctx.buildTags ?? []), ...(ctx.toolTags ?? [])]);
  if (ctx.releaseTags) {
    for (const t of ctx.releaseTags) extra.add(t);
  } else {
    const n = ctx.goVersion ?? DEFAULT_GO_VERSION;
    for (let i = 1; i <= n; i++) extra.add(`go1.${i}`);
  }
  const value: Resolved = {
    goos: ctx.goos,
    goarch: ctx.goarch,
    compiler: ctx.compiler ?? 'gc',
    cgo: ctx.cgo ?? false,
    extra,
    useAllFiles: ctx.useAllFiles ?? false,
  };
  resolved.set(ctx, { key, value });
  return value;
}

function matchTagIn(name: string, c: Resolved, consulted: Set<string> | null): boolean {
  consulted?.add(name);
  if (c.cgo && name === 'cgo') return true;
  if (name === c.goos || name === c.goarch || name === c.compiler) return true;
  if (c.goos === 'android' && name === 'linux') return true;
  if (c.goos === 'illumos' && name === 'solaris') return true;
  if (c.goos === 'ios' && name === 'darwin') return true;
  if (name === 'unix' && UNIX_OS.has(c.goos)) return true;
  if (name === 'boringcrypto') name = 'goexperiment.boringcrypto';
  return c.extra.has(name);
}

/** Whether a build tag is satisfied in the context, including implied tags. */
export function matchTag(name: string, ctx: BuildContext): boolean {
  return matchTagIn(name, resolve(ctx), null);
}

/** Returns a tag predicate for the context, for use with `evaluate`. */
export function tagMatcher(ctx: BuildContext): (tag: string) => boolean {
  const c = resolve(ctx);
  return (tag) => matchTagIn(tag, c, null);
}

function goodOSArchFile(fileName: string, c: Resolved, consulted: Set<string> | null): boolean {
  const dot = fileName.indexOf('.');
  let name = dot < 0 ? fileName : fileName.slice(0, dot);
  // A name with no underscore (linux.go) is never constrained.
  const i = name.indexOf('_');
  if (i < 0) return true;
  name = name.slice(i);
  let l = name.split('_');
  if (l.length > 0 && l[l.length - 1] === 'test') l = l.slice(0, -1);
  const n = l.length;
  const last = l[n - 1];
  const prev = l[n - 2];
  if (n >= 2 && KNOWN_OS.has(prev!) && KNOWN_ARCH.has(last!)) {
    consulted?.add(prev!);
    return matchTagIn(last!, c, consulted) && matchTagIn(prev!, c, consulted);
  }
  if (n >= 1 && (KNOWN_OS.has(last!) || KNOWN_ARCH.has(last!))) {
    return matchTagIn(last!, c, consulted);
  }
  return true;
}

/**
 * Applies only the file-name rules (`_GOOS`, `_GOARCH`, `_GOOS_GOARCH`, with an
 * optional `_test`). Ignores the extension and any `useAllFiles` setting.
 */
export function matchFileName(name: string, ctx: BuildContext): boolean {
  return goodOSArchFile(name, resolve(ctx), null);
}

const NON_GO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.m', '.h', '.hh', '.hpp', '.hxx', '.f', '.F', '.for', '.f90',
  '.s', '.S', '.sx', '.swig', '.swigcxx', '.syso',
]);

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

/**
 * Decides whether a file is part of a build, and says why. `name` is the base
 * name, `content` the file's bytes or text. Follows go/build's `MatchFile`,
 * including the header reader and the file-name rules.
 */
export function explainFile(
  name: string,
  content: string | Uint8Array,
  ctx: BuildContext,
): FileDecision {
  const c = resolve(ctx);
  const consulted = new Set<string>();
  const done = (
    match: boolean,
    reason: Reason,
    constraint: string | null = null,
    error: string | null = null,
  ): FileDecision => ({ match, error, reason, constraint, tags: [...consulted] });

  if (name.startsWith('_') || name.startsWith('.')) return done(false, 'ignored-name');

  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot);
  if (ext !== '.go' && !NON_GO_EXTENSIONS.has(ext)) return done(false, 'unsupported-extension');

  if (!goodOSArchFile(name, c, consulted) && !c.useAllFiles) return done(false, 'filename-mismatch');
  if (ext === '.syso') return done(true, 'no-constraint');

  const raw = ext === '.go' ? readGoHeader(toBytes(content)) : readCommentsHeader(toBytes(content));
  if (raw.error !== null) return done(true, 'error', null, `read ${name}: ${raw.error}`);

  let parsed;
  try {
    parsed = parseFileHeader(decodeBytes(raw.header));
  } catch (e) {
    if (e instanceof Error && e.message === MULTIPLE_GO_BUILD) {
      return done(false, 'error', null, `${name}: ${MULTIPLE_GO_BUILD}`);
    }
    throw e;
  }

  const ok = (x: Expr): boolean => evaluateExpr(x, (t) => matchTagIn(t, c, consulted));

  if (parsed.goBuild !== null) {
    let x: Expr;
    try {
      x = parse(parsed.goBuild);
    } catch (e) {
      if (e instanceof ConstraintSyntaxError) {
        return done(false, 'error', null, `${name}: parsing //go:build line: ${e.message}`);
      }
      throw e;
    }
    const text = exprToString(x);
    if (ok(x)) return done(true, 'go-build', text);
    return c.useAllFiles ? done(true, 'use-all-files', text) : done(false, 'go-build', text);
  }

  const used: string[] = [];
  let failed: string | null = null;
  for (const raw of parsed.trimmed.split('\n')) {
    const line = trimSpace(raw);
    if (!line.startsWith('//') || !line.includes('+build')) continue;
    if (!isPlusBuild(line)) continue;
    let x: Expr;
    try {
      x = parse(line);
    } catch {
      continue; // a too-complex +build line is ignored, as in Go
    }
    used.push(line);
    if (!ok(x) && failed === null) failed = line;
  }
  if (failed !== null) {
    return c.useAllFiles ? done(true, 'use-all-files', failed) : done(false, 'plus-build', failed);
  }
  return used.length > 0 ? done(true, 'plus-build', used.join('\n')) : done(true, 'no-constraint');
}

/** Same result pair as go/build's `Context.MatchFile`. */
export function matchFile(
  name: string,
  content: string | Uint8Array,
  ctx: BuildContext,
): { match: boolean; error: string | null } {
  const d = explainFile(name, content, ctx);
  return { match: d.match, error: d.error };
}

/** Evaluates an expression (or a full `//go:build` / `// +build` line) against a tag set or predicate. */
export function evaluate(
  expr: Expr | string,
  tags: Iterable<string> | ((tag: string) => boolean),
): boolean {
  const x = typeof expr === 'string' ? (expr.startsWith('//') ? parse(expr) : parseExpr(expr)) : expr;
  if (typeof tags === 'function') return evaluateExpr(x, tags);
  const set = tags instanceof Set ? (tags as Set<string>) : new Set(tags);
  return evaluateExpr(x, (t) => set.has(t));
}
