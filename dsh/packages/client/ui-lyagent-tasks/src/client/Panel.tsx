/** Native task controls; registration never starts execution implicitly. */
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Input, IconCheckCircleFillRegular, IconRefreshOutlineRegular, IconPlayOutlineRegular, IconStopFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TaskFace } from './controller.ts'
import css from './Panel.module.css'

type Props = PropsLocale<'lyagent.tasks'> & InjectFace<TaskFace>
/** @param props - session-bound task mirror and explicit user actions. @returns native sidebar task controls. */
export function TaskPanel(props: Props) {
  const state = props.useTasks(value => value)
  const { t } = props
  const id = useId()
  const [objective, setObjective] = useState('')
  const [path, setPath] = useState('')
  const [includes, setIncludes] = useState('')
  const idle = !state.busy && !state.cancelling
  // 首次打开面板时自动装载任务页；命令面在会话绑定完成前可能不可用，控制器内部会短暂重试。
  const ensureLoaded = useRef(props.ensureLoaded)
  useEffect(() => { void ensureLoaded.current() }, [])
  return <div className={css.panel}>
    <header className={css.header}><h2>{t('title')}</h2><Button size="sm" variant="outline" disabled={!idle}
      onClick={() => { void props.refresh() }}><IconRefreshOutlineRegular size={14} />{t(state.loaded ? 'refresh' : 'load')}</Button></header>
    <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      const submitted = objective
      const requirement = path.trim() || includes.trim() ? { path, includes } : undefined
      const registration = requirement === undefined ? props.register(submitted) : props.register(submitted, requirement)
      void registration.then((saved) => {
        if (saved) { setObjective(value => value === submitted ? '' : value); setPath(''); setIncludes('') }
      })
    }}>
      <label htmlFor={id}>{t('objective')}</label><Input id={id} value={objective} disabled={!idle} maxLength={4000}
        onChange={(event) => { setObjective(event.target.value) }} />
      <details><summary>{t('additional')}</summary><div className={css.form}>
        <label htmlFor={`${id}-path`}>{t('artifactPath')}</label>
        <Input id={`${id}-path`} value={path} maxLength={240} disabled={!idle}
          onChange={(event) => { setPath(event.target.value) }} />
        <label htmlFor={`${id}-includes`}>{t('requiredText')}</label>
        <Input id={`${id}-includes`} value={includes} maxLength={4000} disabled={!idle || !path.trim()}
          onChange={(event) => { setIncludes(event.target.value) }} />
      </div></details>
      <Button type="submit" size="sm" variant="primary" disabled={!idle || !objective.trim()}>{t('register')}</Button>
    </form>
    <div className={css.feedback} aria-live="polite">{state.error ? t('failed') : state.message ? t(state.message) : ''}</div>
    {state.criteria !== undefined && <section className={css.criteria}><h3>{t('criteria')}</h3>
      <ul>{state.criteria.artifacts.map(file => <li key={file.path}><span>{file.path}</span>
        <span>{file.minBytes} - {file.maxBytes} B</span></li>)}</ul>
      <dl><dt>{t('tests')}</dt><dd>{state.criteria.minTests}</dd><dt>{t('repairs')}</dt><dd>{state.criteria.maxRepairs}</dd></dl>
    </section>}
    {state.loaded && !state.page.tasks.length && <p>{t('empty')}</p>}
    <ul className={css.list}>{state.page.tasks.map((task) => {
      const running = state.running === task.id || task.state === 'running' || task.state === 'checking'
      const actionable = task.state === 'queued' || task.state === 'needs_attention'
      return <li className={css.row} key={task.id}><h3>{task.objective}</h3>
        <div className={css.status}>{t(running ? 'running' : task.state)}</div>
        {task.reason && <p className={css.reason}>{task.reason}</p>}
        <div className={css.actions}>
          {actionable && !running && <Button variant="primary" size="sm" disabled={!idle}
            onClick={() => { void props.run(task.id) }}><IconPlayOutlineRegular size={14} />{t('run')}</Button>}
          {(actionable || running) && <Button variant="outline" size="sm" disabled={state.cancelling || state.busy && state.running !== task.id}
            onClick={() => { void props.cancel(task.id) }}><IconStopFillRegular size={14} />{t('cancel')}</Button>}
        </div>
      </li>
    })}</ul>
    {state.page.next && <Button size="sm" variant="outline" disabled={!idle} onClick={() => { void props.refresh(state.page.next) }}>{t('next')}</Button>}
    {state.loaded && <Button size="sm" variant="ghost" disabled={!idle} onClick={() => { void props.refresh() }}>{t('first')}</Button>}
  </div>
}
/** @param props - native sidebar title data. @returns task glyph and localized tab name. */
export function TaskTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
  return <><IconCheckCircleFillRegular size={16} />{useTabInfo().tab.title}</>
}
