/** Native right-sidebar task controls over the existing human command transport. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { IconCheckCircleFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { TaskController } from './controller.ts'
import { TaskPanel, TaskTitle } from './Panel.tsx'
import { NS, en, zh } from './locale.ts'

/** Native sidebar, locale and command services. */
export const inject = ['slots', 'locale', 'remote', 'remote.commands', 'sidebarRightTabs']
/** Register the optional task pane without changing ordinary chat execution.
 * @param ctx - native client plugin lifecycle.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'lyagent task dictionaries')
  const t = ctx.locale.bind(NS)
  const controllers = new Map<SessionId, TaskController>()
  ctx.effect(() => () => { for (const controller of controllers.values()) controller.dispose(); controllers.clear() })
  const provider = '@deepseek-ai/dsh-client-ui-lyagent-tasks'
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: provider, kind: 'lyagent-tasks', title: () => t('title'),
    guide: [{ id: 'tasks', order: 45, title: () => t('title'), icon: IconCheckCircleFillRegular }] }))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: provider, locale: NS,
    inject: (id: string) => {
      const sessionId = SessionId(id)
      let controller = controllers.get(sessionId)
      if (controller === undefined) {
        controller = new TaskController({ command: async (input) => {
          const executed = await ctx.remote.commands.executeFromPanel(sessionId, `/task ${input}`, [])
          if (!executed.ok) throw new Error(executed.error.message)
          if (executed.value?.result.kind !== 'success') throw new Error(t('unavailable'))
          return executed.value.result.text ?? ''
        } })
        controllers.set(sessionId, controller)
      }
      return controller.face()
    },
  }, TaskPanel))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: provider }, TaskTitle))
}
