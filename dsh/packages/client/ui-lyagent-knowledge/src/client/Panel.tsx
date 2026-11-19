/** Native sidebar knowledge import and exact-version authorization controls. */
import { useEffect, useId, useRef, useState } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { Button, Input, Menu, IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { KnowledgeFace } from './controller.ts'
import css from './Panel.module.css'

type Props = Pick<PropsLocale<'lyagent.knowledge'> & InjectFace<KnowledgeFace>,
  't' | 'useKnowledge' | 'refresh' | 'ensureLoaded' | 'importFiles' | 'grant' | 'revoke' | 'archive'>

/** @param props - native scoped hooks, locale and session-owned actions. @returns the knowledge control surface. */
export function KnowledgePanel(props: Props) {
  const state = props.useKnowledge(value => value)
  const { t } = props
  const id = useId()
  const [collection, setCollection] = useState(() => `refs_${randomUUID()}`)
  const [title, setTitle] = useState('')
  const [files, setFiles] = useState<readonly File[]>([])
  const [versions, setVersions] = useState<Record<string, number>>({})
  const [versionMenu, setVersionMenu] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  // 首次打开面板时自动装载集合与授权；命令面在会话绑定完成前可能不可用，控制器内部会短暂重试。
  const ensureLoaded = useRef(props.ensureLoaded)
  useEffect(() => { void ensureLoaded.current() }, [])
  const valid = /^[a-zA-Z0-9_-]{1,80}$/.test(collection) && title.trim().length > 0 && files.length > 0
  return <div className={css.panel}>
    <header className={css.header}><h2>{t('title')}</h2><Button size="sm" variant="outline" disabled={state.busy} onClick={() => { void props.refresh() }}>{t(state.loaded ? 'refresh' : 'load')}</Button></header>
    <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      if (valid) void props.importFiles(collection, title.trim(), files)
    }}>
      <label htmlFor={`${id}-name`}>{t(editing ? 'editionName' : 'name')}</label><Input id={`${id}-name`} maxLength={240} value={title} disabled={state.busy} onChange={(event) => { setTitle(event.target.value) }} />
      <label htmlFor={`${id}-files`}>{t('files')}</label><input ref={fileInput} id={`${id}-files`} type="file" multiple accept=".txt,.md,.csv,.tsv,.json,.log" disabled={state.busy} onChange={(event) => { setFiles(Array.from(event.target.files ?? [])) }} />
      <Button type="submit" variant="primary" size="sm" disabled={state.busy || !valid} icon={<IconFolderOpenOutlineRegular size={16} />}>{t('import')}</Button>
      <Button type="button" variant="outline" size="sm" disabled={state.busy} onClick={() => {
        setCollection(`refs_${randomUUID()}`); setTitle(''); setFiles([]); setEditing(false)
        if (fileInput.current !== null) fileInput.current.value = ''
      }}>{t('newCollection')}</Button>
    </form>
    <div className={css.feedback} aria-live="polite">{state.busy ? t('busy') : state.error ? t('failed') : state.saved ? t('changed') : null}</div>
    {state.error && <Button variant="outline" size="sm" disabled={state.busy} onClick={() => { void props.refresh() }}>{t('refresh')}</Button>}
    {state.loaded && state.page.collections.length === 0 && <p>{t('empty')}</p>}
    <ul className={css.list}>{state.page.collections.map((item) => {
      const version = versions[item.collection] ?? item.versions.at(-1) ?? 1
      const granted = state.grants.pins.find(pin => pin.collection === item.collection)
      return <li key={item.collection} className={css.row}>
        <div><h3>{item.title}</h3><span className={css.meta}>{item.collection}{item.archived ? ` · ${t('archived')}` : ''}{granted ? t('grantedVersion', { version: granted.version }) : ''}</span></div>
        <div className={css.actions}><Menu open={versionMenu === item.collection} portal compact
          anchor={<Button size="sm" variant="outline" disabled={state.busy || item.archived}
            aria-haspopup="menu" aria-expanded={versionMenu === item.collection}
            onClick={() => { setVersionMenu(versionMenu === item.collection ? null : item.collection) }}>
            {t('version')} {version}</Button>}
          items={item.versions.map(value => ({ id: String(value), label: String(value) }))} selectedId={String(version)}
          onClose={() => { setVersionMenu(null) }} onSelect={(value) => {
            setVersions(previous => ({ ...previous, [item.collection]: Number(value) })); setVersionMenu(null)
          }} />
        <Button size="sm" variant="outline" disabled={state.busy || item.archived} onClick={() => { void props.grant(item.collection, version) }}>{t('grant')}</Button>
        <Button size="sm" variant="outline" disabled={state.busy || item.archived} onClick={() => {
          setCollection(item.collection); setTitle(item.title); setEditing(true)
          fileInput.current?.focus()
        }}>{t('edition')}</Button>
        <Button size="sm" variant="ghost" disabled={state.busy || item.archived} onClick={() => { void props.archive(item.collection) }}>{t('archive')}</Button></div>
      </li>
    })}</ul>
    <footer className={css.actions}><Button size="sm" variant="outline" disabled={state.busy || !state.grants.pins.length} onClick={() => { void props.revoke() }}>{t('revoke')}</Button><Button size="sm" disabled={state.busy} onClick={() => { void props.refresh() }}>{t('back')}</Button>{state.page.next && <Button size="sm" variant="outline" disabled={state.busy} onClick={() => { void props.refresh(state.page.next) }}>{t('next')}</Button>}</footer>
  </div>
}

/** @param props - native tab information. @returns the standard folder glyph and localized tab title. */
export function KnowledgeTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
  return <><IconFolderOpenOutlineRegular size={16} />{useTabInfo().tab.title}</>
}
