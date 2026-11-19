/** Human-authored bounded dependency plans compiled into one native workflow run. */
import { z } from 'zod'
import { WorkflowLibraryError } from './store.ts'
import type { WorkflowEdition } from './store.ts'
import type { TeamEdition } from './team.ts'

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
const reference = z.object({ id: identifier, version: z.number().int().positive() }).strict()
const knowledgeRef = z.object({
  collection: identifier, version: z.number().int().positive(), query: z.string().trim().min(1).max(200),
}).strict()
const base = { id: identifier, dependsOn: z.array(identifier).max(32), retry: z.number().int().min(1).max(3).default(1) }
// Only nodes that run a model can consume retrieved excerpts; every other kind rejects the field.
const withKnowledge = <T extends z.ZodRawShape>(extra: T):
z.ZodObject<T & typeof base & { knowledge: z.ZodOptional<typeof knowledgeRef> }> =>
  z.object({ ...base, ...extra, knowledge: knowledgeRef.optional() })
const node = z.discriminatedUnion('kind', [
  withKnowledge({ kind: z.literal('role'), team: reference, role: identifier,
    prompt: z.string().trim().min(1).max(16000) }).strict(),
  withKnowledge({ kind: z.literal('agent'), prompt: z.string().trim().min(1).max(16000),
    provider: z.string().trim().min(1).max(200), model: z.string().trim().min(1).max(200) }).strict(),
  z.object({ ...base, kind: z.literal('saved'), workflow: reference }).strict(),
  z.object({ ...base, kind: z.literal('repeat'), count: z.number().int().min(1).max(8), workflow: reference }).strict(),
  z.object({ ...base, kind: z.literal('check'), rework: identifier.optional(),
    attempts: z.number().int().min(1).max(3).optional(), expect: z.object({
      mustContain: z.array(z.string().min(1).max(200)).max(8).default([]),
      mustNotContain: z.array(z.string().min(1).max(200)).max(8).default([]),
      mustMatch: z.array(z.string().min(1).max(300)).max(4).optional(),
      minLength: z.number().int().min(0).max(200000).default(0),
    }).strict() }).strict(),
  z.object({ ...base, kind: z.literal('branch'), source: identifier, path: z.array(z.string().min(1).max(80)).max(8),
    equals: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]),
    then: reference, otherwise: reference }).strict(),
])
/** Strict human plan input; each explicit dependency forms a directed edge. */
export const planPublicationSchema = z.object({ id: identifier, expectedVersion: z.number().int().nonnegative(),
  description: z.string().trim().min(1).max(1000), nodes: z.array(node).min(1).max(32) }).strict()

function knowledgeBlock(matches: readonly { readonly title: string; readonly text: string }[]): string {
  if (matches.length === 0) return ''
  const lines = matches.map(match => '- (' + match.title + ') ' + match.text).join('\n')
  return 'Knowledge excerpts:\n' + lines + '\n\n'
}

/** Compile a DAG and embed exact saved editions without changing native execution policy.
 * @param input - parsed human plan, including explicit routes and bounded loop counts.
 * @param read - exact-version lookup owned by the caller's saved library.
 * @param readTeam - exact team/profile lookup; omission rejects role nodes.
 * @param maxParallel - maximum simultaneous node invocations in each dependency layer.
 * @param searchKnowledge - authorized lexical reader; omission rejects knowledge nodes.
 * @returns publication with a complete self-contained script and pinned nested source.
 */
