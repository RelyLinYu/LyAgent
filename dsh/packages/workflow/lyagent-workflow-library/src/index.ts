/** Human-managed saved workflows executed through the existing native workflow tool. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as validate } from 'zod'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-lyagent-knowledge'
import type { TeamTaskId } from '@deepseek-ai/dsh-agent-team'
import { WorkflowLibrary, WorkflowLibraryError, publicationSchema, workflowLibraryDomain } from './store.ts'
import { assertKnowledgePinned } from './guards.ts'
import { compilePlan, planPublicationSchema } from './plan.ts'
import { migratePlan, migrationSchema } from './migration.ts'
import { writeRunRecord } from './record.ts'
import { publishManagedPlan } from './publication.ts'
import { TeamLibrary, teamLibraryDomain, teamPublicationSchema } from './team.ts'

export const name = 'lyagent-workflow-library'
export const inject = ['storageDomain', 'commands', 'tools', 'workingDirectory', 'agentTeams', 'lyagentKnowledge']
/** Explicit storage and publication limits. */
export interface Config {
  /** Maximum UTF-8 bytes in one complete published definition. */
  maxDefinitionBytes: number
  /** Maximum distinct identities retained by each library. */
  maxEntries: number
  /** Simultaneous workflow nodes one run may start; the runtime child capacity bounds it. */
  maxParallelNodes: number
}
export const Config: z<Config> = z.object({
  maxDefinitionBytes: z.number().required(),
  maxEntries: z.number().required(),
  maxParallelNodes: z.number().min(1).default(2),
})

