/**
 * Real-file differential test. Fetches golang.org/x/sys, x/crypto and x/net at
 * pinned commits (never committed; cached in .cache/), then asks the Go oracle
 * and this package about every file under every context in SWEEP.
 * Skipped, loudly, without Go or network access.
 */
import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import { explainFile } from '../src/index.ts';
import { SWEEP } from './corpus.ts';
import { ctxToOracle, goVersion, oracleUnavailable, runOracle } from './oracle-util.ts';
import { PINS, fetchPin, readBytes, walk } from './real-util.ts';

const skipGo = oracleUnavailable();
if (skipGo) console.warn(`\n*** SKIPPING real-file differential test: ${skipGo}\n`);

test('go/build MatchFile: pinned x/sys, x/crypto, x/net files under every context', { skip: skipGo ?? false, timeout: 600_000 }, async (t) => {
  let files = 0;
  let decisions = 0;
  let goFiles = 0;
  let goDecisions = 0;
  let included = 0;
  let filesWithDisagreement = 0;
  const bad: string[] = [];
  let ran = 0;
  for (const pin of PINS) {
    const f = await fetchPin(pin);
    if ('skip' in f) {
      console.warn(`\n*** SKIPPING ${pin.name}: ${f.skip}\n`);
      continue;
    }
    ran++;
    const rels = walk(f.dir);
    const want = runOracle([{ op: 'tree', root: f.dir, ctxs: SWEEP.map(ctxToOracle) }]);
    assert.equal(want.length, rels.length * SWEEP.length, `oracle walked a different file set for ${pin.name}`);
    const byKey = new Map(want.map((w) => [`${w.ctx}|${w.path}`, w]));
    const wrong = new Set<string>();
    for (const rel of rels) {
      const bytes = readBytes(join(f.dir, rel));
      const ext = rel.slice(rel.lastIndexOf('.'));
      const considered = ['.go', '.c', '.cc', '.cpp', '.cxx', '.m', '.h', '.hh', '.hpp', '.hxx', '.f', '.F', '.for', '.f90', '.s', '.S', '.sx', '.swig', '.swigcxx', '.syso'].includes(ext);
      files++;
      if (considered) goFiles++;
      SWEEP.forEach((ctx, i) => {
        const w = byKey.get(`${i}|${rel}`);
        assert.ok(w, `missing oracle record for ${rel}`);
        const got = explainFile(basename(rel), bytes, ctx);
        decisions++;
        if (considered) goDecisions++;
        if (w.match) included++;
        const abs = join(f.dir, dirname(rel), basename(rel));
        const wantErr = String(w.err).replaceAll(abs, basename(rel));
        if (got.match !== w.match || (got.error ?? '') !== wantErr) {
          wrong.add(rel);
          bad.push(`${pin.name}/${rel} ${ctx.goos}/${ctx.goarch}: go=${w.match} ${w.err} js=${got.match} ${got.error ?? ''}`);
        }
      });
    }
    filesWithDisagreement += wrong.size;
  }
  if (ran === 0) {
    t.skip('no pinned tree could be fetched (see warnings above)');
    return;
  }
  console.log(
    `# ${goVersion()}: ${ran} trees, ${files} files (${goFiles} Go-buildable extensions), ${SWEEP.length} contexts, ` +
      `${decisions} decisions (${goDecisions} on Go-buildable files, ${included} included), ` +
      `${bad.length} disagreements in ${filesWithDisagreement} files`,
  );
  assert.equal(bad.length, 0, `disagreements:\n${bad.slice(0, 10).join('\n')}`);
});
