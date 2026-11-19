/** Native session sidebar integration over zero-model human commands. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { KnowledgeController } from './controller.ts'
import { KnowledgePanel, KnowledgeTitle } from './Panel.tsx'
import { NS, en, zh } from './locale.ts'

/** Required native sidebar, uploads and generated command transport. */
export const inject = ['slots', 'locale', 'remote', 'remote.commands', 'fileUpload', 'sidebarRightTabs']

/** Register the optional knowledge tab and own each session mirror through plugin disposal.
 * @param ctx - native client plugin lifecycle.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'lyagent knowledge dictionaries')
  const t = ctx.locale.bind(NS)
  const controllers = new Map<SessionId, KnowledgeController>()
  ctx.effect(() => () => { for (const controller of controllers.values()) controller.dispose(); controllers.clear() })
  const provider = '@deepseek-ai/dsh-client-ui-lyagent-knowledge'
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: provider, kind: 'lyagent-knowledge', title: () => t('title'),
    guide: [{ id: 'knowledge', order: 40, title: () => t('title'), icon: IconFolderOpenOutlineRegular }] }))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: provider, locale: NS,
    inject: (id: string) => {
      const sessionId = SessionId(id)
      let controller = controllers.get(sessionId)
      if (controller === undefined) {
        controller = new KnowledgeController({ command: async (input, files = []) => {
          const attachments: { type: 'file'; receiptId: string }[] = []
          for (const file of files) {
            const uploaded = await ctx.fileUpload.upload(sessionId, file, file.name)
            if (!uploaded.ok) throw new Error(uploaded.error.message)
            attachments.push({ type: 'file', receiptId: uploaded.value.receiptId })
          }
          const executed = await ctx.remote.commands.executeFromPanel(sessionId, `/knowledge ${input}`, attachments)
          if (!executed.ok) throw new Error(executed.error.message)
          if (executed.value?.result.kind !== 'success') throw new Error(t('unavailable'))
          return executed.value.result.text ?? ''
        } })
        controllers.set(sessionId, controller)
      }
      return controller.face()
    },
  }, KnowledgePanel))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: provider }, KnowledgeTitle))
}
