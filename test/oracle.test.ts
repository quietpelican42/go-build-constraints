/**
 * Differential tests against the real Go standard library. The Go oracle
 * (scripts/oracle) calls go/build.Context.MatchFile and go/build/constraint;
 * every case must agree exactly. Skipped, loudly, when Go is not installed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConstraintError,
  evaluateExpr,
  exprToString,
  parse,
  plusBuildLines,
  matchFile,
  type Expr,
} from '../src/index.ts';
import { SWEEP, matchCases, parseCases } from './corpus.ts';
import { ctxToOracle, goVersion, oracleUnavailable, runOracle } from './oracle-util.ts';

const skip = oracleUnavailable();
if (skip) console.warn(`\n*** SKIPPING Go oracle differential tests: ${skip}\n`);

const N_MATCH = 30000;
const N_PARSE = 6000;

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

test('go/build MatchFile: generated headers, names and contexts', { skip: skip ?? false }, () => {
  const cases = matchCases(20260929, N_MATCH);
  const want = runOracle(
    cases.map((c) => ({ op: 'match', id: c.id, name: c.name, contentB64: b64(c.content), ctx: ctxToOracle(c.ctx) })),
  );
  assert.equal(want.length, cases.length);
  const bad: string[] = [];
  let included = 0;
  let errors = 0;
  const contexts = new Set<string>();
  for (const c of cases) {
    const w = want[c.id]!;
    const got = matchFile(c.name, c.content, c.ctx);
    contexts.add(`${c.ctx.goos}/${c.ctx.goarch}`);
    if (w.match) included++;
    if (w.err) errors++;
    const wantErr = String(w.err).replace('/d/', '');
    if (got.match !== w.match || (got.error ?? '') !== wantErr) {
      bad.push(JSON.stringify({ c, go: { match: w.match, err: w.err }, js: got }));
    }
  }
  console.log(
    `# ${goVersion()}: ${cases.length} match cases, ${contexts.size} goos/goarch pairs, ` +
      `${included} included, ${cases.length - included} excluded, ${errors} with errors, ${bad.length} disagreements`,
  );
  assert.equal(bad.length, 0, `disagreements:\n${bad.slice(0, 5).join('\n')}`);
});

function plusFor(x: Expr): { lines?: string[]; err?: string } {
  try {
    return { lines: plusBuildLines(x) };
  } catch (e) {
    if (e instanceof ConstraintError) return { err: e.message };
    throw e;
  }
}

test('go/build/constraint: parse, String, Eval, PlusBuildLines', { skip: skip ?? false }, () => {
  const cases = parseCases(424242, N_PARSE);
  const want = runOracle(cases.map((c) => ({ op: 'parse', id: c.id, line: c.line, tagSets: c.tagSets })));
  const bad: string[] = [];
  let parsed = 0;
  let plusOk = 0;
  for (const c of cases) {
    const w = want[c.id]!;
    let got: Record<string, unknown>;
    try {
      const x = parse(c.line);
      const p = plusFor(x);
      got = {
        str: exprToString(x),
        plus: p.lines ?? null,
        plusErr: p.err ?? '',
        evals: c.tagSets.map((s) => evaluateExpr(x, (t) => s.includes(t))),
      };
    } catch (e) {
      got = { err: (e as Error).message };
    }
    const exp = w.err !== undefined ? { err: w.err } : { str: w.str, plus: w.plus ?? null, plusErr: w.plusErr, evals: w.evals };
    if (w.err === undefined) parsed++;
    if (w.err === undefined && !w.plusErr) plusOk++;
    if (JSON.stringify(got) !== JSON.stringify(exp)) bad.push(JSON.stringify({ line: c.line, go: exp, js: got }));
  }
  console.log(`# ${cases.length} parse cases, ${parsed} parsed, ${plusOk} converted to +build, ${bad.length} disagreements`);
  assert.equal(bad.length, 0, `disagreements:\n${bad.slice(0, 5).join('\n')}`);
});

test('sanity: a plain constraint separates the sweep contexts', () => {
  // A negative control: the sweep must produce both outcomes for a plain constraint.
  const yes = matchFile('a.go', '//go:build linux\n\npackage a\n', SWEEP[0]!);
  const no = matchFile('a.go', '//go:build linux\n\npackage a\n', SWEEP[3]!);
  assert.deepEqual([yes.match, no.match], [true, false]);
});
