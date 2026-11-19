/** Native sidebar management through the existing human command transport. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { AgentRoster } from './agents.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import z from '@deepseek-ai/schemastery'
import { IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { WorkflowController } from './controller.ts'
import { WorkflowPanel, WorkflowTitle } from './Panel.tsx'
import { AgentsPanel } from './AgentsPanel.tsx'
import { FleetView } from './FleetView.tsx'
import { createAgentsSnapshot } from './agents.ts'
import { NS, en, zh } from './locale.ts'

/** Roster presentation tunables. */
export interface Config {
  /** How far back from the newest child a settled child still joins the visible delegation batch. */
  batchWindowMs?: number
}
/** Validated roster presentation tunables. */
export const Config: z<Config> = z.object({ batchWindowMs: z.natural().min(1).default(90_000) })

/** Required sidebar, locale and generated command transport. */
export const inject = ['slots', 'locale', 'remote', 'remote.commands', 'sidebarRightTabs', 'sessions', 'uiWorkspace']

/** Register a session-owned management panel and retire pending mirrors on unload.
 * @param ctx - native client plugin lifecycle owner.
 * @param config - validated roster presentation tunables.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'lyagent workflow dictionaries')
  // A copied address may name a Session. The shell selects its default Session during mount,
  // so re-assert the address a few times instead of racing it once.
  const requestedSession = new URLSearchParams(globalThis.location?.search ?? '').get('session')
  if (requestedSession !== null && requestedSession !== '') {
    const target = SessionId(requestedSession)
    ctx.effect(() => {
      const timers = [150, 600, 1500].map(delay => setTimeout(() => {
        try { ctx.uiWorkspace.openSession(target) } catch { /* a stale address leaves the default Session */ }
      }, delay))
      return () => { for (const timer of timers) clearTimeout(timer) }
    })
  }
  const t = ctx.locale.bind(NS)
  const controllers = new Map<SessionId, WorkflowController>()
  ctx.effect(() => () => { for (const controller of controllers.values()) controller.dispose(); controllers.clear() })
  const provider = '@deepseek-ai/dsh-client-ui-lyagent-workflows'
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: provider, kind: 'lyagent-workflows', title: () => t('title'),
    guide: [{ id: 'workflows', order: 45, title: () => t('title'), icon: IconFolderOpenOutlineRegular }] }))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: provider, locale: NS,
    inject: (id: string) => {
      const sessionId = SessionId(id)
      let controller = controllers.get(sessionId)
      if (controller === undefined) {
        controller = new WorkflowController(async (input) => {
          const executed = await ctx.remote.commands.executeFromPanel(sessionId, `/saved-workflow ${input}`, [])
          if (!executed.ok) throw new Error(executed.error.message)
          if (executed.value?.result.kind !== 'success') throw new Error(t('unavailable'))
          return executed.value.result.text ?? ''
        })
        controllers.set(sessionId, controller)
      }
      return controller.face()
    },
  }, WorkflowPanel))
  const agentsProvider = '@deepseek-ai/dsh-client-ui-lyagent-agents'
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: agentsProvider, kind: 'lyagent-agents', title: () => t('agentsTitle'),
    guide: [{ id: 'agents', order: 46, title: () => t('agentsTitle'), icon: IconFolderOpenOutlineRegular }] }))
  const agentsSnapshots = new Map<SessionId, ObservableSnapshot<AgentRoster>>()
  const rosterFace = (sessionId: SessionId) => {
    let snapshot = agentsSnapshots.get(sessionId)
    if (snapshot === undefined) {
      snapshot = createAgentsSnapshot(ctx.sessions.list, sessionId,
        config.batchWindowMs === undefined ? {} : { batchWindowMs: config.batchWindowMs })
      agentsSnapshots.set(sessionId, snapshot)
    }
    // Child projections (turn outline, timing) are only served once asked for,
    // so each child is refreshed when it first appears.
    const primed = new Set<string>()
    const current = snapshot
    const prime = (): void => {
      for (const row of current.getSnapshot().rows) {
        if (primed.has(row.id)) continue
        primed.add(row.id)
        void ctx.sessions.refreshProjections(SessionId(row.id))
      }
    }
    prime()
    ctx.effect(() => ctx.sessions.list.subscribe(prime))
    return { hooks: { agents: snapshot }, openChild: (child: string) => { ctx.uiWorkspace.openSession(SessionId(child)) } }
  }
  // Fleet and roster readers need each child's own timing and catalog projections, which the
  // host only serves on request. Warm them whenever the catalog grows, not only when a panel opens.
  const warmed = new Set<string>()
  const warmChildren = (): void => {
    const state = ctx.sessions.list.getSnapshot()
    for (const [id, projection] of Object.entries(state.projectionsBySession)) {
      const catalog = (projection as { values?: { subagentCatalog?: readonly { id: string }[] } })
        .values?.subagentCatalog ?? []
      for (const child of catalog) {
        if (warmed.has(child.id)) continue
        warmed.add(child.id)
        void ctx.sessions.refreshProjections(SessionId(child.id))
      }
      void id
    }
  }
  warmChildren()
  ctx.effect(() => ctx.sessions.list.subscribe(warmChildren))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: agentsProvider, locale: NS,
    inject: (id: string) => rosterFace(SessionId(id)),
  }, AgentsPanel))
  // The fleet tab sits beside the conversation and trajectory views, mirroring the installed team panel.
  // Conversation views read their data from session projections, so this registration carries no inject face.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'lyagent-fleet', order: 20, label: () => t('fleetTitle'), locale: NS,
  }, FleetView))
  ctx.effect(() => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: provider }, WorkflowTitle))
}
