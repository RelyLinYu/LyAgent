/** LyAgent identity contributions; native conversation and tool behavior remain unchanged. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { IconSettingsOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS, en, zh } from './locale.ts'
import s from './Brand.module.css'

/** The native slot registry owns all presentation contributions. */
export const inject = ['slots', 'locale']

function BrandName({ t }: PropsLocale<typeof NS>) { return <span title={t('attribution')}>{t('name')}</span> }
function BrandMark({ size, t }: SidebarBrandMarkOwnerProps & PropsLocale<typeof NS>) { return <span aria-hidden="true" className={s.mark} style={{ width:size,height:size,fontSize:size * .5 }}>{t('initials')}</span> }
function HeroMark({ t }: PropsLocale<typeof NS>) { return <span aria-hidden="true">{t('initials')}</span> }

/** Direct settings entry used by the competition surface instead of the account menu. */
function SettingsLauncher({ wide, openSettings, t }: PropsRuntime<'settings.launcher'> & PropsLocale<typeof NS>) {
  const label = t('settings')
  return <button type="button" className={s.settings} data-collapsed={!wide} aria-label={label} title={label}
    onClick={() => { openSettings() }}>
    <IconSettingsOutlineMedium size={16} />
    {wide && <span className={s.settingsLabel}>{label}</span>}
  </button>
}

/** Register replaceable identity occupants and unwind them with the plugin.
 * @param ctx - Browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'lyagent: identity dictionaries')
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark', locale: NS }, BrandMark))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', locale: NS }, BrandName))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark', locale: NS }, HeroMark))
  if (process.env.DSH_CLIENT_COMPETITION === 'true') {
    ctx.slots.inject('settings.launcher', () => ctx.slots.register({ name: 'settings.launcher', locale: NS }, SettingsLauncher))
  }
}
