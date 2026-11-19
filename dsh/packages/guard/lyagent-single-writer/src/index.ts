/** Opt-in parent-only side effects, enforced by the native monotonic execution guard. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'lyagent-single-writer'
export const inject = ['tools']

/** Audited read-only tools; unknown names remain denied in every child. */
export interface Config {
  /** Explicit tool names permitted for children; every other child tool remains denied. */
  childReadOnlyTools: string[]
}
export const Config: z<Config> = z.object({ childReadOnlyTools: z.array(z.string()).required() })

/** Register a final denial that cannot be overridden by pre-execute allow listeners.
 * @param ctx - policy lifecycle owner.
 * @param config - explicit deployment-owned child read-only tool list.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.childReadOnlyTools.some(name => name.trim().length === 0)) throw new Error('Child tool names must be nonempty')
  const allowed = new Set(config.childReadOnlyTools)
  ctx.tools.guard((execution) => {
    const header = execution.agent?.session.header
    if (header === undefined) return {
      reason: 'This deployment requires an owning agent for tool execution.',
      info: { name: 'LyAgentSingleWriterError', code: 'LYAGENT_AGENT_REQUIRED' },
    }
    if (header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0) return undefined
    if (allowed.has(execution.name)) return undefined
    return {
      reason: 'Delegated agents may only use the configured read-only tools. Return the proposed change to the parent agent.',
      info: { name: 'LyAgentSingleWriterError', code: 'LYAGENT_PARENT_WRITE_REQUIRED' },
    }
  })
}
