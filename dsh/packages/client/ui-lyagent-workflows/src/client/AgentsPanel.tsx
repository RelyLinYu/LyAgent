/** Roster of the child agents this conversation has delegated work to. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { AgentRoster, AgentRow } from './agents.ts'
import css from './Panel.module.css'
import type { NS } from './locale.ts'

interface Props extends Pick<PropsLocale<typeof NS>, 't'> {
  /** Bound roster hook from the inject face. */
  readonly useAgents: <T>(selector: (value: AgentRoster) => T) => T
  /** Open one child conversation in the workspace browser. */
  readonly openChild: (sessionId: string) => void
}

/** Format one age the way the roster shows it. */
function ageOf(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

/** @param props - localized seat plus the bound roster hook. @returns the delegated-agent roster. */
export function AgentsPanel({ t, useAgents, openChild }: Props) {
  const roster = useAgents(value => value)
  const rows = roster.rows
  return (
    <section className={css.agents} data-agents-panel>
      <header className={css.agentsHead}>
        <span>{t('agentsTitle')}</span>
        <span className={css.agentsCount} data-agents-count>{`${rows.filter((row: AgentRow) => row.running).length}/${rows.length}`}{roster.total > rows.length ? ` · ${t('agentsTotal')} ${roster.total}` : ''}</span>
      </header>
      {rows.length === 0
        ? <p className={css.agentsEmpty}>{t('agentsEmpty')}</p>
        : (
          <ul className={css.agentsList}>
            {rows.map((row: AgentRow) => (
              <li key={row.id} data-status={row.running ? 'running' : 'settled'}>
                <button type="button" className={css.agentRow} data-status={row.running ? 'running' : 'settled'} onClick={() => { openChild(row.id) }}>
                  <span className={css.agentDot} aria-hidden="true" />
                  <span className={css.agentName}>{row.name}</span>
                  <span className={css.agentMode}>{row.title ?? row.mode}</span>
                  <span className={css.agentTime}>
                    {ageOf(row.running ? roster.now - row.createdAt : row.settledMs || roster.now - row.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
