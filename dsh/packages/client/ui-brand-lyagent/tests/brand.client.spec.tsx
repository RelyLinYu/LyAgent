// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { NS, en, zh } from '../src/client/locale.ts'
import { apply, inject } from '../src/client/index.tsx'
import { apply as hostApply } from '../src/index.ts'

afterEach(() => { cleanup(); vi.unstubAllEnvs() })

it('keeps the host entry inert and declares presentation services', () => {
  expect(hostApply).not.toThrow()
  expect(inject).toEqual(['slots', 'locale'])
})

it('fills native identity slots and removes occupants when disposed', async () => {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const slots = ctx.get('slots') as SlotRegistry
  const names = ['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark'] as const
  slots.register({ name:'root', children:Object.fromEntries(names.map(name => [name,{ kind:'single',scope:'root' }])) } as never, () => null)
  const fiber = ctx.plugin({ inject:[...inject],apply })
  await fiber.await()
  expect(locale.bind(NS)('attribution')).toBe(en.attribution)
  locale.setLocale('zh')
  expect(locale.bind(NS)('attribution')).toBe(zh.attribution)
  for(const name of names) expect(slots.entries(name)).toHaveLength(1)
  await fiber.dispose()
  for(const name of names) expect(slots.entries(name)).toHaveLength(0)
})

it('replaces the account launcher with a direct settings entry in competition mode', async () => {
  vi.stubEnv('DSH_CLIENT_COMPETITION', 'true')
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name:'root', children:{
    'sidebar.brand.mark':{ kind:'single',scope:'root' },
    'sidebar.brand.name':{ kind:'single',scope:'root' },
    'conversation.hero.brand.mark':{ kind:'single',scope:'root' },
    'settings.launcher':{ kind:'single',scope:'root' },
  } } as never, () => null)
  const fiber = ctx.plugin({ inject:[...inject],apply })
  await fiber.await()
  expect(slots.entries('settings.launcher')).toHaveLength(1)
  await fiber.dispose()
  expect(slots.entries('settings.launcher')).toHaveLength(0)
})
