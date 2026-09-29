# go-build-constraints

Decides whether a Go source file is part of a build for a given GOOS, GOARCH and tag set, with the same result as `go/build.Context.MatchFile`, without Go installed.

```ts
import { matchFile } from 'go-build-constraints';

const src = '//go:build !linux && arm64\n\npackage cpu\n';
matchFile('cpu_other_arm64.go', src, { goos: 'android', goarch: 'arm64' });
// { match: false, error: null }   android implies the linux tag
matchFile('cpu_other_arm64.go', src, { goos: 'freebsd', goarch: 'arm64' });
// { match: true, error: null }
```

## Why

The rules are spread over several places in `go/build`: `//go:build` expressions, legacy `// +build` lines and the blank-line rule that goes with them, which comments count as the file header, file-name suffixes (`_linux.go`, `_windows_amd64_test.go`, but not `linux.go`), and implied tags (`android` satisfies `linux`, `illumos` satisfies `solaris`, `ios` satisfies `darwin`, `unix`, release tags, `gc`). Tools that read Go trees from JavaScript usually re-implement a subset of this.

The reference is the Go standard library, so the package is a port of its code paths (see How it works), and it is tested by running both on the same inputs.

Compared implementation: `@naxodev/gonx` 4.1.1 (`graph/static-analysis/build-constraints.js`), the build-constraint evaluator in the Nx Go plugin. The comparison uses only the inputs its API can express (`.go` files, no toolchain tags, no gccgo, no UseAllFiles). No other JavaScript or Python package that evaluates Go build constraints was found on npm or PyPI.

Measured: `node bench/measure.ts --gonx <path to gonx build-constraints.js>` against Go 1.27.1, decisions compared with `MatchFile`'s boolean result:

```
generated, all cases            go-build-constraints 30000/30000 = 100.00%
generated, .go + expressible    go-build-constraints 17100/17100 = 100.00%   gonx 13859/17100 = 81.05%
  ... excluding Go errors       go-build-constraints 14913/14913 = 100.00%   gonx 12766/14913 = 85.60%
real, all files, 15 contexts     go-build-constraints 27375/27375 = 100.00%
real, .go files, 12 contexts      go-build-constraints 18564/18564 = 100.00%   gonx 18074/18564 = 97.36%
real, per .go file (all 12 right)  go-build-constraints 1547/1547 = 100.00%   gonx 1293/1547 = 83.58%
```

Two runs printed identical numbers (the corpora are seeded). The generated corpus is deliberately adversarial (block comments, missing blank lines, malformed expressions, BOMs, CRLF, NUL bytes, Unicode tags, odd extensions), so the gonx figure there says little about typical files. The real corpus is every file of `golang.org/x/sys` v0.48.0, `x/crypto` v0.57.0 and `x/net` v0.59.0 under 15 contexts. Of gonx's 490 real-file disagreements, 155 are on android, 147 on ios and 125 on illumos (implied tags), and the rest are mostly the `gc` compiler tag and `//go:build` lines that use `!linux`-style negations. On the corpora from an earlier, independent measurement (20000 generated cases, 16852 real decisions) the same gonx version scores 94.39% and 97.89%; this package scores 100% on both.

## Installation

```sh
npm install go-build-constraints
```

Zero runtime dependencies. Node 20.6 or later.

## Usage

### Decide one file

```ts
import { matchFile, explainFile } from 'go-build-constraints';

const ctx = { goos: 'linux', goarch: 'arm64', cgo: true, buildTags: ['integration'] };

matchFile('zsyscall_linux_amd64.go', source, ctx);
// { match: false, error: null }

explainFile('cpu_gc_x86.go', source, ctx);
// { match: false, error: null, reason: 'go-build',
//   constraint: '(386 || amd64 || amd64p32) && gc', tags: ['386', 'amd64', 'amd64p32', 'gc'] }
```

`content` may be a string or a `Uint8Array`. Only the header of the file is read, as in Go.

### Parse and evaluate expressions

```ts
import { parse, parseExpr, evaluate, exprToString, plusBuildLines } from 'go-build-constraints';

evaluate('linux && (amd64 || arm64) && !cgo', ['linux', 'arm64']); // true
evaluate('// +build linux,amd64 darwin', ['darwin']);               // true

exprToString(parse('// +build linux,amd64 darwin')); // '(linux && amd64) || darwin'
plusBuildLines(parseExpr('linux && amd64'));          // ['// +build linux,amd64']
```

