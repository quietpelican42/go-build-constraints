// Derived from the Go standard library, internal/syslist/syslist.go (Go 1.27).
// Copyright 2011 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be found
// in LICENSE-go.

/** Past, present and future GOOS values. Used for file-name matching. */
export const KNOWN_OS: ReadonlySet<string> = new Set([
  'aix',
  'android',
  'darwin',
  'dragonfly',
  'freebsd',
  'hurd',
  'illumos',
  'ios',
  'js',
  'linux',
  'nacl',
  'netbsd',
  'openbsd',
  'plan9',
  'solaris',
  'wasip1',
  'windows',
  'zos',
]);

/** GOOS values matched by the `unix` build tag. Not used for file names. */
export const UNIX_OS: ReadonlySet<string> = new Set([
  'aix',
  'android',
  'darwin',
  'dragonfly',
  'freebsd',
  'hurd',
  'illumos',
  'ios',
  'linux',
  'netbsd',
  'openbsd',
  'solaris',
]);

/** Past, present and future GOARCH values. Used for file-name matching. */
export const KNOWN_ARCH: ReadonlySet<string> = new Set([
  '386',
  'amd64',
  'amd64p32',
  'arm',
  'armbe',
  'arm64',
  'arm64be',
  'loong64',
  'mips',
  'mipsle',
  'mips64',
  'mips64le',
  'mips64p32',
  'mips64p32le',
  'ppc',
  'ppc64',
  'ppc64le',
  'riscv',
  'riscv64',
  's390',
  's390x',
  'sparc',
  'sparc64',
  'wasm',
]);
