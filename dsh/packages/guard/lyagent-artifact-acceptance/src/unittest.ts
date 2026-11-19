/** Host-owned unittest invocation and strict process-result interpretation. */
import { isAbsolute, relative } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Explicit independent evaluator inputs; no model-provided command or test selection. */
export interface TestConfig {
  /** Absolute trusted Python interpreter path. */
  python: string
  /** Absolute evaluator directory outside the writable task workspace. */
  root: string
  /** Immutable evaluator files verified before invocation. */
  files: {
    /** Python test filename relative to the evaluator root. */
    path: string
    /** Expected lowercase SHA-256 of the evaluator file. */
    sha256: string
  }[]
  /** Minimum independently reported passing test count. */
  minTests: number
  /** Maximum evaluator subprocess duration in milliseconds. */
  timeoutMs: number
  /** Omission refuses child-result acceptance; explicit positive bound permits evaluator input. */
  maxChildResultBytes?: number | undefined
}

/** Reject incomplete or ambiguous host evaluator definitions before activation.
 * @param config - explicit evaluator configuration.
 * @returns whether every scalar and relative test filename is valid.
 */
export function validTestConfig(config: TestConfig): boolean {
  return isAbsolute(config.python) && isAbsolute(config.root)
    && (config.maxChildResultBytes === undefined || Number.isSafeInteger(config.maxChildResultBytes) && config.maxChildResultBytes > 0)
    && Number.isSafeInteger(config.minTests) && config.minTests > 0
    && Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0
    && config.files.length > 0 && new Set(config.files.map(file => file.path)).size === config.files.length
    && config.files.every(file => /^[a-zA-Z0-9_-]+\.py$/.test(file.path) && /^[a-f0-9]{64}$/.test(file.sha256))
}

/** Run immutable host test files through native pwsh policy, approval and cancellation.
 * @param ctx - native execution services.
 * @param exec - owning delivery invocation.
 * @param config - trusted evaluator selection.
 * @param cwd - authorized workspace being evaluated.
 * @param rejected - optional receiver for a bounded mechanical failure reason; omitted suppresses diagnostics.
 * @param passed - optional receiver for the independently observed successful test count.
 * @param children - host-measured serialized child results; omission supplies an empty list.
 * @returns a mechanical success summary, or undefined for every unverified process outcome.
 */
export async function runUnittest(
  ctx: Context, exec: ToolExecution, config: TestConfig, cwd: string, rejected?: (reason: string) => void,
  passed?: (tests: number) => void,
  children = '[]',
): Promise<string | undefined> {
  const fail = (reason: string): string | undefined => { rejected?.(reason); return undefined }
  const evaluatorRelative = relative(cwd, config.root)
  if (evaluatorRelative === '' || (!evaluatorRelative.startsWith('..') && !isAbsolute(evaluatorRelative))) return fail('Evaluator root is inside the workspace.')
  const script = `import contextlib, hashlib, importlib.util, io, json, pathlib, sys, unittest
cfg = json.loads(${JSON.stringify(JSON.stringify(config))})
child_results = json.loads(${JSON.stringify(children)})
evaluator_root = pathlib.Path(cfg['root']).resolve(strict=True)
workspace_root = pathlib.Path(${JSON.stringify(cwd)}).resolve(strict=True)
if evaluator_root == workspace_root or evaluator_root.is_relative_to(workspace_root):
 raise RuntimeError('Evaluator must be outside workspace')
sys.path.insert(0, ${JSON.stringify(cwd)})
suite = unittest.TestSuite()
with contextlib.redirect_stdout(sys.stderr):
 for i, item in enumerate(cfg['files']):
  path = evaluator_root / item['path']
  if path.is_symlink() or path.resolve(strict=True).parent != evaluator_root:
   raise RuntimeError('Evaluator file must be local to its trusted root')
  source = path.read_bytes()
  if hashlib.sha256(source).hexdigest() != item['sha256']:
   raise RuntimeError('Evaluator digest mismatch')
  spec = importlib.util.spec_from_file_location('lyagent_eval_' + str(i), path)
  module = importlib.util.module_from_spec(spec)
  module.LYAGENT_CHILD_RESULTS = child_results
  exec(compile(source, str(path), 'exec'), module.__dict__)
  suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
 result = unittest.TextTestRunner(stream=sys.stderr).run(suite)
for item in cfg['files']:
 if hashlib.sha256((evaluator_root / item['path']).read_bytes()).hexdigest() != item['sha256']:
  raise RuntimeError('Evaluator changed during testing')
print(json.dumps({'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors), 'skipped': len(result.skipped), 'successful': result.wasSuccessful()}))
sys.exit(0 if result.wasSuccessful() and result.testsRun > 0 else 1)
`
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  const encoded = Buffer.from(script).toString('base64')
  const bootstrap = `import base64;exec(base64.b64decode('${encoded}'))`
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId(`${exec.callId}:unittest`), name: 'pwsh', arguments: JSON.stringify({
      description: 'Run independent artifact acceptance tests',
      command: `& ${quote(config.python)} -I -c ${quote(bootstrap)}; exit $LASTEXITCODE`,
      workdir: cwd, timeoutMs: config.timeoutMs, promote_on_timeout: false,
    }) }], signal: exec.signal, ...(exec.agent === undefined ? {} : { agent: exec.agent }),
  })
  const result = batch.results[0]?.result
  if (result === undefined || result.isError) return fail('Evaluator execution was unavailable, denied or interrupted.')
  const value = result.value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (value.timedOut === true) return fail('Evaluator exceeded its deadline.')
    if (value.aborted === true || value.stopped !== undefined) return fail('Evaluator was interrupted.')
    if (value.kind !== 'foreground') return fail('Evaluator did not settle in the foreground.')
    if (value.exitCode !== 0) return fail('Evaluator exited unsuccessfully; inspect the independent tests and their pinned sources.')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.kind !== 'foreground' || value.exitCode !== 0 || value.timedOut !== false
    || value.aborted !== false || value.signal !== null || value.stopped !== undefined) return fail('Evaluator process outcome is incomplete.')
  if (value.sandbox !== undefined && (value.sandbox === null || typeof value.sandbox !== 'object'
    || Array.isArray(value.sandbox) || value.sandbox.denied !== false || value.sandbox.runnerFailed === true)) return fail('Evaluator sandbox denied execution or failed.')
  const stdout = value.stdout
  if (stdout === null || typeof stdout !== 'object' || Array.isArray(stdout)
    || stdout.truncated !== false || typeof stdout.text !== 'string') return fail('Evaluator output is missing or truncated.')
  let report: unknown
  try { report = JSON.parse(stdout.text) } catch (error) {
    if (error instanceof SyntaxError) return fail('Evaluator output is not a complete JSON report.')
    throw error
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return fail('Evaluator report is not an object.')
  const fields = report as Record<string, unknown>
  if (typeof fields.tests !== 'number' || !Number.isSafeInteger(fields.tests) || fields.tests < config.minTests
    || fields.failures !== 0 || fields.errors !== 0 || fields.skipped !== 0 || fields.successful !== true) {
    return fail('Evaluator report does not meet the minimum test count or contains failures, errors or skips.')
  }
  passed?.(fields.tests)
  return `Independent unittest checks passed: ${fields.tests} tests, exit 0, no failures, errors or skips.\n`
    + config.files.map(file => `Evaluator SHA-256: ${file.path} ${file.sha256}`).join('\n')
}