`evaluate` does no implied-tag handling. To evaluate against a full context, pass `tagMatcher(ctx)`.

### Use implied tags directly

```ts
import { evaluate, parseExpr, tagMatcher } from 'go-build-constraints';

evaluate(parseExpr('linux && !android'), tagMatcher({ goos: 'android', goarch: 'arm64' })); // false
```

### Command line

```sh
go-build-constraints --goos android --goarch arm64 --why cpu_linux_arm64.go cpu_linux.go cpu_other_arm64.go cpu_windows.go
```

```
included	cpu_linux_arm64.go	no-constraint
excluded	cpu_linux.go	go-build	!386 && !amd64 && !amd64p32 && !arm64
excluded	cpu_other_arm64.go	go-build	!darwin && !linux && !netbsd && !openbsd && !windows && arm64
excluded	cpu_windows.go	filename-mismatch
```

That output is from `golang.org/x/sys` v0.48.0, `cpu/` directory, exit code 1.

## Reference

### `matchFile(name, content, ctx)`

Returns `{ match: boolean, error: string | null }`, the pair `Context.MatchFile` returns. `name` is the base name. A read error (a NUL byte in the part of the file that is read) comes with `match: true`, as in Go. A malformed `//go:build` line or two `//go:build` lines come with `match: false`.

### `explainFile(name, content, ctx)`

Same decision plus the reason.

| Field | Type | Description |
| --- | --- | --- |
| `match` | boolean | Same as `matchFile`. |
| `error` | string or null | Same as `matchFile`. |
| `reason` | string | `ignored-name`, `unsupported-extension`, `filename-mismatch`, `go-build`, `plus-build`, `no-constraint`, `use-all-files` or `error`. |
| `constraint` | string or null | The `//go:build` expression as Go prints it, or the deciding `// +build` line(s). |
| `tags` | string[] | Tags consulted, in first-use order. |

### `BuildContext`

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `goos` | string | required | Target GOOS. |
| `goarch` | string | required | Target GOARCH. |
| `cgo` | boolean | `false` | Satisfies the `cgo` tag. |
| `compiler` | string | `'gc'` | Satisfies the compiler tag (`gc`, `gccgo`). |
| `buildTags` | string[] | `[]` | Extra tags, as with `-tags`. |
| `toolTags` | string[] | `[]` | Toolchain tags such as `goexperiment.arenas`, `amd64.v2`. |
| `goVersion` | number | `27` | Generates release tags `go1.1` through `go1.N`. |
| `releaseTags` | string[] | generated | Replaces the generated release tags. |
| `useAllFiles` | boolean | `false` | Never exclude a file for its name or constraints, like `UseAllFiles`. Malformed constraints are still errors. |

`boringcrypto` is an alias of `goexperiment.boringcrypto`, as in Go. `unix` is satisfied for the Unix GOOS values listed in `UNIX_OS`.

### Other functions

| Function | Description |
| --- | --- |
| `matchFileName(name, ctx)` | File-name rules only (`_GOOS`, `_GOARCH`, `_GOOS_GOARCH`, optional `_test`). |
| `matchTag(tag, ctx)` / `tagMatcher(ctx)` | One tag against a context, including implied tags. |
| `parse(line)` | Parses one `//go:build ...` or `// +build ...` line. Throws `ConstraintSyntaxError` (with `offset` in UTF-8 bytes) or `ConstraintError`. |
| `parseExpr(text)` | Parses the text after `//go:build`. |
| `parsePlusBuildExpr(text)` | Parses the text after `// +build`. Invalid words become the tag `ignore`, as in Go. |
| `evaluate(expr, tags)` | `expr` is an `Expr`, an expression string or a full line. `tags` is an iterable of tags or a predicate. |
| `evaluateExpr(expr, ok)` | Evaluates an `Expr` with a predicate. |
| `exprToString(expr)` | Prints in `//go:build` syntax, like `Expr.String()`. |
| `plusBuildLines(expr)` | `// +build` lines for an expression, like `constraint.PlusBuildLines`. Throws `ConstraintError` when too complex. |
| `isGoBuild(line)` / `isPlusBuild(line)` | Prefix checks. |
| `KNOWN_OS`, `KNOWN_ARCH`, `UNIX_OS` | The lists from Go 1.27's `internal/syslist`. |

