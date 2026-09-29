import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';

import { DEFAULT_GO_VERSION, explainFile, type BuildContext, type FileDecision } from './match.ts';

const HELP = `Usage: go-build-constraints --goos <os> --goarch <arch> [options] <file>...

Decides, for each Go source file, whether go/build would include it in a build.

Options:
  --goos <os>          target GOOS (required)
  --goarch <arch>      target GOARCH (required)
  --tags <a,b>         extra build tags (repeatable)
  --tool-tags <a,b>    toolchain tags, e.g. goexperiment.arenas,amd64.v2 (repeatable)
  --cgo                satisfy the cgo tag
  --compiler <name>    compiler tag (default gc)
  --go-version <n>     generate release tags go1.1 through go1.<n> (default ${DEFAULT_GO_VERSION})
  --all-files          include every file, like go/build UseAllFiles
  --why                print the reason and the deciding constraint
  --json               print one JSON object per file
  -q, --quiet          print nothing, only set the exit code
  -h, --help           show this help

Exit codes: 0 every file included, 1 at least one file excluded,
2 usage error, unreadable file, or a malformed constraint.
`;

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  read: (path: string) => Uint8Array;
}

const defaultIO: CliIO = {
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
  read: (p) => readFileSync(p),
};

function splitList(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
}

/** Runs the CLI and returns the exit code. */
export function runCli(argv: string[], io: CliIO = defaultIO): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        goos: { type: 'string' },
        goarch: { type: 'string' },
        tags: { type: 'string', multiple: true },
        'tool-tags': { type: 'string', multiple: true },
        cgo: { type: 'boolean' },
        compiler: { type: 'string' },
        'go-version': { type: 'string' },
        'all-files': { type: 'boolean' },
        why: { type: 'boolean' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    io.err(`go-build-constraints: ${(e as Error).message}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(HELP);
    return 0;
  }
  if (!values.goos || !values.goarch) {
    io.err('go-build-constraints: --goos and --goarch are required\n');
    return 2;
  }
  if (positionals.length === 0) {
    io.err('go-build-constraints: no files given\n');
    return 2;
  }
  let goVersion: number | undefined;
  if (values['go-version'] !== undefined) {
    if (!/^\d+$/.test(values['go-version'])) {
      io.err('go-build-constraints: --go-version must be a non-negative integer\n');
      return 2;
    }
    goVersion = Number(values['go-version']);
  }
  const ctx: BuildContext = {
    goos: values.goos,
    goarch: values.goarch,
    cgo: values.cgo ?? false,
    buildTags: splitList(values.tags),
    toolTags: splitList(values['tool-tags']),
    useAllFiles: values['all-files'] ?? false,
  };
  if (values.compiler) ctx.compiler = values.compiler;
  if (goVersion !== undefined) ctx.goVersion = goVersion;

  let excluded = false;
  let failed = false;
  for (const path of positionals) {
    let d: FileDecision;
    try {
      d = explainFile(basename(path), io.read(path), ctx);
    } catch (e) {
      failed = true;
      io.err(`go-build-constraints: ${path}: ${(e as Error).message}\n`);
      continue;
    }
    if (d.error !== null) {
      failed = true;
      io.err(`go-build-constraints: ${path}: ${d.error}\n`);
      continue;
    }
    if (!d.match) excluded = true;
    if (values.quiet) continue;
    if (values.json) {
      io.out(`${JSON.stringify({ path, ...d })}\n`);
    } else {
      const verdict = d.match ? 'included' : 'excluded';
      const why = values.why ? `\t${d.reason}${d.constraint !== null ? `\t${d.constraint.replaceAll('\n', '; ')}` : ''}` : '';
      io.out(`${verdict}\t${path}${why}\n`);
    }
  }
  return failed ? 2 : excluded ? 1 : 0;
}
