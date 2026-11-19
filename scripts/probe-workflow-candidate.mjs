/** Keyless VM counterexamples against a complete candidate, including nested retry classification. */
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { compilePlan } from '../dsh/packages/workflow/lyagent-workflow-library/src/plan.ts';
const candidate = resolve(process.argv[2] ?? '');
const doc = JSON.parse(await readFile(join(candidate, 'storages/lyagent_workflow_library.json'), 'utf8'));
const latest = id => doc.tables.definitions[id].editions.at(-1);
const run = (script, agent) => runInNewContext(`(async () => {${script}\n})()`, { agent, phase: () => {}, log: () => {} });
const outer = id => compilePlan({ id: 'counterexample', expectedVersion: 0, description: 'Nested retry probe', nodes: [
  { id: 'call', kind: 'saved', dependsOn: [], retry: 3, workflow: { id, version: latest(id).version } },
] }, id => latest(id), undefined, 2).script;
const rows = [];
for (const mode of ['null-then-good', 'all-null', 'abort']) {
  let calls = 0;
  await assert.rejects(run(outer('retry-probe'), async () => {
    calls += 1;
    if (mode === 'abort') throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    return mode === 'null-then-good' && calls > 1 ? 'GOOD' : null;
  }));
  assert.equal(calls, 1);
  rows.push({ mode, status: 'error', calls });
}
let calls = 0;
await assert.rejects(run(outer('verify-probe'), async () => { calls += 1; return 'BAD'; }));
assert.equal(calls, 3);
rows.push({ mode: 'verification-bad', status: 'error', calls });
for (const id of Object.keys(doc.tables.definitions)) {
  let active = 0;
  let peak = 0;
  let calls = 0;
  await run(latest(id).script, async (_prompt, route) => {
    assert.equal(route.provider, 'deepseek-official');
    assert.equal(route.model, 'deepseek-flash');
    active += 1; peak = Math.max(peak, active); calls += 1;
    await Promise.resolve(); active -= 1;
    return '投影仪 SC-1007 已与台账一致。'.repeat(8);
  });
  assert.ok(peak <= 2);
  rows.push({ id, status: 'success', calls, peak });
}
console.log(JSON.stringify({ candidate, modelRequests: 0, execution: 'VM fixture, not real business verification', rows }, null, 1));
