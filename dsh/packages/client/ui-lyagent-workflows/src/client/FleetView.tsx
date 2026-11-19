/** Conversation view: delegation graph, fleet members, shared task board and usage in one place. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-agent-team/client'
import type {} from '@deepseek-ai/dsh-subagent/src/projection-types.ts'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type { NS } from './locale.ts'
import css from './FleetView.module.css'

/** One task row this view renders, narrowed from the Team projection. */
interface FleetTask {
  readonly id: string
  readonly subject: string
  readonly status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  readonly ownerName?: string
}

/** Task board projection bound to the current conversation. */
interface FleetTeam {
  readonly enabled: boolean
  readonly tasks: readonly FleetTask[]
  readonly failure?: string
}

/** Token totals the meter publishes for this conversation. */
interface FleetUsage {
  readonly uncachedInputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** Prompt-side pressure of the newest request. */
interface FleetPressure {
  readonly pressureTokens?: number
  readonly projectedTokens?: number
  readonly contextWindow?: number
}

/** A catalog child plus the timing facts the parent projection published for it. */
interface FleetMember {
  readonly id: string
  readonly name: string
  readonly mode: string
  readonly running: boolean | undefined
  readonly settledMs: number
  readonly children: readonly string[]
}

/** Members that belong to one run share a prefix such as `demo-schedule`. */
interface FleetGroup {
  readonly key: string
  readonly members: readonly FleetMember[]
  readonly running: number
}

/** Format one age the way the roster shows it. */
function ageOf(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

/** Compact token count for a header stat. */
function compactTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/** Keep the current address (token included) and point it at one child Session. */
function childHref(sessionId: string): string {
  const params = new URLSearchParams(globalThis.location?.search ?? '')
  params.set('session', sessionId)
  return `?${params.toString()}`
}

/** Drop the run suffix so every member of one run collapses under one row. */
function groupKeyOf(name: string): string {
  return name.replace(/\s+child\s*\d+$/i, '').trim() || name
}

/** Group members by their run so a large fleet stays readable. */
function groupMembers(members: readonly FleetMember[]): FleetGroup[] {
  const groups = new Map<string, FleetMember[]>()
  for (const member of members) {
    const key = groupKeyOf(member.name)
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [member])
    else bucket.push(member)
  }
  return [...groups.entries()]
    .map(([key, bucket]) => ({ key, members: bucket, running: bucket.filter(member => member.running === true).length }))
    .sort((left, right) => right.members.length - left.members.length || left.key.localeCompare(right.key))
}

type Props = PropsRuntime<'conversation.view'> & PropsLocale<typeof NS>

/** @param props - conversation runtime seat and localized copy. @returns the fleet overview. */
export function FleetView(props: Props) {
  const { t } = props
  const root = useRef<HTMLElement | null>(null)
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const team = props.useProjection('agentTeam') as FleetTeam | undefined
  const catalog = props.useProjection('subagentCatalog') as readonly {
    readonly id: string, readonly createdAt: number, readonly mode: string
    readonly label?: string, readonly name?: string
  }[] | undefined
  const usage = props.useProjection('tokenUsage') as FleetUsage | undefined
  const pressure = props.useProjection('contextPressure') as FleetPressure | undefined
  const timing = props.useSessions(state => state.projectionsBySession)
  const members: FleetMember[] = (catalog ?? []).map(entry => {
    const projection = timing[entry.id as keyof typeof timing] as
      { readonly values?: {
        readonly subagentTiming?: { readonly active?: unknown, readonly settledMs?: number }
        readonly subagentCatalog?: readonly { readonly id: string, readonly label?: string, readonly name?: string }[]
      } } | undefined
    const facts = projection?.values?.subagentTiming
    const children = projection?.values?.subagentCatalog ?? []
    return {
      id: entry.id,
      name: entry.label ?? entry.name ?? entry.id.slice(0, 8),
      mode: entry.mode,
      running: facts === undefined ? undefined : facts.active !== undefined,
      settledMs: facts?.settledMs ?? 0,
      children: children.map(child => child.label ?? child.name ?? child.id.slice(0, 8)),
    }
  })
  const groups = useMemo(() => groupMembers(members), [members])
  const tasks = (team?.tasks ?? []).filter(task => task.status !== 'deleted')
  const running = members.filter(member => member.running === true).length
  const settled = members.filter(member => member.running === false).length
  const done = tasks.filter(task => task.status === 'completed').length
  const usedContext = pressure?.projectedTokens ?? pressure?.pressureTokens
  const contextPercent = usedContext === undefined || pressure?.contextWindow === undefined
    ? undefined
    : Math.min(100, Math.round(usedContext / pressure.contextWindow * 100))
  const totalTokens = usage === undefined ? undefined
    : (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0)
  const showAll = expanded.includes('*')
  const isOpen = (key: string): boolean => showAll || expanded.includes(key)

  /** Switching seats must land on the header instead of inheriting the transcript offset. */
  useEffect(() => {
    root.current?.scrollIntoView({ block: 'start' })
  }, [])

  return (
    <section className={css.fleet} data-fleet-view ref={root}>
      <header className={css.head}>
        <h2 className={css.title}>{t('fleetTitle')}</h2>
        <div className={css.stats}>
          <span data-fleet-stat="running">{t('fleetStatRunning', { count: String(running) })}</span>
          <span data-fleet-stat="settled">{t('fleetStatSettled', { count: String(settled) })}</span>
          <span data-fleet-stat="tasks">{t('fleetStatTasks', { count: String(done), total: String(tasks.length) })}</span>
          {contextPercent === undefined ? null : <span data-fleet-stat="context">{t('fleetStatContext', { percent: String(contextPercent) })}</span>}
          {totalTokens === undefined ? null : <span data-fleet-stat="tokens">{t('fleetStatTokens', { count: compactTokens(totalTokens) })}</span>}
        </div>
      </header>
      <section className={css.card} data-fleet-card="graph">
        <header className={css.cardHead}>
          <span>{t('fleetGraph')}</span>
          <span className={css.cardCount} data-fleet-graph-count>{`1 → ${members.length}`}</span>
        </header>
        <div className={css.graph}>
          <span className={css.node} data-fleet-root data-status="root">{t('fleetGraphRoot')}</span>
          {members.length === 0
            ? <span className={css.graphEmpty}>{t('agentsEmpty')}</span>
            : groups.map(group => (
              <span key={group.key} className={css.nodeGroup} data-fleet-node={group.key}
                data-status={group.running > 0 ? 'running' : 'settled'}>
                <span className={css.node} data-status={group.running > 0 ? 'running' : 'settled'}>{group.key}</span>
                <span className={css.groupCount}>{t('fleetGroupCount', { count: String(group.members.length) })}</span>
              </span>
            ))}
        </div>
      </section>
      <div className={css.grid}>
        <section className={css.card} data-fleet-card="members">
          <header className={css.cardHead}>
            <span>{t('fleetMembers')}</span>
            <span className={css.cardCount} data-fleet-members-count>{`${running}/${members.length}`}</span>
          </header>
          {members.length === 0
            ? <p className={css.empty}>{t('agentsEmpty')}</p>
            : (
              <>
                <ul className={css.list}>
                  {groups.map(group => (
                    <li key={group.key} className={css.group} data-fleet-group={group.key}>
                      <button type="button" className={css.groupRow}
                        aria-expanded={isOpen(group.key)}
                        data-fleet-group-toggle={group.key}
                        onClick={() => setExpanded(current => (
                          current.includes(group.key)
                            ? current.filter(item => item !== group.key)
                            : [...current, group.key]
                        ))}>
                        <span className={css.dot} aria-hidden="true" data-status={group.running > 0 ? 'running' : 'settled'} />
                        <span className={css.memberName}>{group.key}</span>
                        <span className={css.groupCount}>{t('fleetGroupCount', { count: String(group.members.length) })}</span>
                        {group.running === 0
                          ? null
                          : <span className={css.memberTime}>{t('fleetStatRunning', { count: String(group.running) })}</span>}
                      </button>
                      {isOpen(group.key)
                        ? (
                          <ul className={css.list}>
                            {group.members.map(member => (
                              <li key={member.id} data-fleet-member={member.id}
                                data-status={member.running === true ? 'running' : 'settled'}>
                                <a className={css.member} href={childHref(member.id)}>
                                  <span className={css.dot} aria-hidden="true" data-status={member.running === true ? 'running' : 'settled'} />
                                  <span className={css.memberName}>{member.name}</span>
                                  <span className={css.memberMode}>{member.mode}</span>
                                  <span className={css.memberTime}>{member.settledMs === 0 ? '—' : ageOf(member.settledMs)}</span>
                                </a>
                                {member.children.length === 0 ? null : (
                                  <ul className={css.children}>
                                    {member.children.map(child => <li key={child} className={css.child}>{child}</li>)}
                                  </ul>
                                )}
                              </li>
                            ))}
                          </ul>
                        )
                        : null}
                    </li>
                  ))}
                </ul>
                {groups.length <= 3
                  ? null
                  : (
                    <button type="button" className={css.showAll} data-fleet-expand-all
                      onClick={() => setExpanded(showAll ? [] : ['*'])}>
                      {showAll ? t('fleetCollapse') : t('fleetShowAll')}
                    </button>
                  )}
              </>
            )}
        </section>
        <section className={css.card} data-fleet-card="tasks">
          <header className={css.cardHead}>
            <span>{t('fleetTasks')}</span>
            <span className={css.cardCount} data-fleet-tasks-count>{`${done}/${tasks.length}`}</span>
          </header>
          {team === undefined || !team.enabled
            ? <p className={css.empty}>{t('fleetTasksOff')}</p>
            : tasks.length === 0
              ? <p className={css.empty}>{t('fleetTasksEmpty')}</p>
              : (
                <ul className={css.list}>
                  {tasks.map(task => (
                    <li key={task.id} className={css.task} data-fleet-task={task.id} data-status={task.status}>
                      <span className={css.dot} aria-hidden="true" data-status={task.status} />
                      <span className={css.taskSubject}>{task.subject}</span>
                      <span className={css.taskMeta}>{task.ownerName ?? t('fleetTaskUnowned')} · {t(`fleetTaskStatus.${task.status}` as 'fleetTaskStatus.pending')}</span>
                    </li>
                  ))}
                </ul>
              )}
        </section>
      </div>
      {team?.failure === undefined ? null : <p className={css.warning}>{team.failure}</p>}
    </section>
  )
}
