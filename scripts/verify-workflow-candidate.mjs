/** Verify the immutable files of an offline candidate before rehearsal or deployment review. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { candidate: { type: 'string' } } });
if (!values.candidate) throw Error('Required: --candidate <directory>.');
const root = resolve(values.candidate);
const ready = JSON.parse(await readFile(join(root, 'READY.json'), 'utf8'));
const expected = ['storages/lyagent_workflow_library.json', 'storages/lyagent_knowledge.json', 'storages/lyagent_team_library.json'];
if (!ready.files || JSON.stringify(Object.keys(ready.files).sort()) !== JSON.stringify(expected.sort())) throw Error('Candidate file inventory differs.');
for (const name of expected) {
  const body = await readFile(join(root, name));
  if (createHash('sha256').update(body).digest('hex') !== ready.files[name]) throw Error(`Candidate hash differs: ${name}`);
}
const body = await readFile(join(root, 'migration-report.json'));
if (createHash('sha256').update(body).digest('hex') !== ready.reportSha256) throw Error('Candidate report hash differs.');
const report = JSON.parse(body.toString('utf8'));
if (report.state !== 'candidate' || report.deployment !== 'not performed') throw Error('Invalid candidate state.');
console.log(JSON.stringify({ state: 'verified', candidate: root, files: expected.length, workflows: report.results.length, agent: report.agent }));