### CLI

`go-build-constraints --goos <os> --goarch <arch> [options] <file>...`

| Flag | Description |
| --- | --- |
| `--goos`, `--goarch` | Required. |
| `--tags a,b` | Extra build tags. Repeatable. |
| `--tool-tags a,b` | Toolchain tags. Repeatable. |
| `--cgo` | Satisfy the `cgo` tag. |
| `--compiler name` | Compiler tag. Default `gc`. |
| `--go-version n` | Release tags `go1.1` through `go1.<n>`. Default 27. |
| `--all-files` | Like `UseAllFiles`. |
| `--why` | Add the reason and constraint columns. |
| `--json` | One JSON object per file. |
| `-q`, `--quiet` | No output. |

The verdict is decided from the file's base name and contents. Output is `included` or `excluded`, a tab, then the path as given.

| Exit code | Meaning |
| --- | --- |
| 0 | Every file is included. |
| 1 | At least one file is excluded. |
| 2 | Usage error, unreadable file, or a malformed constraint (reported on stderr; other files are still printed). |

## How it works

The code is a port of these parts of the Go 1.27 standard library:

- `go/build/constraint`: the `//go:build` parser (including the 1000-operand limit), the `// +build` parser (100-operator limit, invalid words to `ignore`), `Eval`, `String` and `PlusBuildLines`.
- `go/build`: `matchFile`, `shouldBuild`, `parseFileHeader`, `matchTag`, `goodOSArchFile`, and the byte-level `importReader` that decides how much of a file counts as its header (up to and including the imports, or the whole file after a syntax error).
- `internal/syslist`: the GOOS, GOARCH and Unix lists.

Derived files carry the Go Authors copyright line in their headers, and the Go license is shipped verbatim as `LICENSE-go`.

Each file goes through the same steps as `MatchFile`: ignore names starting with `_` or `.`; accept only `.go` and the extensions go/build treats as build inputs (`.s`, `.c`, `.h` and so on); apply the file-name rules; read the header; find the `//go:build` line (or fall back to `// +build` lines that sit above a blank line); evaluate against the context.

## Limitations

- Only what `MatchFile` decides. It does not resolve imports, read `go.mod`, or apply `#cgo` directives.
- Toolchain tags are never derived. `amd64.v2`, `arm64.v8.0`, `goexperiment.*` and similar come from the Go toolchain's environment, so pass them as `toolTags`.
- `goVersion` defaults to 27, the release the port was made from. Pass another value to model a different toolchain. The GOOS and GOARCH lists are Go 1.27's; a newer Go may add entries.
- The context has no defaults for `goos` and `goarch`. The package does not read the host or `GOOS` and `GOARCH` environment variables.
- Unicode letter and digit tests (tag characters) use the JavaScript engine's Unicode tables, Go uses its own. The generated corpus includes non-ASCII tags and they agreed, but a code point added in one table and not the other would differ.
- Error messages match Go's for constraint errors and the read errors go/build produces here. The path prefix Go prepends to read errors (`read /dir/name:`) is omitted.
- Files with names go/build skips are reported as excluded with a reason; there is no directory walking.

## Compatibility

- Node 24 on macOS (arm64): type checks, the TypeScript suite, and the built package's smoke tests, all run.
- Oracle: Go 1.27.1 (darwin/arm64).
- Node 20.6 and 22: the CI workflow runs `test/smoke.mjs` against the built package there. Not run locally.
- Linux and Windows: not run.

## Development

```sh
npm install
npx tsc --noEmit
npm test                       # TypeScript suite; Go tests skip loudly if go is absent
npm run build && npm run test:dist
node bench/measure.ts          # agreement with Go (needs Go and network access)
```

`scripts/oracle` is a small Go program (its own `go.mod`) that answers `MatchFile`, `constraint.Parse`, `Eval` and `PlusBuildLines` queries as JSON. The differential tests build it into `.cache/` and compare every result: 30000 generated file cases and 6000 generated constraint lines, then every file of pinned `x/sys`, `x/crypto` and `x/net` trees under 15 contexts. The real trees are downloaded at test time from GitHub archives pinned to a commit, verified by sha256 of the unpacked tar, and kept in the gitignored `.cache/`.

## License

MIT. See [LICENSE](LICENSE). Portions derived from the Go standard library are under the BSD 3-clause license in [LICENSE-go](LICENSE-go).
