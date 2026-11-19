/** A blank Session adopts the first routable catalog model when the composition default has no route. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'
import { ModelDirectory } from '../src/client/directory.ts'

const catalog = (input: {
  readonly default: { readonly provider: string; readonly model: string }
  readonly groups: readonly { readonly id: string; readonly models: readonly string[] }[]
}): ModelCatalog => ({
  default: input.default,
  routableProviders: input.groups.map(group => group.id),
  groups: input.groups.map(group => ({
    id: group.id,
    name: group.id,
    models: group.models.map(model => ({ id: model, name: model })),
  })),
  failures: [],
})

function projected(initial: unknown): {
  getSnapshot: () => unknown
  subscribe: (listener: () => void) => () => void
  set: (next: unknown) => void
} {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next) => { value = next; for (const listener of listeners) listener() },
  }
}

function directory(input: {
  readonly models: () => Promise<unknown>
  readonly selection?: unknown
  readonly blank?: boolean
  readonly available?: boolean
  readonly catalog?: ModelCatalogDirectory
}): {
  readonly subject: ModelDirectory
  readonly selectModel: ReturnType<typeof vi.fn>
  readonly projected: ReturnType<typeof projected>
  readonly catalog: ModelCatalogDirectory
} {
  const selectModel = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const selection = projected(input.selection ?? { lastUsed: null, next: null })
  const catalog = input.catalog ?? new ModelCatalogDirectory({ remote: { session: { modelCatalog: input.models } } } as never)
  const subject = new ModelDirectory(
    { selectModel },
    'session-1' as SessionId,
    () => input.available ?? true,
    catalog,
    selection,
    () => input.blank ?? true,
  )
  return { subject, selectModel, projected: selection, catalog }
}

describe('ModelDirectory automatic default', () => {
  it('selects the first catalog model when the default provider is not available', async () => {
    const { subject, selectModel } = directory({
      models: async () => ({ ok: true, value: catalog({
        default: { provider: 'deepseek-official', model: 'deepseek-flash' },
        groups: [{ id: 'anthropic', models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] }],
      }) }),
    })

    await subject.load()

    expect(selectModel).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', provider: 'anthropic', model: 'claude-sonnet-4-5' })
  })

  it('leaves a routable composition default alone', async () => {
    const { subject, selectModel } = directory({
      models: async () => ({ ok: true, value: catalog({
        default: { provider: 'deepseek-official', model: 'deepseek-flash' },
        groups: [{ id: 'deepseek-official', models: ['deepseek-flash'] }],
      }) }),
    })

    await subject.load()

    expect(selectModel).not.toHaveBeenCalled()
  })

  it('never overrides a saved selection', async () => {
    const { subject, selectModel } = directory({
      selection: { lastUsed: null, next: { provider: 'anthropic', model: 'claude-opus-4-5' } },
      models: async () => ({ ok: true, value: catalog({
        default: { provider: 'deepseek-official', model: 'deepseek-flash' },
        groups: [{ id: 'anthropic', models: ['claude-sonnet-4-5'] }],
      }) }),
    })

    await subject.load()

    expect(selectModel).not.toHaveBeenCalled()
  })

  it('does not touch a conversation that already sent a message', async () => {
    const { subject, selectModel } = directory({
      blank: false,
      models: async () => ({ ok: true, value: catalog({
        default: { provider: 'deepseek-official', model: 'deepseek-flash' },
        groups: [{ id: 'anthropic', models: ['claude-sonnet-4-5'] }],
      }) }),
    })

    await subject.load()

    expect(selectModel).not.toHaveBeenCalled()
  })

  it('adopts a provider configured after the empty catalog was loaded', async () => {
    const empty = catalog({ default: { provider: 'deepseek-official', model: 'deepseek-flash' }, groups: [] })
    const configured = catalog({
      default: { provider: 'deepseek-official', model: 'deepseek-flash' },
      groups: [{ id: 'anthropic', models: ['claude-sonnet-4-5'] }],
    })
    const models = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: empty })
      .mockResolvedValueOnce({ ok: true, value: configured })
    const catalogDirectory = new ModelCatalogDirectory({ remote: { session: { modelCatalog: models } } } as never)
    const { subject, selectModel } = directory({ models, catalog: catalogDirectory })

    await subject.load()
    expect(selectModel).not.toHaveBeenCalled()

    // A saved provider reaches the directory as a Host catalog refresh, not a new Session.
    catalogDirectory.refresh()
    await vi.waitFor(() => {
      expect(selectModel).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', provider: 'anthropic', model: 'claude-sonnet-4-5' })
    })
  })

  it('skips automatic selection for an addressed subagent session', async () => {
    const { subject, selectModel } = directory({
      available: false,
      models: async () => ({ ok: true, value: catalog({
        default: { provider: 'deepseek-official', model: 'deepseek-flash' },
        groups: [{ id: 'anthropic', models: ['claude-sonnet-4-5'] }],
      }) }),
    })

    await subject.ensureRoutableDefault()

    expect(selectModel).not.toHaveBeenCalled()
  })
})
