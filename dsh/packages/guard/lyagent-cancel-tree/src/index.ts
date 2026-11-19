/** Opt-in cancellation linkage from a root turn to its resident delegated work. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'

export const name = 'lyagent-cancel-tree'
export const inject = ['agents', 'subagents', 'tools']
/** No deployment tuning; cancellation follows the owning native root turn. */
export interface Config {}
export const Config: z<Config> = z.object({})

/** Attach root-turn cancellation without permanently draining the reusable tree.
 * @param ctx - owner of the reversible event and guard registrations.
 */
export function apply(ctx: Context): void {
  const turns = new Map<Agent, { signal: AbortSignal; remove: () => void }>()
  const children = new Map<SubagentRunInfo['runId'], { root: Agent; info: SubagentRunInfo }>()
  const rootOf = (agent: Agent) => ctx.subagents.rootOf(agent)
  ctx.on('subagent/start', (info) => {
    const parent = ctx.agents.get(info.parentSessionId)
    if (parent === undefined) return
    const root = rootOf(parent)
    children.set(info.runId, { root, info })
    if (turns.get(root)?.signal.aborted) ctx.subagents.interrupt(info.id, { kind: 'ancestor', agent: root })
  })
  ctx.on('subagent/end', (info) => { children.delete(info.runId) })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const root = rootOf(agent)
    if (root !== agent) {
      if (turns.get(root)?.signal.aborted) return { kind: 'reject' }
      return next()
    }
    const previous = turns.get(root)
    if (previous?.signal !== signal) {
      previous?.remove()
      const interrupt = () => {
        for (const child of children.values()) {
          if (child.root === root) ctx.subagents.interrupt(child.info.id, { kind: 'ancestor', agent: root })
        }
      }
      signal.addEventListener('abort', interrupt, { once: true })
      turns.set(root, { signal, remove: () => { signal.removeEventListener('abort', interrupt) } })
      if (signal.aborted) interrupt()
    }
    return next()
  }, { prepend: true })
  ctx.tools.guard((execution) => {
    if (execution.agent === undefined) return undefined
    const child = [...children.values()].find(child => child.info.id === execution.agent?.id)
    if (child === undefined || !turns.get(child.root)?.signal.aborted) return undefined
    return {
      reason: 'The parent task was stopped. Do not continue delegated work until the parent starts a new task.',
      info: { name: 'LyAgentCancelTreeError', code: 'LYAGENT_PARENT_STOPPED' },
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    turns.get(agent)?.remove()
    turns.delete(agent)
  })
  ctx.effect(() => () => {
    for (const turn of turns.values()) turn.remove()
    turns.clear()
    children.clear()
  })
}