/** Register saved definitions and human-only commands; publication starts no model requests.
 * @param ctx - lifecycle owner for native storage, commands and tool execution.
 * @param config - positive history and catalog limits.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (Object.values(config).some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new WorkflowLibraryError('Workflow library limits must be positive safe integers.')
  }
  const domain = await ctx.storageDomain.open(workflowLibraryDomain)
  const teamsDomain = await ctx.storageDomain.open(teamLibraryDomain).catch(async (error: unknown) => { await domain.close(); throw error })
  try {
    const library = new WorkflowLibrary(domain.table('definitions'), config.maxDefinitionBytes, config.maxEntries)
    const teams = new TeamLibrary(teamsDomain.table('definitions'), config.maxDefinitionBytes, config.maxEntries)
    const running = new Set<Promise<void>>()
    type KnowledgeEdition = {
      readonly version: number
      readonly knowledge?: readonly { readonly collection: string; readonly version: number }[]
    }
    const executions = new Map<string, { readonly controller: AbortController; readonly edition: KnowledgeEdition }>()
    const lifetime = { closed: false }
    /** Persist one settled run beside the workspace and report the outcome to the caller.
   * @param agent - conversation owning the run.
   * @param id - saved workflow identity.
   * @param editionVersion - exact executed version.
   * @param sha256 - compiled script digest.
   * @param content - settled tool content.
   * @param signal - caller cancellation.
   * @returns the written path, or the failure that left the run unrecorded.
   */
    const recordRun = async (agent: Parameters<typeof ctx.workingDirectory.ensure>[0], id: string, editionVersion: number,
      sha256: string, content: unknown, signal: AbortSignal): Promise<{ readonly path: string } | { readonly error: string }> => {
      try {
        const cwd = await ctx.workingDirectory.ensure(agent, signal)
        return { path: await writeRunRecord(cwd, { id, version: editionVersion, sha256, content },
          { at: new Date(), nonce: randomUUID().slice(0, 8) }) }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`lyagent-workflow-library: run not recorded for ${id} v${editionVersion}: ${message}`)
        return { error: message }
      }
    }


    /** Refuse a run whose compiled knowledge dependencies are no longer authorised.
   * @param agent - conversation about to execute the edition.
   * @param edition - exact saved edition, including its compiled dependencies.
   * @returns nothing; throws when any dependency lost its grant.
   */
    const assertKnowledgeAccess = (agent: { readonly id: string }, edition: Pick<KnowledgeEdition, 'knowledge'>): void => {
      const blocked = (edition.knowledge ?? []).filter(dep => !ctx.lyagentKnowledge.authorized(agent.id, dep.collection, dep.version))
      if (blocked.length > 0) {
        throw new WorkflowLibraryError('Knowledge access was revoked for '
        + blocked.map(dep => `${dep.collection}:${dep.version}`).join(', ')
        + '; publish a new version after the grant is restored.')
      }
    }
    /** Grant exactly the editions a saved workflow pins to the conversation that asked to read or run it.
     * Commands are human-initiated surfaces with no model entry point, so read/run carries the caller's consent;
     * existing grants are preserved and only the missing pinned collections are added.
     * @param session - conversation whose grants are extended.
     * @param edition - saved edition carrying compiled knowledge dependencies.
     * @returns nothing; refuses when the grant list cannot be merged without dropping a grant.
     */
    const authorizeEdition = async (session: string, edition: Pick<KnowledgeEdition, 'knowledge'>): Promise<void> => {
      const missing = (edition.knowledge ?? []).filter(dep => !ctx.lyagentKnowledge.authorized(session, dep.collection, dep.version))
      if (missing.length === 0) return
      const current = ctx.lyagentKnowledge.list(session)
      if (current.truncated) {
        throw new WorkflowLibraryError('This conversation pins too many knowledge collections to extend automatically; '
          + 'revoke unused collections with /knowledge revoke and try again.')
      }
      const pins = [...new Map([...current.pins, ...missing].map(pin => [pin.collection, pin])).values()]
      await ctx.lyagentKnowledge.grant(session, pins)
    }
    ctx.on('lyagent-knowledge/grants-changed', (session: string) => {
      const active = executions.get(session)
      if (active === undefined) return
      const blocked = (active.edition.knowledge ?? []).filter(dep => !ctx.lyagentKnowledge.authorized(session, dep.collection, dep.version))
      if (blocked.length === 0) return
      // The edition inlined those excerpts, so the run stops instead of disclosing them to more children.
      ctx.logger.warn(`lyagent-workflow-library: stopping a running edition after its knowledge grant was revoked (${blocked.map(dep => `${dep.collection}:${dep.version}`).join(', ')})`)
      active.controller.abort('knowledge access was revoked')
    })
    ctx.provide('lyagentWorkflowLibrary', library)
    ctx.tools.register(defineTool({
      name: 'saved_workflow',
      description: 'Execute an exact human-saved workflow version under the current task permissions and budget. Never infer a version or substitute the latest. Publication is human-only. This tool records the settled run beside the workspace and does not create shared task-board work orders.',
      parameters: { id: { type: 'string', required: true }, version: { type: 'integer', required: true, description: 'Exact positive saved version.' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, version: { type: 'integer', required: true },
        sha256: { type: 'string', required: true }, result: { type: 'string', required: true },
        record: { type: 'object', required: true, additionalProperties: false,
          description: 'Run record outcome beside the workspace; the run result is independent of it.',
          properties: { path: { type: 'string' }, error: { type: 'string' } } },
      } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        if (exec.agent === undefined) throw new ToolContextUnavailableError('Saved workflows require an owning conversation.')
        if (lifetime.closed || executions.has(exec.agent.id)) throw new WorkflowLibraryError('A saved workflow is active or the library is closing.')
        const edition = library.read(args.id, args.version)
        assertKnowledgePinned(args.id, edition)
        assertKnowledgeAccess(exec.agent, edition)
        exec.signal.throwIfAborted()
        const controller = new AbortController()
        const done = Promise.withResolvers<void>()
        executions.set(exec.agent.id, { controller, edition })
        running.add(done.promise)
        try {
          const batch = await ctx.tools.execute({ agent: exec.agent, signal: AbortSignal.any([exec.signal, controller.signal]),
            ...exec.toolSet === undefined ? {} : { toolSet: exec.toolSet },
            calls: [{ type: 'tool-call', id: ToolCallId(`${exec.callId}:saved`), name: 'workflow', arguments: JSON.stringify({
              script: edition.script, meta: { name: args.id, description: edition.description }, run_in_background: false,
            }) }] })
          for (const context of batch.additionalContexts) exec.deferContext(context)
          const settled = batch.results[0]?.result
          if (settled === undefined) throw new WorkflowLibraryError('Native workflow execution returned no result. Stop dependent work and inspect the workflow run.')
          if (settled.isError) {
            const code = settled.error.info?.code
            if (code === 'UNKNOWN_TOOL') {
              throw new WorkflowLibraryError('Saved workflows need the native workflow tool, which is not available to this conversation. Use a preset that exposes workflow, or have the model author the orchestration directly.')
            }
            throw new WorkflowLibraryError(`Saved workflow execution failed (${code ?? 'WORKFLOW_ERROR'}). Check workflow permissions and run status before restarting.`)
          }
          if (batch.concluded) exec.concludeTurn()
          const record = await recordRun(exec.agent, args.id, edition.version, edition.sha256, settled.content, exec.signal)
          return { id: args.id, version: edition.version, sha256: edition.sha256,
            record: 'path' in record ? { path: record.path } : { error: record.error },
            result: JSON.stringify(settled.content) }
        } finally { executions.delete(exec.agent.id); running.delete(done.promise); done.resolve() }
      },
      presentCall: args => ({ card: 'generic', title: 'saved_workflow', rawInput: args }),
    }))
    ctx.commands.register({ name: 'saved-workflow', description: 'Save and execute an exact workflow version',
      input: { hint: 'list | teams | publish <JSON> | publish-plan <JSON> | migrate-plan <JSON> | review-migration <JSON> | publish-team <JSON> | read <id> <version> | read-team <id> <version> | run <id> <version>' },
      async handler(invocation) {
        invocation.signal.throwIfAborted()
        if (lifetime.closed) return { kind: 'error', text: 'The workflow library is closing.' }
        const input = invocation.rawInput.trim()
        if (Buffer.byteLength(input, 'utf8') > config.maxDefinitionBytes) return { kind: 'error', text: 'Workflow input exceeds the configured byte limit.' }
        try {
          if (input === 'list') return { kind: 'success', text: JSON.stringify(library.list()) }
          if (input === 'catalog') return { kind: 'success', text: JSON.stringify({ workflows: library.list(), teams: teams.list() }) }
          if (input === 'teams') return { kind: 'success', text: JSON.stringify(teams.list()) }
          if (input.startsWith('publish-team ')) {
            const publication = teamPublicationSchema.parse(JSON.parse(input.slice(13)))
            const edition = await teams.publish(publication)
            return { kind: 'success', text: JSON.stringify({ id: publication.id, ...edition }) }
          }
          const teamRead = /^read-team ([a-zA-Z0-9_-]{1,80}) ([1-9][0-9]*)$/.exec(input)
          if (teamRead?.[1] !== undefined && teamRead[2] !== undefined) {
            return { kind: 'success', text: JSON.stringify({ id: teamRead[1], ...teams.read(teamRead[1], Number(teamRead[2])) }) }
          }
          if (input.startsWith('publish-plan ') || input.startsWith('migrate-plan ') || input.startsWith('review-migration ')) {
            if (invocation.agent === undefined) return { kind: 'error', text: 'Publishing a plan requires an owning conversation.' }
            const dryRun = input.startsWith('review-migration ')
            // 'publish-plan ' and 'migrate-plan ' share one prefix length; the review command is longer.
            const offset = dryRun ? 17 : 13
            const body = JSON.parse(input.slice(offset))
            const plan = dryRun || input.startsWith('migrate-plan ')
              ? migrationSchema.parse(body).plan
              : planPublicationSchema.parse(body)
            // Knowledge grants belong to the calling Agent id, including embedded editions.
            const callerId = invocation.agent.id
            const searchKnowledge = (collection: string, version: number, query: string) => {
              try {
                const result = ctx.lyagentKnowledge.search(callerId, collection, version, query)
                return result.matches.map(match => ({ title: match.title, text: match.text }))
              } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error)
                throw new WorkflowLibraryError('Knowledge lookup failed for ' + collection + ': ' + message)
              }
            }
            if (input.startsWith('migrate-plan ') || dryRun) {
              // A reviewed replacement plan replaces an exact predecessor; it never relabels the old script.
              const migrated = await migratePlan(library, body, (id, version) => teams.read(id, version),
                config.maxParallelNodes, searchKnowledge, nested => { assertKnowledgeAccess(invocation.agent!, nested) }, dryRun)
              return { kind: 'success', text: JSON.stringify({ state: migrated.state, id: migrated.id,
                version: migrated.edition.version, sha256: migrated.edition.sha256 }) }
            }
            // Every embedded edition is disclosed through this response, so its recorded dependencies
            // must be authorized for this caller before the body is compiled in.
            const readNested = (id: string, version: number) => {
              const nested = library.read(id, version)
              assertKnowledgeAccess(invocation.agent, nested)
              return nested
            }
            const publication = compilePlan(plan, readNested,
              (id, version) => teams.read(id, version), config.maxParallelNodes, searchKnowledge)
            // A revoke during compilation must not persist a version whose excerpts this caller lost.
            assertKnowledgeAccess(invocation.agent, { knowledge: publication.knowledge })
            const receipt = await publishManagedPlan(library, publication, () => {
              assertKnowledgeAccess(invocation.agent, { knowledge: publication.knowledge })
            })
            return { kind: 'success', text: JSON.stringify(receipt) }
          }
          if (input.startsWith('publish ')) {
            const publication = publicationSchema.parse(JSON.parse(input.slice(8)))
            const edition = await library.publish(publication, 'human')
            return { kind: 'success', text: JSON.stringify({ id: publication.id, ...edition }) }
          }
          const match = /^(read|run) ([a-zA-Z0-9_-]{1,80}) ([1-9][0-9]*)$/.exec(input)
          if (match?.[2] === undefined || match[3] === undefined) return { kind: 'error', text: 'Use list, teams, publish <JSON>, publish-plan <JSON>, publish-team <JSON>, read <id> <version>, read-team <id> <version> or run <id> <version>.' }
          const edition = library.read(match[2], Number(match[3]))
          const agent = invocation.agent
          // Reading returns the compiled body, which may carry inlined excerpts: apply the same boundary as running.
          assertKnowledgePinned(match[2], edition)
          // A human opening or running a saved workflow authorizes exactly the editions it pins.
          await authorizeEdition(agent.id, edition)
          assertKnowledgeAccess(agent, edition)
          if (match[1] === 'read') return { kind: 'success', text: JSON.stringify({ id: match[2], ...edition }) }
          if (executions.has(agent.id) || agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
            return { kind: 'error', text: 'Wait for the conversation and queued input to settle before running a saved workflow.' }
          }
          const done = Promise.withResolvers<void>()
          const controller = new AbortController()
          executions.set(agent.id, { controller, edition })
          running.add(done.promise)
          try {
            // Mirror the saved edition onto the shared task board so Team mode shows
            // the same work orders this run executes. Failures never block the run.
            let boardTask: TeamTaskId | undefined
            let boardRevision = 0
            let boardNote = ''
            let boardClaimed = false
            try {
              const view = await ctx.agentTeams.createTask(agent, {
                subject: `workflow ${match[2]} v${edition.version}`,
                description: edition.description,
              }, invocation.signal)
              boardTask = view.id
              boardRevision = view.revision
              // A board task must be claimed before it can be completed.
              const claimed = await ctx.agentTeams.updateTask(agent, {
                taskId: boardTask, expectedRevision: boardRevision, action: 'claim',
              }, invocation.signal)
              boardRevision = claimed.revision
              boardClaimed = true
            } catch (error: unknown) {
              // Team mode is optional, but a task created without a claim stays open: say so instead of hiding it.
              const message = error instanceof Error ? error.message : String(error)
              boardNote = boardTask === undefined ? message : `created ${boardTask} but could not claim it: ${message}`
            }
            // Grants may have changed while the board was prepared; re-check before any child starts.
            assertKnowledgeAccess(agent, edition)
            const result = await ctx.tools.execute({ agent, signal: AbortSignal.any([invocation.signal, controller.signal]), calls: [{ type: 'tool-call',
              id: ToolCallId(randomUUID()), name: 'workflow', arguments: JSON.stringify({
                script: edition.script, meta: { name: match[2], description: edition.description }, run_in_background: false,
              }) }] })
            const settled = result.results[0]?.result
            if (settled === undefined) throw new WorkflowLibraryError('Native workflow execution returned no result.')
            if (settled.isError && settled.error.info?.code === 'UNKNOWN_TOOL') {
              return { kind: 'error', text: 'Saved workflows need the native workflow tool, which is not available to this conversation. Use a preset that exposes workflow.' }
            }
            let boardTransition = boardTask === undefined ? 'none' : boardClaimed ? 'pending' : 'unclaimed'
            if (boardTask !== undefined && boardClaimed) {
              const action = settled.isError ? 'release' : 'complete'
              try {
                const closed = await ctx.agentTeams.updateTask(agent, { taskId: boardTask, expectedRevision: boardRevision, action }, invocation.signal)
                boardTransition = action === 'release' ? 'released' : 'completed'
                if (settled.isError) {
                  // Releasing returns the task to pending for a retry, so the failure reason must live on the task.
                  // Keep the message and drop the VM stack trace, which says nothing to a board reader.
                  const detail = settled.content.map(part => 'text' in part ? part.text : '').join(' ').trim()
                  const message = (detail === '' ? settled.error.message ?? 'the workflow run failed' : detail)
                    .split('\n    at ')[0]!.trim().slice(0, 300)
                  try {
                    const current = ctx.agentTeams.getTask(agent, boardTask)
                    await ctx.agentTeams.updateTask(agent, { taskId: boardTask, expectedRevision: closed.revision,
                      action: 'edit', description: `${current.description}\n\nrun failed: ${message}` }, invocation.signal)
                  } catch (error: unknown) {
                    boardTransition = `released but could not record the failure reason: ${error instanceof Error ? error.message : String(error)}`
                  }
                }
              } catch (error: unknown) {
                // The run result stands, but the caller must know the board is left in the claimed state.
                boardTransition = `failed to ${action}: ${error instanceof Error ? error.message : String(error)}`
              }
            }
            const record = settled.isError
              ? { skipped: 'the run failed' }
              : await recordRun(agent, match[2], edition.version, edition.sha256, settled.content, invocation.signal)
            const text = JSON.stringify({ id: match[2], version: edition.version, sha256: edition.sha256,
              board: boardTask === undefined
                ? { skipped: boardNote }
                : { task: boardTask, transition: boardTransition, ...boardNote === '' ? {} : { note: boardNote } },
              record, content: settled.content })
            return { kind: settled.isError ? 'error' : 'success', text }
          } finally { executions.delete(agent.id); running.delete(done.promise); done.resolve() }
        } catch (error) {
          if (error instanceof WorkflowLibraryError) return { kind: 'error', text: error.message }
          if (error instanceof SyntaxError || error instanceof validate.ZodError) return { kind: 'error', text: 'Invalid saved workflow definition or version.' }
          throw error
        }
      },
    })
    ctx.effect(() => async () => {
      lifetime.closed = true
      for (const active of executions.values()) active.controller.abort()
      await Promise.allSettled([...running])
      await library.close()
      await teams.close()
      await teamsDomain.close()
      await domain.close()
    })
  } catch (error) { await teamsDomain.close(); await domain.close(); throw error }
}

declare module '@deepseek-ai/cordis' {
  interface Context { lyagentWorkflowLibrary: WorkflowLibrary }
}
