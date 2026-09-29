// Derived from the Go standard library, go/build/constraint/expr.go (Go 1.27).
// Copyright 2020 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be found
// in LICENSE-go.

import { fields, isTagChar, trimSpace, utf8Length } from './unicode.ts';

/** A build constraint expression. */
export type Expr =
  | { readonly type: 'tag'; readonly tag: string }
  | { readonly type: 'not'; readonly x: Expr }
  | { readonly type: 'and'; readonly x: Expr; readonly y: Expr }
  | { readonly type: 'or'; readonly x: Expr; readonly y: Expr };

/** Thrown for a malformed `//go:build` expression. The message matches Go's. */
export class ConstraintSyntaxError extends Error {
  /** Byte offset in the input where the error was detected. */
  readonly offset: number;

  constructor(offset: number, message: string) {
    super(message);
    this.name = 'ConstraintSyntaxError';
    this.offset = offset;
  }
}

/** Thrown for input that is not a constraint line, or a `// +build` line that is too complex. */
export class ConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConstraintError';
  }
}

const MAX_SIZE = 1000;
const MAX_OLD_SIZE = 100;

const tag = (t: string): Expr => ({ type: 'tag', tag: t });
const not = (x: Expr): Expr => ({ type: 'not', x });
const and = (x: Expr, y: Expr): Expr => ({ type: 'and', x, y });
const or = (x: Expr, y: Expr): Expr => ({ type: 'or', x, y });

/** Renders an expression in `//go:build` syntax, without the prefix. */
export function exprToString(x: Expr): string {
  switch (x.type) {
    case 'tag':
      return x.tag;
    case 'not': {
      const s = exprToString(x.x);
      return x.x.type === 'and' || x.x.type === 'or' ? `!(${s})` : `!${s}`;
    }
    case 'and': {
      const arg = (e: Expr): string => {
        const s = exprToString(e);
        return e.type === 'or' ? `(${s})` : s;
      };
      return `${arg(x.x)} && ${arg(x.y)}`;
    }
    case 'or': {
      const arg = (e: Expr): string => {
        const s = exprToString(e);
        return e.type === 'and' ? `(${s})` : s;
      };
      return `${arg(x.x)} || ${arg(x.y)}`;
    }
  }
}

/**
 * Evaluates an expression. `ok` reports whether a tag is satisfied. Both sides
 * of `&&` and `||` are always evaluated, so `ok` observes every tag.
 */
export function evaluateExpr(x: Expr, ok: (tag: string) => boolean): boolean {
  switch (x.type) {
    case 'tag':
      return ok(x.tag);
    case 'not':
      return !evaluateExpr(x.x, ok);
    case 'and': {
      const a = evaluateExpr(x.x, ok);
      const b = evaluateExpr(x.y, ok);
      return a && b;
    }
    case 'or': {
      const a = evaluateExpr(x.x, ok);
      const b = evaluateExpr(x.y, ok);
      return a || b;
    }
  }
}

function stripOneNewline(line: string): string | null {
  if (line.endsWith('\n')) line = line.slice(0, -1);
  return line.includes('\n') ? null : line;
}

function splitPrefixed(line: string, rest: string): string | null {
  // `rest` is what follows the prefix. A prefix must be followed by white space
  // (or nothing) to count, so `//go:buildx` is not a constraint.
  const trim = trimSpace(rest);
  if (rest.length === trim.length && rest !== '') return null;
  return trim;
}

function splitGoBuild(line: string): string | null {
  const l = stripOneNewline(line);
  if (l === null || !l.startsWith('//go:build')) return null;
  return splitPrefixed(l, trimSpace(l).slice('//go:build'.length));
}

function splitPlusBuild(line: string): string | null {
  let l = stripOneNewline(line);
  if (l === null || !l.startsWith('//')) return null;
  l = trimSpace(l.slice(2));
  if (!l.startsWith('+build')) return null;
  return splitPrefixed(l, l.slice('+build'.length));
}

/** Whether the line is a `//go:build` line. Checks the prefix only. */
export function isGoBuild(line: string): boolean {
  return splitGoBuild(line) !== null;
}

/** Whether the line is a `// +build` line. Checks the prefix only. */
export function isPlusBuild(line: string): boolean {
  return splitPlusBuild(line) !== null;
}

/** Parses one `//go:build ...` or `// +build ...` line. */
export function parse(line: string): Expr {
  const g = splitGoBuild(line);
  if (g !== null) return parseExpr(g);
  const p = splitPlusBuild(line);
  if (p !== null) return parsePlusBuildExpr(p);
  throw new ConstraintError('not a build constraint');
}

class ExprParser {
  readonly s: string;
  i = 0;
  tok = '';
  isTag = false;
  pos = 0;
  size = 0;

  constructor(s: string) {
    this.s = s;
  }

  fail(offset: number, message: string): never {
    throw new ConstraintSyntaxError(utf8Length(this.s.slice(0, offset)), message);
  }

  or(): Expr {
    let x = this.and();
    while (this.tok === '||') x = or(x, this.and());
    return x;
  }

  and(): Expr {
    let x = this.not();
    while (this.tok === '&&') x = and(x, this.not());
    return x;
  }

  not(): Expr {
    this.size++;
    if (this.size > MAX_SIZE) this.fail(this.pos, 'build expression too large');
    this.lex();
    if (this.tok === '!') {
      this.lex();
      if (this.tok === '!') this.fail(this.pos, 'double negation not allowed');
      return not(this.atom());
    }
    return this.atom();
  }

