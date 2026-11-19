/** Native controls for human-saved routes, teams and workflow scripts. */
import { useEffect, useId, useRef, useState } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { z } from 'zod'
import { Button, Checkbox, Input, Menu, SegmentedControl, IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { WorkflowFace } from './controller.ts'
import css from './Panel.module.css'
import { PlanPreview } from './PlanPreview.tsx'

type Kind = 'profile' | 'team' | 'workflow'
type Props = Pick<PropsLocale<'lyagent.workflows'> & InjectFace<WorkflowFace>, 't' | 'useCatalog' | 'refresh' | 'save' | 'run' | 'read' | 'readDraft' | 'retainDraft' | 'ensureLoaded'>
interface Member { key: string; role: string; profile: { id: string; version: number } }

/** @param props - localized catalog hooks and session-bound actions. @returns management forms and retained version rows. */
export function WorkflowPanel(props: Props) {
  const { t } = props
  const state = props.useCatalog(value => value)
  const uid = useId()
  const [restored] = useState(() => props.readDraft())
  const [kind, setKind] = useState<Kind>(restored?.kind ?? 'profile')
  const [id, setId] = useState(() => restored?.id ?? `definition_${randomUUID()}`)
  const [version, setVersion] = useState(restored?.version ?? 0)
  const [latestVersion, setLatestVersion] = useState(restored?.latestVersion ?? 0)
  const [revisions, setRevisions] = useState<Record<string, number>>({})
  const [name, setName] = useState(restored?.name ?? '')
  const [instructions, setInstructions] = useState(restored?.instructions ?? '')
  const [provider, setProvider] = useState(restored?.provider ?? '')
  const [model, setModel] = useState(restored?.model ?? '')
  const [enabled, setEnabled] = useState(restored?.enabled ?? true)
  const [script, setScript] = useState(restored?.script ?? '')
  const [members, setMembers] = useState<Member[]>(restored?.members ?? [])
  const [menu, setMenu] = useState<string | null>(null)
  const [dirty, setDirty] = useState(restored?.dirty ?? false)
  const { retainDraft } = props
  // 首次打开面板时自动装载目录；命令面在会话绑定完成前可能不可用，控制器内部会短暂重试。
  const ensureLoaded = useRef(props.ensureLoaded)
  useEffect(() => { void ensureLoaded.current() }, [])
  useEffect(() => {
    retainDraft({ kind, id, version, latestVersion, name, instructions, provider, model, enabled, script, members, dirty })
  }, [retainDraft, kind, id, version, latestVersion, name, instructions, provider, model, enabled, script, members, dirty])
  const entries = kind === 'workflow' ? state.workflows : state.teams.filter(entry => entry.kind === kind)
  const profiles = state.teams.filter(entry => entry.kind === 'profile')
  const valid = name.trim().length > 0 && (kind === 'profile' ? instructions.trim().length > 0 && provider.trim().length > 0 && model.trim().length > 0
    : kind === 'workflow' ? script.trim().length > 0 : members.length > 0
      && new Set(members.map(member => member.role.trim())).size === members.length
      && members.every(member => /^[a-zA-Z0-9_-]{1,80}$/.test(member.role.trim()) && member.profile.id
        && Number.isInteger(member.profile.version) && member.profile.version > 0
        && member.profile.version <= (profiles.find(profile => profile.id === member.profile.id)?.version ?? 0)))
  const reset = () => { setId(`definition_${randomUUID()}`); setVersion(0); setName(''); setInstructions(''); setProvider(''); setModel(''); setEnabled(true); setScript(''); setMembers([]); setDirty(false) }
  const edit = async (identity: string, revision: number) => {
    const value = await props.read(kind, identity, revision)
    if (value === undefined) return
    setLatestVersion(entries.find(entry => entry.id === identity)?.version ?? revision)
    const text = (field: unknown) => z.string().catch('').parse(field)
    setId(identity); setVersion(revision); setName(text(value.description))
    setInstructions(text(value.instructions)); setProvider(text(value.provider)); setModel(text(value.model))
    setEnabled(value.enabled === true); setScript(text(value.script))
    const rows = Array.isArray(value.members) ? value.members : []
    setMembers(rows.flatMap((row: unknown) => {
      if (typeof row !== 'object' || row === null || !('role' in row) || !('profile' in row)) return []
      const pin = row.profile
      if (typeof pin !== 'object' || pin === null || !('id' in pin) || !('version' in pin)) return []
      return [{ key: randomUUID(), role: String(row.role), profile: { id: String(pin.id), version: Number(pin.version) } }]
    })); setDirty(false)
  }
  return <div className={css.panel}>
    <header className={css.header}><h2>{t('title')}</h2><Button size="sm" variant="outline" disabled={state.busy} onClick={() => { void props.refresh() }}>{t('refresh')}</Button></header>
    <SegmentedControl id={`${uid}-mode`} value={kind} label={t('title')} disabled={state.busy || dirty} options={[{ value: 'profile', label: t('profiles') }, { value: 'team', label: t('teams') }, { value: 'workflow', label: t('workflows') }]} onChange={(value) => { setKind(value); reset() }} />
    <div role="tabpanel" id={`${uid}-mode-${kind}-panel`} aria-labelledby={`${uid}-mode-${kind}`}>
      <ul className={css.list}>{entries.map(entry => <li key={entry.id} className={css.row}>
        <div><span>{entry.description}</span><span className={css.meta}>{t('metaVersion', { version: entry.version })}</span></div>
        <div className={css.rowActions}>
          <Input type="number" min={1} max={entry.version} step={1} aria-label={`${entry.description} ${t('version')}`}
            value={revisions[entry.id] ?? entry.version} disabled={state.busy || dirty}
            onChange={(event) => { setRevisions(values => ({ ...values, [entry.id]: Number(event.target.value) })) }} />
          <Button size="sm" variant="outline" disabled={state.busy || dirty}
            onClick={() => {
              const revision = revisions[entry.id] ?? entry.version
              if (Number.isInteger(revision) && revision > 0 && revision <= entry.version) void edit(entry.id, revision)
            }}>{t('choose')}</Button>
        </div>
      </li>)}</ul>
      {state.loaded && entries.length === 0 && <p className={css.meta}>{t('empty')}</p>}
      <form className={css.form} onSubmit={(event) => {
        event.preventDefault()
        if (!valid) return
        const definition = kind === 'profile' ? { description: name.trim(), instructions, provider: provider.trim(), model: model.trim(), enabled }
          : kind === 'team' ? { description: name.trim(), members: members.map(member => ({ role: member.role.trim(), profile: member.profile })) }
            : { description: name.trim(), script }
        const expectedVersion = version === 0 ? 0 : latestVersion
        void props.save(kind, id, expectedVersion, definition).then((saved) => {
          if (saved) { setVersion(expectedVersion + 1); setLatestVersion(expectedVersion + 1); setDirty(false) }
          // A new role only becomes selectable for team members after the entry
          // list reloads, so the panel refreshes itself on commit.
          if (saved) void props.refresh()
        })
      }}>
        <div className={css.actions}><Button size="sm" variant="outline" disabled={state.busy} onClick={reset}>{dirty ? t('discard') : t('create')}</Button>{version > 0 && <span className={css.meta}>{t('version')} {version}</span>}</div>
        <label htmlFor={`${uid}-name`}>{t('name')}</label><Input id={`${uid}-name`} maxLength={1000} value={name} disabled={state.busy} onChange={(event) => { setName(event.target.value); setDirty(true) }} />
        {kind === 'profile' && <>
          <label htmlFor={`${uid}-instructions`}>{t('instructions')}</label><textarea id={`${uid}-instructions`} maxLength={16000} value={instructions} disabled={state.busy} onChange={(event) => { setInstructions(event.target.value); setDirty(true) }} />
          <label htmlFor={`${uid}-provider`}>{t('provider')}</label><Input id={`${uid}-provider`} value={provider} disabled={state.busy} onChange={(event) => { setProvider(event.target.value); setDirty(true) }} />
          <label htmlFor={`${uid}-model`}>{t('model')}</label><Input id={`${uid}-model`} value={model} disabled={state.busy} onChange={(event) => { setModel(event.target.value); setDirty(true) }} />
          <Checkbox label={t('enabled')} checked={enabled} disabled={state.busy} onChange={(value) => { setEnabled(value); setDirty(true) }} />
        </>}
        {kind === 'workflow' && <><label htmlFor={`${uid}-script`}>{t('script')}</label><textarea id={`${uid}-script`} className={css.script} value={script} disabled={state.busy} onChange={(event) => { setScript(event.target.value); setDirty(true) }} /><PlanPreview t={t} /></>}
        {kind === 'team' && <fieldset className={css.members}><legend>{t('members')}</legend>{members.map(member => <div key={member.key} className={css.member}>
          <Input aria-label={t('role')} value={member.role} maxLength={80} disabled={state.busy} onChange={(event) => { setMembers(rows => rows.map(row => row.key === member.key ? { ...row, role: event.target.value } : row)); setDirty(true) }} />
          <Menu open={menu === member.key} portal compact anchor={<Button size="sm" variant="outline" disabled={state.busy} aria-haspopup="menu" aria-expanded={menu === member.key} onClick={() => { setMenu(menu === member.key ? null : member.key) }}>{profiles.find(profile => profile.id === member.profile.id)?.description ?? t('profile')} {member.profile.id ? t('metaVersion', { version: member.profile.version }) : ''}</Button>}
            items={profiles.map(profile => ({ id: profile.id, label: `${profile.description} ${t('metaVersion', { version: profile.version })}` }))} onClose={() => { setMenu(null) }} onSelect={(selected) => {
              const profile = profiles.find(profile => profile.id === selected)
              if (profile !== undefined) {
                setMembers(rows => rows.map(row => row.key === member.key
                  ? { ...row, profile: { id: profile.id, version: profile.version } } : row))
                setDirty(true)
              }
              setMenu(null)
            }} />
          <Input type="number" min={1} step={1}
            max={profiles.find(profile => profile.id === member.profile.id)?.version ?? 1}
            aria-label={`${member.role || t('role')} ${t('version')}`} value={member.profile.version}
            disabled={state.busy || !member.profile.id} onChange={(event) => {
              const revision = Number(event.target.value)
              setMembers(rows => rows.map(row => row.key === member.key
                ? { ...row, profile: { ...row.profile, version: revision } } : row))
              setDirty(true)
            }} />
          <Button size="sm" variant="outline" disabled={state.busy} onClick={() => { setMembers(rows => rows.filter(row => row.key !== member.key)); setDirty(true) }}>{t('remove')}</Button>
        </div>)}<Button size="sm" variant="outline" disabled={state.busy || profiles.length === 0 || members.length >= 32} onClick={() => { setMembers(rows => [...rows, { key: randomUUID(), role: '', profile: { id: '', version: 1 } }]); setDirty(true) }}>{t('add')}</Button></fieldset>}
        <div className={css.actions}><Button type="submit" size="sm" variant="primary" disabled={state.busy || !dirty || !valid}>{t('save')}</Button>{kind === 'workflow' && version > 0 && <Button size="sm" variant="outline" disabled={state.busy || dirty} onClick={() => { void props.run(id, version) }}>{t('run')}</Button>}</div>
      </form>
    </div>
    <div className={css.feedback} aria-live="polite">{state.busy ? t('busy') : state.error ? t('failed') : state.saved ? t('saved') : null}</div>
  </div>
}

/** @param props - native right-sidebar tab information. @returns the localized title and shared glyph. */
export function WorkflowTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
  return <><IconFolderOpenOutlineRegular size={16} />{useTabInfo().tab.title}</>
}
