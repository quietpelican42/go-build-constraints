/**
 * Measures agreement with go/build's MatchFile on the generated corpus and on
 * the pinned real files. Needs Go on PATH.
 *
 *   node bench/measure.ts [--gonx <path to @naxodev/gonx build-constraints.js>]
 *
 * With --gonx, the same decisions are also measured for that evaluator (it is
 * loaded from the given path; this package does not depend on it). Only cases
 * its API can express are compared: .go files, no toolchain tags, no gccgo,
 * no UseAllFiles.
 */
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';

import { explainFile, type BuildContext } from '../src/index.ts';
import { SWEEP, matchCases } from '../test/corpus.ts';
import { ctxToOracle, goVersion, oracleUnavailable, runOracle } from '../test/oracle-util.ts';
import { PINS, fetchPin, readBytes, walk } from '../test/real-util.ts';

const why = oracleUnavailable();
if (why) {
  console.error(why);
  process.exit(2);
}

type Decide = (name: string, bytes: Uint8Array, ctx: BuildContext) => boolean;
const mine: Decide = (name, bytes, ctx) => explainFile(name, bytes, ctx).match;

const gi = process.argv.indexOf('--gonx');
let gonx: Decide | null = null;
if (gi > 0) {
  const lib = createRequire(import.meta.url)(resolve(process.argv[gi + 1]!)) as {
    shouldIncludeFile(content: string, ctx: unknown): boolean;
    shouldIncludeFilename(name: string, ctx: unknown): boolean;
  };
  gonx = (name, bytes, ctx) => {
    const c = { goos: ctx.goos, goarch: ctx.goarch, tags: new Set(ctx.buildTags ?? []), cgoEnabled: ctx.cgo ?? false, goVersion: `1.${ctx.goVersion ?? 27}` };
    return lib.shouldIncludeFilename(name, c) && lib.shouldIncludeFile(new TextDecoder().decode(bytes), c);
  };
}

const expressible = (name: string, ctx: BuildContext): boolean =>
  name.endsWith('.go') && !ctx.toolTags?.length && !ctx.compiler && !ctx.useAllFiles;

const pct = (a: number, b: number): string => `${a}/${b} = ${((100 * a) / b).toFixed(2)}%`;

console.log(`oracle: ${goVersion()}`);

// Generated corpus.
{
  const cases = matchCases(20260929, 30000);
  const want = runOracle(cases.map((c) => ({ op: 'match', id: c.id, name: c.name, contentB64: Buffer.from(c.content).toString('base64'), ctx: ctxToOracle(c.ctx) })));
  const enc = new TextEncoder();
  const tally = (decide: Decide, only: (c: (typeof cases)[number]) => boolean): [number, number] => {
    let ok = 0;
    let n = 0;
    for (const c of cases) {
      if (!only(c)) continue;
      n++;
      if (decide(c.name, enc.encode(c.content), c.ctx) === want[c.id]!.match) ok++;
    }
    return [ok, n];
  };
  const [a, an] = tally(mine, () => true);
  console.log(`generated, all cases            go-build-constraints ${pct(a, an)}`);
  if (gonx) {
    const ex = (c: (typeof cases)[number]): boolean => expressible(c.name, c.ctx);
    const noErr = (c: (typeof cases)[number]): boolean => ex(c) && !want[c.id]!.err;
    const [m1, n1] = tally(mine, ex);
    const [g1, g1n] = tally(gonx, ex);
    console.log(`generated, .go + expressible    go-build-constraints ${pct(m1, n1)}   gonx ${pct(g1, g1n)}`);
    const [m2, n2] = tally(mine, noErr);
    const [g2, g2n] = tally(gonx, noErr);
    console.log(`  ... excluding Go errors       go-build-constraints ${pct(m2, n2)}   gonx ${pct(g2, g2n)}`);
  }
}

// Real files.
{
  const ctxs = SWEEP.map((c, i) => ({ c, i })).filter(({ c }) => expressible('x.go', c));
  const stat = { mineOk: 0, gonxOk: 0, n: 0, allOk: 0, gonxAllOk: 0, files: 0, mineAllOk: 0 };
  const all = { ok: 0, n: 0 };
  for (const pin of PINS) {
    const f = await fetchPin(pin);
    if ('skip' in f) {
      console.error(`skipped ${pin.name}: ${f.skip}`);
      continue;
    }
    const want = runOracle([{ op: 'tree', root: f.dir, ctxs: SWEEP.map(ctxToOracle) }]);
    const byKey = new Map(want.map((w) => [`${w.ctx}|${w.path}`, w.match as boolean]));
    for (const rel of walk(f.dir)) {
      const bytes = readBytes(join(f.dir, rel));
      const name = basename(rel);
      for (let i = 0; i < SWEEP.length; i++) {
        all.n++;
        if (mine(name, bytes, SWEEP[i]!) === byKey.get(`${i}|${rel}`)) all.ok++;
      }
      if (!rel.endsWith('.go')) continue;
      stat.files++;
      let fm = true;
      let fg = true;
      for (const { c, i } of ctxs) {
        stat.n++;
        const w = byKey.get(`${i}|${rel}`);
        if (mine(name, bytes, c) === w) stat.mineOk++;
        else fm = false;
        if (gonx) {
          if (gonx(name, bytes, c) === w) stat.gonxOk++;
          else fg = false;
        }
      }
      if (fm) stat.mineAllOk++;
      if (fg) stat.gonxAllOk++;
    }
  }
  console.log(`real, all files, ${SWEEP.length} contexts     go-build-constraints ${pct(all.ok, all.n)}`);
  console.log(`real, .go files, ${ctxs.length} contexts      go-build-constraints ${pct(stat.mineOk, stat.n)}` + (gonx ? `   gonx ${pct(stat.gonxOk, stat.n)}` : ''));
  console.log(`real, per .go file (all ${ctxs.length} right)  go-build-constraints ${pct(stat.mineAllOk, stat.files)}` + (gonx ? `   gonx ${pct(stat.gonxAllOk, stat.files)}` : ''));
}