export function compilePlan(input: z.infer<typeof planPublicationSchema>, read: (id: string, version: number) => WorkflowEdition,
  readTeam?: (id: string, version: number) => TeamEdition, maxParallel = 2,
  searchKnowledge?: (collection: string, version: number, query: string) => readonly { readonly title: string; readonly text: string }[]): {
  id: string
  expectedVersion: number
  description: string
  knowledge: { collection: string; version: number }[]
  script: string
  sourcePlan: Record<string, unknown>
} {
  const plan = planPublicationSchema.parse(input)
  for (const entry of plan.nodes) {
    if (entry.kind !== 'check') continue
    for (const pattern of entry.expect.mustMatch ?? []) {
      try { new RegExp(pattern, 'm') } catch { throw new WorkflowLibraryError('Check node ' + entry.id + ' has an invalid mustMatch pattern.') }
    }
  }
  const ids = new Set(plan.nodes.map(entry => entry.id))
  if (ids.size !== plan.nodes.length) throw new WorkflowLibraryError('Workflow node identities must be unique.')
  for (const entry of plan.nodes) {
    if (new Set(entry.dependsOn).size !== entry.dependsOn.length || entry.dependsOn.some(id => id === entry.id || !ids.has(id))) {
      throw new WorkflowLibraryError('Workflow dependencies must name distinct other nodes in this plan.')
    }
    if (entry.kind === 'branch' && !entry.dependsOn.includes(entry.source)) {
      throw new WorkflowLibraryError('A branch source must be an explicit dependency.')
    }
    // A retry re-runs the whole unit, so retrying a loop would replay iterations that already ran.
    if (entry.kind === 'repeat' && entry.retry > 1) {
      throw new WorkflowLibraryError('A repeat node must keep retry 1 so completed iterations are not replayed.')
    }
  }
  const byId = new Map(plan.nodes.map(entry => [entry.id, entry]))
  for (const entry of plan.nodes) {
    if (entry.kind !== 'check') continue
    if (entry.attempts !== undefined && entry.rework === undefined) {
      throw new WorkflowLibraryError('Check rework attempts require a rework target.')
    }
    if (entry.rework === undefined) continue
    if (!entry.dependsOn.includes(entry.rework)) {
      throw new WorkflowLibraryError('A rework target must be a direct dependency of the check node.')
    }
    const target = byId.get(entry.rework)
    if (target === undefined) throw new WorkflowLibraryError('A rework target must name a node in this plan.')
    if (target.kind !== 'role' && target.kind !== 'agent') {
      throw new WorkflowLibraryError('A rework target must be a role or agent node.')
    }
    // One rerun layer only: a retry on either side would multiply the calls without refreshing dependents.
    if (entry.retry > 1) throw new WorkflowLibraryError('A check must keep retry 1 when it reworks a node.')
    if (target.retry > 1) throw new WorkflowLibraryError('A node must keep retry 1 when it is a rework target.')
  }
  const reworkTargets = new Map<string, string>()
  for (const entry of plan.nodes) {
    if (entry.kind !== 'check' || entry.rework === undefined) continue
    const claimed = reworkTargets.get(entry.rework)
    if (claimed !== undefined) throw new WorkflowLibraryError('Only one check may rework a given node.')
    reworkTargets.set(entry.rework, entry.id)
  }
  for (const [target, check] of reworkTargets) {
    // A consumer of the target would keep the result the rework replaced, so the plan is refused instead.
    const stale = plan.nodes.find(entry => entry.id !== check && entry.dependsOn.includes(target))
    if (stale !== undefined) {
      throw new WorkflowLibraryError('A rework target must be consumed only by the check that reworks it; '
        + `${stale.id} also depends on ${target}.`)
    }
  }
  const layers: typeof plan.nodes[] = []
  const visited = new Set<string>()
  while (visited.size < plan.nodes.length) {
    const layer = plan.nodes.filter(entry => !visited.has(entry.id) && entry.dependsOn.every(id => visited.has(id)))
    if (layer.length === 0) throw new WorkflowLibraryError('Workflow dependencies contain a cycle.')
    layers.push(layer)
    for (const entry of layer) visited.add(entry.id)
  }
  const scripts: string[] = []
  const pins = new Map<string, number>()
  const pin = (ref: z.infer<typeof reference>): { index: number; classifiesFailures: boolean } => {
    const key = `${ref.id}:${ref.version}`
    const edition = read(ref.id, ref.version)
    if (edition.knowledgeMode === undefined) {
      throw new WorkflowLibraryError(`A plan cannot embed ${ref.id} v${ref.version}, which predates knowledge tracking; `
        + 'republish that definition before embedding it.')
    }
    // Scripts compiled before the failure-class marker cannot stop an outer retry from replaying them.
    const classifiesFailures = edition.script.includes('__stop(')
    const existing = pins.get(key)
    if (existing !== undefined) return { index: existing, classifiesFailures }
    const index = scripts.length
    pins.set(key, index)
    scripts.push(`// Saved ${key} sha256=${edition.sha256}\nasync (args) => {\n${edition.script}\n}`)
    return { index, classifiesFailures }
  }
  /** Refuse a replay of an embedding whose own failures are not classified.
   * @param entry - the consumer node, carrying its retry count.
   * @param ref - the embedded edition reference.
   * @param pinned - the resolved pin, including whether the script classifies failures.
   */
  const assertReplaySafe = (entry: { readonly retry: number; readonly id: string }, ref: z.infer<typeof reference>,
    pinned: { readonly classifiesFailures: boolean }): void => {
    if (entry.retry === 1 || pinned.classifiesFailures) return
    throw new WorkflowLibraryError(`Node ${entry.id} retries ${entry.retry} times but embeds ${ref.id} v${ref.version}, `
      + 'whose script predates non-retryable failure classes; a retry would replay unknown-result and failed-assertion work. '
      + 'Publish a reviewed replacement plan first, or keep that node at retry 1.')
  }
  const thunkNames = new Map<string, string>()
  const thunkDeclarations: string[] = []
  const statements = layers.map((layer, layerIndex) => {
    const names = layer.map((entry) => {
      const name = `__thunk${thunkNames.size}`
      thunkNames.set(entry.id, name)
      return name
    })
    layer.forEach((entry, index) => {
      const id = JSON.stringify(entry.id)
      const dependencies = `Object.fromEntries(${JSON.stringify(entry.dependsOn)}.map(id => [id, __results[id]]))`
      let expression: string
      switch (entry.kind) {
        case 'role': {
          if (readTeam === undefined) throw new WorkflowLibraryError('Role nodes require a team library.')
          const team = readTeam(entry.team.id, entry.team.version).definition
          if (team.kind !== 'team') throw new WorkflowLibraryError('Role nodes require an exact team definition.')
          const member = team.members.find(member => member.role === entry.role)
          if (member === undefined) throw new WorkflowLibraryError('The requested role is absent from the pinned team.')
          const profile = readTeam(member.profile.id, member.profile.version).definition
          if (profile.kind !== 'profile' || !profile.enabled) throw new WorkflowLibraryError('The pinned role profile is unavailable or disabled.')
          const excerpt = entry.knowledge === undefined || searchKnowledge === undefined ? ''
            : knowledgeBlock(searchKnowledge(entry.knowledge.collection, entry.knowledge.version, entry.knowledge.query))
          expression = `await agent(__feedback(attempt, lastError) + __reworkNote(${id}) + ${JSON.stringify(`${excerpt}${profile.instructions}\n\nTask: ${entry.prompt}\nPinned team: ${entry.team.id}:${entry.team.version}; role: ${entry.role}; profile: ${member.profile.id}:${member.profile.version}`)} + '\\nDependencies: ' + JSON.stringify(${dependencies}), ${JSON.stringify({ provider: profile.provider, model: profile.model, label: `${entry.id} · ${entry.prompt.slice(0, 18)}` })})`
          break
        }
        case 'agent': {
          const excerpt = entry.knowledge === undefined || searchKnowledge === undefined ? ''
            : knowledgeBlock(searchKnowledge(entry.knowledge.collection, entry.knowledge.version, entry.knowledge.query))
          expression = `await agent(__feedback(attempt, lastError) + __reworkNote(${id}) + ${JSON.stringify(`${excerpt}${entry.prompt}`)} + '\\nDependencies: ' + JSON.stringify(${dependencies}), ${JSON.stringify({ provider: entry.provider, model: entry.model, label: `${entry.id} · ${entry.prompt.slice(0, 18)}` })})`
          break
        }
        case 'check': {
          const upstream = JSON.stringify(entry.dependsOn)
          const rules = JSON.stringify(entry.expect)
          // Only a failed assertion may re-run a generator; a throwing or empty generation propagates.
          const rounds = entry.rework === undefined ? 0 : (entry.attempts ?? 1)
          const note = JSON.stringify(`${entry.id} rejected the previous result: `)
          expression = `await (async () => {
  const rules = ${rules}
  const targets = ${upstream}
  const inspect = () => {
    const text = targets.map(key => typeof __results[key] === 'string' ? __results[key] : JSON.stringify(__results[key])).join('\\n')
    const missing = rules.mustContain.filter(token => !text.includes(token))
    if (missing.length > 0) return { failure: 'missing required content: ' + missing.join(', '), length: text.length }
    const forbidden = rules.mustNotContain.filter(token => text.includes(token))
    if (forbidden.length > 0) return { failure: 'contains rejected content: ' + forbidden.join(', '), length: text.length }
    const unmatched = (rules.mustMatch ?? []).filter(pattern => !new RegExp(pattern, 'm').test(text))
    if (unmatched.length > 0) return { failure: 'missing required pattern: ' + unmatched.join(', '), length: text.length }
    if (text.length < rules.minLength) return { failure: 'content shorter than ' + rules.minLength + ' characters (got ' + text.length + ')', length: text.length }
    return { length: text.length }
  }
  let outcome = inspect()
  for (let round = 1; outcome.failure !== undefined && round <= ${rounds}; round++) {
    await __rerun(${JSON.stringify(entry.rework ?? null)}, ${note} + outcome.failure)
    outcome = inspect()
  }
  if (outcome.failure !== undefined) throw __stop(outcome.failure)
  return { passed: true, length: outcome.length }
})()`
          break
        }
        case 'saved': {
          const pinned = pin(entry.workflow)
          assertReplaySafe(entry, entry.workflow, pinned)
          expression = `await __saved[${pinned.index}](${dependencies})`
          break
        }
        case 'repeat': expression = `await (async () => { const iterations = []; for (let iteration = 0; iteration < ${entry.count}; iteration++) { const value = await __saved[${pin(entry.workflow).index}]({ dependencies: ${dependencies}, iteration }); if (value === null) throw __stop('Workflow iteration returned no successful value'); iterations.push(value); } return iterations; })()`; break
        case 'branch': {
          const thenPin = pin(entry.then)
          const otherwisePin = pin(entry.otherwise)
          assertReplaySafe(entry, entry.then, thenPin)
          assertReplaySafe(entry, entry.otherwise, otherwisePin)
          expression = `await __saved[JSON.stringify(${JSON.stringify(entry.path)}.reduce((value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined, __results[${JSON.stringify(entry.source)}])) === ${JSON.stringify(JSON.stringify(entry.equals))} ? ${thenPin.index} : ${otherwisePin.index}](${dependencies})`
          break
        }
      }
      thunkDeclarations.push(`const ${names[index]} = async () => { phase(${id}); let lastError = null; let attempt = 0; for (; attempt < ${entry.retry};) { attempt += 1; try { const value = ${expression}; if (value === null) throw __stop('returned no successful value'); return [${id}, value]; } catch (error) { lastError = error; if (__stopped(error) || attempt >= ${entry.retry}) break; log('node ${entry.id} attempt ' + attempt + ' failed; retrying'); } } const message = 'node ${entry.id} failed after ' + attempt + ' attempt(s): ' + (lastError && typeof lastError === 'object' && 'message' in lastError ? String(lastError.message) : String(lastError)); __errors.push(message); const failure = new Error(message); if (__stopped(lastError)) failure.__nonRetryable = true; throw failure; }`)
    })
    // The layer keeps the failure class: a nested edition's non-retryable stop must not become a plain error.
    return `const __layer${layerIndex} = await __pool([${names.join(', ')}], ${maxParallel});
for (const entry of __layer${layerIndex}) { if (entry === null) { const failure = new Error('Workflow layer failed; dependent nodes were not started. ' + __errors.join(' | ')); if (__failures.some(item => __stopped(item))) failure.__nonRetryable = true; throw failure; } __results[entry[0]] = entry[1]; }`
  })
  const inherited = [...pins.keys()].flatMap((key) => {
    const [id = '', version = '1'] = key.split(':')
    return read(id, Number(version)).knowledge
  })
  const declared = plan.nodes.flatMap(entry => ('knowledge' in entry && entry.knowledge !== undefined)
    ? [{ collection: entry.knowledge.collection, version: entry.knowledge.version }]
    : [])
  const knowledge = [...new Map([...declared, ...inherited]
    .map(dep => [`${dep.collection}:${dep.version}`, dep])).values()]
  const thunkTable = [...thunkNames].map(([node, name]) => `${JSON.stringify(node)}: ${name}`).join(', ')
  return { id: plan.id, expectedVersion: plan.expectedVersion, description: plan.description, knowledge, sourcePlan: plan,
    script: `const __saved = [${scripts.join(',\n')}];\nconst __results = Object.create(null);\nconst __errors = [];\nconst __stop = (message) => Object.assign(new Error(message), { __nonRetryable: true });
const __stopped = (error) => Boolean(error) && (error.__nonRetryable === true || error.name === 'AbortError' || /aborted|cancell?ed/i.test(String(error.message)));
const __feedback = (attempt, lastError) => attempt > 1 && lastError ? 'Previous attempt failed: ' + String(lastError && lastError.message || lastError) + String.fromCharCode(10) : '';\nconst __rework = Object.create(null);\nconst __reworkNote = (id) => Object.hasOwn(__rework, id) ? 'Previous result was rejected: ' + String(__rework[id]) + String.fromCharCode(10) : '';\nconst __rerun = async (target, note) => { __rework[target] = note; const entry = await __thunks[target](); if (entry === null) throw new Error('Rework target ' + target + ' returned no successful value'); __results[entry[0]] = entry[1] };\nlet __failures = [];
const __pool = async (thunks, limit) => { const results = new Array(thunks.length).fill(null); __failures = []; let next = 0; const work = async () => { while (true) { const index = next++; if (index >= thunks.length) return; try { results[index] = await thunks[index]() } catch (error) { results[index] = null; __failures.push(error) } } }; await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, thunks.length)) }, work)); return results };\n${thunkDeclarations.join('\n')}\nconst __thunks = { ${thunkTable} };\n${statements.join('\n')}\nreturn __results;` }
}
