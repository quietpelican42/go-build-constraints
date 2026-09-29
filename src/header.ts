// Derived from the Go standard library, go/build/read.go and go/build/build.go
// (Go 1.27): importReader, readComments, readGoInfo, parseFileHeader and
// isGoBuildComment.
// Copyright 2012 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be found
// in LICENSE-go.

import { trimSpace } from './unicode.ts';

const ERR_SYNTAX = 'syntax error';
const ERR_NUL = 'unexpected NUL in input';

const NL = 0x0a;
const SLASH = 0x2f;
const STAR = 0x2a;

function isIdent(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x30 && c <= 0x39) ||
    c === 0x5f ||
    c >= 0x80
  );
}

/** Byte-for-byte port of go/build's importReader. */
class ImportReader {
  readonly src: Uint8Array;
  off = 0;
  buf: number[] = [];
  peek = 0;
  err: string | null = null;
  eof = false;

  constructor(src: Uint8Array) {
    this.src = src;
    if (src.length >= 3 && src[0] === 0xef && src[1] === 0xbb && src[2] === 0xbf) this.off = 3;
  }

  syntaxError(): void {
    if (this.err === null) this.err = ERR_SYNTAX;
  }

  readByte(): number {
    let c = 0;
    if (this.off < this.src.length) {
      c = this.src[this.off++]!;
      this.buf.push(c);
      if (c === 0 && this.err === null) this.err = ERR_NUL;
    } else {
      this.eof = true;
    }
    return c;
  }

  readRest(): void {
    while (this.off < this.src.length) this.buf.push(this.src[this.off++]!);
    this.eof = true;
  }

  peekByte(skipSpace: boolean): number {
    if (this.err !== null) return 0;
    let c = this.peek;
    if (c === 0) c = this.readByte();
    while (this.err === null && !this.eof) {
      if (skipSpace) {
        // Semicolons are never necessary to understand the input here.
        if (c === 0x20 || c === 0x0c || c === 0x09 || c === 0x0d || c === NL || c === 0x3b) {
          c = this.readByte();
          continue;
        }
        if (c === SLASH) {
          c = this.readByte();
          if (c === SLASH) {
            while (c !== NL && this.err === null && !this.eof) c = this.readByte();
          } else if (c === STAR) {
            let c1 = 0;
            while ((c !== STAR || c1 !== SLASH) && this.err === null) {
              if (this.eof) this.syntaxError();
              c = c1;
              c1 = this.readByte();
            }
          } else {
            this.syntaxError();
          }
          c = this.readByte();
          continue;
        }
      }
      break;
    }
    this.peek = c;
    return this.peek;
  }

  nextByte(skipSpace: boolean): number {
    const c = this.peekByte(skipSpace);
    this.peek = 0;
    return c;
  }

  readKeyword(kw: string): void {
    this.peekByte(true);
    for (let i = 0; i < kw.length; i++) {
      if (this.nextByte(false) !== kw.charCodeAt(i)) {
        this.syntaxError();
        return;
      }
    }
    if (isIdent(this.peekByte(false))) this.syntaxError();
  }

  readIdent(): void {
    const c = this.peekByte(true);
    if (!isIdent(c)) {
      this.syntaxError();
      return;
    }
    while (isIdent(this.peekByte(false))) this.peek = 0;
  }

  readString(): void {
    const q = this.nextByte(true);
    if (q === 0x60) {
      while (this.err === null) {
        if (this.nextByte(false) === 0x60) break;
        if (this.eof) this.syntaxError();
      }
    } else if (q === 0x22) {
      while (this.err === null) {
        const c = this.nextByte(false);
        if (c === 0x22) break;
        if (this.eof || c === NL) this.syntaxError();
        if (c === 0x5c) this.nextByte(false);
      }
    } else {
      this.syntaxError();
    }
  }

  readImport(): void {
    const c = this.peekByte(true);
    if (c === 0x2e) this.peek = 0;
    else if (isIdent(c)) this.readIdent();
    this.readString();
  }
}

export interface RawHeader {
  /** The bytes go/build examines for constraints. */
  header: Uint8Array;
  /** A read error go/build reports, or null. */
  error: string | null;
}

/** Reads a Go file up to and including its import section. Never fails on syntax errors. */
export function readGoHeader(src: Uint8Array): RawHeader {
  const r = new ImportReader(src);
  r.readKeyword('package');
  r.readIdent();
  while (r.peekByte(true) === 0x69) {
    r.readKeyword('import');
    if (r.peekByte(true) === 0x28) {
      r.nextByte(false);
      while (r.peekByte(true) !== 0x29 && r.err === null) r.readImport();
      r.nextByte(false);
    } else {
      r.readImport();
    }
  }
  let header = r.buf;
  if (r.err === null && !r.eof) header = r.buf.slice(0, -1);
  if (r.err === ERR_SYNTAX) {
    r.err = null;
    r.readRest();
    header = r.buf;
  }
  return { header: Uint8Array.from(header), error: r.err };
}

/** Reads the leading block of comments in a non-Go source file. */
export function readCommentsHeader(src: Uint8Array): RawHeader {
  const r = new ImportReader(src);
  r.peekByte(true);
  if (r.err === null && !r.eof) r.buf.pop();
  return { header: Uint8Array.from(r.buf), error: r.err };
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

export function decodeBytes(b: Uint8Array): string {
  return decoder.decode(b);
}

function isGoBuildComment(line: string): boolean {
  if (!line.startsWith('//go:build')) return false;
  const trimmed = trimSpace(line);
  const rest = trimmed.slice('//go:build'.length);
  return rest.length === 0 || trimSpace(rest).length < rest.length;
}

export interface ParsedHeader {
  /** The part of the header a `// +build` line may appear in. */
  trimmed: string;
  /** The single `//go:build` line, trimmed, or null. */
  goBuild: string | null;
}

/** Thrown when a header holds more than one `//go:build` line. */
export const MULTIPLE_GO_BUILD = 'multiple //go:build comments';

/** Finds the `//go:build` line and the `// +build` region of a file header. */
export function parseFileHeader(content: string): ParsedHeader {
  let end = 0;
  let pos = 0;
  let ended = false;
  let inSlashStar = false;
  let goBuild: string | null = null;

  lines: while (pos < content.length) {
    let line: string;
    const nl = content.indexOf('\n', pos);
    if (nl >= 0) {
      line = content.slice(pos, nl);
      pos = nl + 1;
    } else {
      line = content.slice(pos);
      pos = content.length;
    }
    line = trimSpace(line);
    if (line.length === 0 && !ended) {
      end = pos;
      continue;
    }
    if (!line.startsWith('//')) ended = true;

    if (!inSlashStar && isGoBuildComment(line)) {
      if (goBuild !== null) throw new Error(MULTIPLE_GO_BUILD);
      goBuild = line;
    }

    while (line.length > 0) {
      if (inSlashStar) {
        const i = line.indexOf('*/');
        if (i >= 0) {
          inSlashStar = false;
          line = trimSpace(line.slice(i + 2));
          continue;
        }
        continue lines;
      }
      if (line.startsWith('//')) continue lines;
      if (line.startsWith('/*')) {
        inSlashStar = true;
        line = trimSpace(line.slice(2));
        continue;
      }
      break lines;
    }
  }
  return { trimmed: content.slice(0, end), goBuild };
}
