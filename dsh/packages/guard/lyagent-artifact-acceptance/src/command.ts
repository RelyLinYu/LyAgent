/** Human-owned task registration and execution through native command discovery. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { TaskRuns } from './run-runtime.ts'
import { RunError } from './run.ts'
import { z } from 'zod'
import { requirementsSchema } from './requirements.ts'

const usage = '/task criteria | list [after] | new <objective> | define <json> | status <id> | run <id> | coordinate <id> | cancel <id> | repair <id> <work-order>'

function parseDefinition(input: string): unknown {
  try { return JSON.parse(input) } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

/** Register portable native task controls; registration alone starts no model calls.
 * @param ctx - lifecycle owner with an optional native command registry.
 * @param tasks - task service whose criteria come from trusted deployment configuration.
 */
export function registerTaskCommand(ctx: Context, tasks: TaskRuns): void {
  const commands = ctx.get('commands')
  if (commands === undefined) return
  commands.register({
    name: 'task', description: 'Register, execute or inspect an independently checked task',
    input: { hint: usage.slice(6) },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const input = invocation.rawInput.trim()
      invocation.signal.throwIfAborted()
      if (input === 'criteria') return { kind: 'success', text: JSON.stringify(tasks.criteria()) }
      if (input.startsWith('define ')) {
        const parsed = z.object({ objective: z.string().trim().min(1).max(4000), requirements: requirementsSchema })
          .strict().safeParse(parseDefinition(input.slice(7)))
        if (!parsed.success) return { kind: 'error', text: 'Invalid task requirements.' }
        try {
          const id = randomUUID()
          await tasks.register(id, invocation.agent, parsed.data.objective, parsed.data.requirements)
          return { kind: 'success', text: `Task registered, not started: ${id}` }
        } catch (error) {
          if (error instanceof RunError) return { kind: 'error', text: error.message }
          throw error
        }
      }
      const repair = /^repair (\S+) (\S+)$/.exec(input)
      if (repair?.[1] !== undefined && repair[2] !== undefined) {
        try {
          const affected = await tasks.repair(repair[1], invocation.agent, repair[2], invocation.signal)
          return { kind: 'success', text: `Reopened dependent work only: ${affected.join(', ')}. No execution started.` }
        } catch (error) {
          if (error instanceof RunError) return { kind: 'error', text: error.message }
          throw error
        }
      }
      if (input === 'list' || /^list \S+$/.test(input)) {
        return { kind: 'success', text: JSON.stringify(tasks.list(invocation.agent, input === 'list' ? undefined : input.slice(5))) }
      }
      const match = /^(new|status|run|coordinate|cancel)\s+([\s\S]+)$/.exec(input)
      if (match === null || match[2] === undefined) return { kind: 'error', text: usage }
      const action = match[1]
      const value = match[2].trim()
      invocation.signal.throwIfAborted()
      try {
        if (action === 'new') {
          const id = randomUUID()
          await tasks.register(id, invocation.agent, value)
          return { kind: 'success', text: `Task registered, not started: ${id}\n${value}\n/task run ${id}` }
        }
        const run = tasks.read(value)
        if (run === undefined || run.session !== invocation.agent.id) {
          return { kind: 'error', text: 'Task not found in this conversation.' }
        }
        if (action === 'run') await tasks.execute(value, invocation.agent, invocation.signal)
        if (action === 'coordinate') await tasks.coordinate(value, invocation.agent, invocation.signal)
        if (action === 'cancel') {
          await tasks.cancel(value, invocation.agent, 'Cancelled by the user through /task.')
          if (run.outcome.state === 'running' || run.outcome.state === 'checking') invocation.agent.cancel({ kind: 'user' })
        }
        const current = tasks.read(value)
        if (current === undefined) throw new RunError('The registered task is unavailable.')
        const reason = 'reason' in current.outcome ? `\n${current.outcome.reason}` : ''
        return { kind: 'success', text: `${value}: ${current.outcome.state}\n${current.objective}${reason}` }
      } catch (error) {
        if (error instanceof RunError) return { kind: 'error', text: error.message }
        throw error
      }
    },
  })
}