  atom(): Expr {
    if (this.tok === '(') {
      const pos = this.pos;
      try {
        const x = this.or();
        if ((this.tok as string) !== ')') this.fail(pos, 'missing close paren');
        this.lex();
        return x;
      } catch (e) {
        if (e instanceof ConstraintSyntaxError && e.message === 'unexpected end of expression') {
          throw new ConstraintSyntaxError(e.offset, 'missing close paren');
        }
        throw e;
      }
    }
    if (!this.isTag) {
      if (this.tok === '') this.fail(this.pos, 'unexpected end of expression');
      this.fail(this.pos, `unexpected token ${this.tok}`);
    }
    const t = this.tok;
    this.lex();
    return tag(t);
  }

  lex(): void {
    this.isTag = false;
    const s = this.s;
    while (this.i < s.length && (s[this.i] === ' ' || s[this.i] === '\t')) this.i++;
    if (this.i >= s.length) {
      this.tok = '';
      this.pos = this.i;
      return;
    }
    const c = s[this.i]!;
    if (c === '(' || c === ')' || c === '!') {
      this.pos = this.i;
      this.i++;
      this.tok = c;
      return;
    }
    if (c === '&' || c === '|') {
      if (this.i + 1 >= s.length || s[this.i + 1] !== c) this.fail(this.i, `invalid syntax at ${c}`);
      this.pos = this.i;
      this.i += 2;
      this.tok = c + c;
      return;
    }
    let end = this.i;
    for (const ch of s.slice(this.i)) {
      if (!isTagChar(ch)) break;
      end += ch.length;
    }
    if (end === this.i) {
      const ch = String.fromCodePoint(s.codePointAt(this.i)!);
      this.fail(this.i, `invalid syntax at ${ch}`);
    }
    this.pos = this.i;
    this.tok = s.slice(this.i, end);
    this.i = end;
    this.isTag = true;
  }
}

/** Parses a boolean build expression, the text after `//go:build`. */
export function parseExpr(text: string): Expr {
  const p = new ExprParser(text);
  const x = p.or();
  if (p.tok !== '') p.fail(p.pos, `unexpected token ${p.tok}`);
  return x;
}

function isValidTag(word: string): boolean {
  if (word === '') return false;
  for (const ch of word) if (!isTagChar(ch)) return false;
  return true;
}

/** Parses the text after `// +build`. Invalid terms become the tag `ignore`, as in Go. */
export function parsePlusBuildExpr(text: string): Expr {
  let size = 0;
  let x: Expr | null = null;
  for (const clause of fields(text)) {
    let y: Expr | null = null;
    for (let lit of clause.split(',')) {
      let z: Expr;
      if (lit.startsWith('!!') || lit === '!') {
        z = tag('ignore');
      } else {
        let neg = false;
        if (lit.startsWith('!')) {
          neg = true;
          lit = lit.slice(1);
        }
        z = isValidTag(lit) ? tag(lit) : tag('ignore');
        if (neg) z = not(z);
      }
      if (y === null) {
        y = z;
      } else {
        if (++size > MAX_OLD_SIZE) throw new ConstraintError('expression too complex for // +build lines');
        y = and(y, z);
      }
    }
    if (x === null) {
      x = y;
    } else {
      if (++size > MAX_OLD_SIZE) throw new ConstraintError('expression too complex for // +build lines');
      x = or(x, y!);
    }
  }
  return x ?? tag('ignore');
}

function pushNot(x: Expr, neg: boolean): Expr {
  switch (x.type) {
    case 'not':
      if (x.x.type === 'tag' && !neg) return x;
      return pushNot(x.x, !neg);
    case 'tag':
      return neg ? not(x) : x;
    case 'and': {
      const x1 = pushNot(x.x, neg);
      const y1 = pushNot(x.y, neg);
      if (neg) return or(x1, y1);
      return x1 === x.x && y1 === x.y ? x : and(x1, y1);
    }
    case 'or': {
      const x1 = pushNot(x.x, neg);
      const y1 = pushNot(x.y, neg);
      if (neg) return and(x1, y1);
      return x1 === x.x && y1 === x.y ? x : or(x1, y1);
    }
  }
}

function splitAnd(list: Expr[], x: Expr): Expr[] {
  if (x.type === 'and') {
    splitAnd(list, x.x);
    splitAnd(list, x.y);
    return list;
  }
  list.push(x);
  return list;
}

function splitOr(list: Expr[], x: Expr): Expr[] {
  if (x.type === 'or') {
    splitOr(list, x.x);
    splitOr(list, x.y);
    return list;
  }
  list.push(x);
  return list;
}

/**
 * Returns `// +build` lines equivalent to the expression. Throws ConstraintError
 * when the expression is too complex to write in that form.
 */
export function plusBuildLines(expr: Expr): string[] {
  const x = pushNot(expr, false);
  let split: Expr[][][] = [];
  for (const orTerm of splitAnd([], x)) {
    const ands: Expr[][] = [];
    for (const andTerm of splitOr([], orTerm)) {
      const lits: Expr[] = [];
      for (const lit of splitAnd([], andTerm)) {
        if (lit.type !== 'tag' && lit.type !== 'not') {
          throw new ConstraintError('expression too complex for // +build lines');
        }
        lits.push(lit);
      }
      ands.push(lits);
    }
    split.push(ands);
  }
  const maxOr = split.reduce((m, o) => Math.max(m, o.length), 0);
  if (maxOr === 1) {
    const lits: Expr[] = [];
    for (const o of split) lits.push(...o[0]!);
    split = [[lits]];
  }
  return split.map((o) => `// +build${o.map((a) => ` ${a.map(exprToString).join(',')}`).join('')}`);
}
