/** Offline candidate builder. Reads an unchanged source home and writes only a new output directory. */
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, stat, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep, dirname, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { WorkflowLibrary, workflowLibraryDomain } from '../dsh/packages/workflow/lyagent-workflow-library/src/store.ts';
import { migratePlan } from '../dsh/packages/workflow/lyagent-workflow-library/src/migration.ts';
import { KnowledgeStore, knowledgeDomain } from '../dsh/packages/context/lyagent-knowledge/src/store.ts';
import { TeamLibrary, teamLibraryDomain } from '../dsh/packages/workflow/lyagent-workflow-library/src/team.ts';

const { values } = parseArgs({ options: {
  source: { type: 'string' }, plans: { type: 'string' }, agent: { type: 'string' }, output: { type: 'string' },
} });
if (!values.source || !values.plans || !values.agent) throw Error('Required: --source <home> --plans <bundle.json> --agent <actual agent.id>; optional --output <new candidate directory>. Without output this is a dry run.');
const source = await realpath(resolve(values.source));
const output = values.output ? join(await realpath(dirname(resolve(values.output))), basename(resolve(values.output))) : undefined;
if (output) {
  const inside = relative(source, output);
  if (!inside || (!(inside === '..' || inside.startsWith(`..${sep}`)) && !isAbsolute(inside))) throw Error('Output must be outside the source home.');
  try { await stat(output); throw Error('Output already exists; choose a new candidate directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const captured = new Map();
async function document(name, fallback) {
  const filename = join(source, 'storages', `${name}.json`);
  let bytes;
  try { bytes = await readFile(filename); } catch (error) { if (error.code !== 'ENOENT' || !fallback) throw error; }
  captured.set(filename, bytes);
  return bytes ? JSON.parse(bytes.toString('utf8')) : { unit: { name, version: 1 }, global: null, tables: fallback };
}
function table(doc, domain, key) {
  if (doc.unit.name !== domain.name || doc.unit.version !== domain.version) throw Error(`Wrong storage unit: ${doc.unit.name}`);
  const records = doc.tables[key];
  for (const value of Object.values(records)) domain.tables[key].valueSchema.parse(value);
  return {
    get: id => records[id] === undefined ? undefined : domain.tables[key].valueSchema.parse(records[id]),
    entries: () => Object.entries(records).map(([id, value]) => [id, domain.tables[key].valueSchema.parse(value)]),
    put: async (id, value) => { records[id] = domain.tables[key].valueSchema.parse(value); },
    update: async (id, fn) => { records[id] = domain.tables[key].valueSchema.parse(fn(records[id])); },
  };
}
const workflows = await document('lyagent_workflow_library');
const knowledge = await document('lyagent_knowledge', { collections: {}, grants: {} });
const teams = await document('lyagent_team_library', { definitions: {} });
const before = structuredClone(workflows);
const bundleBytes = await readFile(resolve(values.plans));
captured.set(resolve(values.plans), bundleBytes);
const bundle = JSON.parse(bundleBytes.toString('utf8'));
if (bundle.format !== 1 || !Array.isArray(bundle.workflows) || !Array.isArray(bundle.collections) ||
  !Number.isInteger(bundle.maxParallelNodes) || bundle.maxParallelNodes < 1 || bundle.maxParallelNodes > 32) throw Error('Unsupported migration bundle.');
if (new Set(bundle.collections.map(item => item.id)).size !== bundle.collections.length) throw Error('Duplicate collection identities.');
const limits = bundle.limits;
if (!limits || ['maxDefinitionBytes', 'maxEntries', 'maxCollectionBytes', 'maxResultBytes', 'maxMatches', 'maxLineChars']
  .some(key => !Number.isSafeInteger(limits[key]) || limits[key] < 1)) throw Error('Bundle must declare positive safe integer deployment limits.');
const library = new WorkflowLibrary(table(workflows, workflowLibraryDomain, 'definitions'), limits.maxDefinitionBytes, limits.maxEntries);
const teamLibrary = new TeamLibrary(table(teams, teamLibraryDomain, 'definitions'), limits.maxDefinitionBytes, limits.maxEntries);
const store = new KnowledgeStore(table(knowledge, knowledgeDomain, 'collections'), table(knowledge, knowledgeDomain, 'grants'),
  limits);
const identities = bundle.workflows.map(row => row.plan.id);
if (new Set(identities).size !== identities.length) throw Error('Duplicate migration identities.');
if (Object.keys(workflows.tables.definitions).some(id => !identities.includes(id))) throw Error('Bundle does not cover the complete source workflow catalog.');
for (const item of bundle.collections) {
  const record = knowledge.tables.collections[item.id];
  if (record) {
    const sources = record.editions.find(edition => edition.version === item.version)?.sources;
    if (!sources || record.editions.length !== item.version || record.archived ||
      JSON.stringify(sources.map(({ id, title, text }) => ({ id, title, text }))) !== JSON.stringify(item.sources)) {
      throw Error(`Knowledge collection conflicts with reviewed migration: ${item.id}`);
    }
  } else {
    if (item.version !== 1) throw Error('A new migration collection must start at version 1.');
    await store.publish(item.id, item.title, item.sources);
  }
}
const previousPins = knowledge.tables.grants[values.agent]?.pins ?? [];
const pins = new Map(previousPins.map(pin => [pin.collection, pin]));
for (const item of bundle.collections) pins.set(item.id, { collection: item.id, version: item.version });
await store.grant(values.agent, [...pins.values()]);
const authorize = edition => {
  if (edition.knowledge.some(pin => !store.authorized(values.agent, pin.collection, pin.version))) throw Error('Candidate knowledge authorization is incomplete.');
};
const results = [];
for (const request of bundle.workflows) {
  const result = await migratePlan(library, request, (id, version) => teamLibrary.read(id, version), bundle.maxParallelNodes,
    (collection, version, query) => store.search(values.agent, collection, version, query).matches, authorize, false);
  results.push({ id: result.id, state: !output && result.state === 'committed' ? 'proposed' : result.state, sourceVersion: request.sourceVersion, sourceSha256: request.sourceSha256,
    equivalence: 'reviewed replacement; original plan unavailable', edition: result.edition });
}
for (const [id, history] of Object.entries(before.tables.definitions)) {
  const retained = workflows.tables.definitions[id].editions.slice(0, history.editions.length);
  // Preserve even absent historical fields byte-for-byte at the JSON-value level.
  workflows.tables.definitions[id].editions.splice(0, retained.length, ...history.editions);
}
const report = { format: 1, state: output ? 'candidate' : 'dry-run', source, agent: values.agent,
  deployment: 'not performed', limits, maxParallelNodes: bundle.maxParallelNodes, results, grants: [...pins.values()],
  inputs: [...captured].map(([filename, bytes]) => ({ filename, sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null })) };
// Source consistency is checked after all compilation and before any output is created.
for (const [filename, bytes] of captured) {
  let now;
  try { now = await readFile(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes ? !now || !bytes.equals(now) : now !== undefined) throw Error('Source changed while preparing the candidate; retry from a stable snapshot.');
}
if (output) {
  await mkdir(output); // Exclusive directory creation: never resume or merge a partial candidate.
  await mkdir(join(output, 'storages'));
  const files = {};
  for (const [name, doc] of [['lyagent_workflow_library', workflows], ['lyagent_knowledge', knowledge], ['lyagent_team_library', teams]]) {
    const body = JSON.stringify(doc, null, 1);
    files[`storages/${name}.json`] = createHash('sha256').update(body).digest('hex');
    await writeFile(join(output, 'storages', `${name}.json`), body, { flag: 'wx' });
  }
  await writeFile(join(output, 'migration-report.json'), JSON.stringify(report, null, 1), { flag: 'wx' });
  // Only a directory with this final marker is a complete candidate. Interrupted directories are never deployed.
  await writeFile(join(output, 'READY.json'), JSON.stringify({ files, reportSha256: createHash('sha256').update(JSON.stringify(report, null, 1)).digest('hex') }), { flag: 'wx' });
}
await library.close();
await teamLibrary.close();
console.log(JSON.stringify(report, null, 1));
