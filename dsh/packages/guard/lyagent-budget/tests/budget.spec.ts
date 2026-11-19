/** Real JSON durability and native LLM waterfall acceptance, without a network provider. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import * as Policy from '../src/index.ts'
import { BatchLedger, batchSchema } from '../src/ledger.ts'

class Adapter extends LlmAdapter {
  calls = 0
  missingUsage = false
  fail = false
  tokens = 3
  usage: TokenUsage | undefined
  gate: Promise<undefined> | undefined
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    if (this.gate !== undefined) await this.gate
    request.signal?.throwIfAborted()
    if (this.fail) throw new Error('simulated provider interruption')
    if (!this.missingUsage) yield { type: 'usage', usage: this.usage ?? { inputTokens: this.tokens, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const roots: string[] = []

it('seals admission while retaining late authoritative overage', async () => {
  const { ctx } = await setup()
  const domain = await ctx.storageDomain.open(DomainStorage.defineDomain({
    name: 'sealed_overage_fixture', version: 1, tables: { batches: DomainStorage.domainTable(batchSchema) },
  }))
  try {
    const ledger = new BatchLedger(domain.table('batches'), 'sealed')
    await ledger.initialize(8, 80)
    const allocation = { run: 'root:1', member: 'child', maxRequests: 4, maxTokens: 40, memberMaxRequests: 2, memberMaxTokens: 10 }
    const id = await ledger.reserve(10, new Set(), 2, allocation)
    expect((await ledger.seal(allocation.run)).ready).toBe(false)
    await expect(ledger.reserve(1, new Set([id]), 2, allocation)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
    await ledger.settle(id, 12)
    expect(await ledger.seal(allocation.run)).toMatchObject({ ready: false, requests: 1, tokens: 12 })
    const healthy = { ...allocation, run: 'root:2' }
    const next = await ledger.reserve(10, new Set(), 2, healthy)
    await ledger.settle(next, 5)
    expect(await ledger.seal(healthy.run)).toMatchObject({ ready: true, requests: 1, tokens: 5 })
    expect((await ledger.seal('untracked:1')).ready).toBe(false)
    const uncertain = await ledger.reserve(10, new Set(), 2, { ...allocation, run: 'root:3' })
    await ledger.settle(uncertain, undefined)
    expect((await ledger.seal('root:3')).ready).toBe(false)
    expect((await ledger.seal(healthy.run)).ready).toBe(false)
  } finally { await domain.close() }
})

it.each([
  { inputTokens: -1, outputTokens: 2 },
  { inputTokens: 1.5, outputTokens: 2 },
  { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 2 },
  { inputTokens: 3, outputTokens: 2, totalTokens: 4 },
  { inputTokens: 3, outputTokens: 2, totalTokens: NaN },
])('keeps malformed provider usage unknown: %j', async (usage) => {
  const { ctx, adapter } = await setup()
  adapter.usage = usage
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  await expect(consume(ctx)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
  expect(adapter.calls).toBe(1)
})

it('does not dispatch or charge an already aborted request', async () => {
  const { ctx, adapter } = await setup(undefined, 1)
  for await (const _chunk of ctx.llm.stream({ ...options, signal: AbortSignal.abort() })) { /* drain cancellation */ }
  expect(adapter.calls).toBe(0)
  await consume(ctx)
  expect(adapter.calls).toBe(1)
})

it('retains an interrupted in-flight call as unknown after provider cancellation', async () => {
  const { ctx, adapter } = await setup()
  const release = Promise.withResolvers<undefined>()
  adapter.gate = release.promise
  const controller = new AbortController()
  const operation = (async () => {
    for await (const _chunk of ctx.llm.stream({ ...options, signal: controller.signal })) { /* drain cancellation */ }
  })()
  try {
    await expect.poll(() => adapter.calls).toBe(1)
    controller.abort()
  } finally { release.resolve(undefined) }
  await operation
  await expect(consume(ctx)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
  expect(adapter.calls).toBe(1)
})

it('rejects ambiguous or inexact durable accounting records', () => {
  const request = { id: 'same', state: 'pending', tokens: 2 }
  expect(batchSchema.safeParse({ maxRequests: 4, maxTokens: 40, requests: [request, request] }).success).toBe(false)
  expect(batchSchema.safeParse({ maxRequests: 4, maxTokens: 40, requests: [
    { ...request, tokens: Number.MAX_SAFE_INTEGER }, { ...request, id: 'other' },
  ] }).success).toBe(false)
})

it('charges parent and child allocation limits in the same reservation', async () => {
  const { ctx } = await setup()
  const domain = await ctx.storageDomain.open(DomainStorage.defineDomain({
    name: 'allocation_fixture', version: 1, tables: { batches: DomainStorage.domainTable(batchSchema) },
  }))
  try {
    const ledger = new BatchLedger(domain.table('batches'), 'allocation')
    await ledger.initialize(8, 80)
    const allocation = { run: 'run-1', member: 'child-1', maxRequests: 1, maxTokens: 10, memberMaxRequests: 1, memberMaxTokens: 10 }
    const id = await ledger.reserve(10, new Set(), 2, allocation)
    await ledger.settle(id, 10)
    await expect(ledger.reserve(1, new Set(), 2, allocation)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
    const other = { ...allocation, member: 'child-2' }
    await expect(ledger.reserve(1, new Set(), 2, other)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
  } finally { await domain.close() }
})

it('retains child overage without consuming a sibling allocation or changing its limits', async () => {
  const { ctx } = await setup()
  const domain = await ctx.storageDomain.open(DomainStorage.defineDomain({
    name: 'member_limits_fixture', version: 1, tables: { batches: DomainStorage.domainTable(batchSchema) },
  }))
  try {
    const ledger = new BatchLedger(domain.table('batches'), 'member-limits')
    await ledger.initialize(10, 100)
    const allocation = { run: 'run', member: 'child-a', maxRequests: 5, maxTokens: 80, memberMaxRequests: 2, memberMaxTokens: 10 }
    const id = await ledger.reserve(10, new Set(), 2, allocation)
    await ledger.settle(id, 12)
    await expect(ledger.reserve(1, new Set(), 2, allocation)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
    await expect(ledger.reserve(1, new Set(), 2, { ...allocation, memberMaxTokens: 20 })).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
    const sibling = await ledger.reserve(10, new Set(), 2, { ...allocation, member: 'child-b' })
    await ledger.settle(sibling, 3)
    expect(domain.table('batches').get('member-limits')?.requests.map(request => request.tokens)).toEqual([12, 3])
  } finally { await domain.close() }
})

it('atomically caps concurrent child reservations and retains parent limits after storage reopen', async () => {
  const { ctx } = await setup()
  const spec = DomainStorage.defineDomain({
    name: 'allocation_restart_fixture', version: 1, tables: { batches: DomainStorage.domainTable(batchSchema) },
  })
  let domain = await ctx.storageDomain.open(spec)
  const allocation = { run: 'durable-run', member: 'child-a', maxRequests: 2, maxTokens: 20, memberMaxRequests: 1, memberMaxTokens: 10 }
  try {
    const ledger = new BatchLedger(domain.table('batches'), 'allocation')
    await ledger.initialize(8, 80)
    const active = new Set<string>()
    const outcomes = await Promise.allSettled([
      ledger.reserve(10, active, 3, allocation),
      ledger.reserve(10, active, 3, { ...allocation, member: 'child-b' }),
      ledger.reserve(10, active, 3, { ...allocation, member: 'child-c' }),
    ])
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1)
    for (const result of outcomes) if (result.status === 'fulfilled') await ledger.settle(result.value, 5)
    await domain.close()
    domain = await ctx.storageDomain.open(spec)
    const reopened = new BatchLedger(domain.table('batches'), 'allocation')
    await reopened.initialize(8, 80)
    await expect(reopened.reserve(1, new Set(), 3, { ...allocation, member: 'child-new' })).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
    await expect(reopened.reserve(1, new Set(), 3, { ...allocation, maxRequests: 3 })).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
    expect(domain.table('batches').get('allocation')?.requests).toHaveLength(2)
    const next = await reopened.reserve(10, new Set(), 3, { ...allocation, run: 'independent-run' })
    await reopened.settle(next, 5)
  } finally { await domain.close() }
})

it('rejects absent or duplicate settlements without rewriting authoritative usage', async () => {
  const { ctx } = await setup()
  const domain = await ctx.storageDomain.open(DomainStorage.defineDomain({
    name: 'settlement_fixture', version: 1, tables: { batches: DomainStorage.domainTable(batchSchema) },
  }))
  try {
    const ledger = new BatchLedger(domain.table('batches'), 'settlement')
    await ledger.initialize(4, 40)
    await expect(ledger.settle('absent', 2)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
    const id = await ledger.reserve(10, new Set(), 2)
    await ledger.settle(id, 5)
    await expect(ledger.settle(id, 1)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
    expect(domain.table('batches').get('settlement')?.requests).toEqual([{ id, state: 'settled', tokens: 5 }])
  } finally { await domain.close() }
})

it('blocks persisted pending reservations when the host owner restarts', async () => {
  const { ctx } = await setup()
  const domain = await ctx.storageDomain.open(DomainStorage.defineDomain({
    name: 'interrupted_fixture', version: 1, tables: { batches: DomainStorage.domainTable(batchSchema) },
  }))
  try {
    const first = new BatchLedger(domain.table('batches'), 'interrupted')
    await first.initialize(4, 40)
    await first.reserve(10, new Set(), 2)
    const restarted = new BatchLedger(domain.table('batches'), 'interrupted')
    await restarted.initialize(4, 40)
    await expect(restarted.reserve(10, new Set(), 2)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
  } finally { await domain.close() }
})
const contexts: Context[] = []

it('retains sealed root turns after closing and reopening storage', async () => {
  const { ctx } = await setup()
  const spec = DomainStorage.defineDomain({
    name: 'sealed_restart_fixture', version: 1, tables: { batches: DomainStorage.domainTable(batchSchema) },
  })
  let domain = await ctx.storageDomain.open(spec)
  const allocation = { run: 'root:1', member: 'root', maxRequests: 4, maxTokens: 40, memberMaxRequests: 4, memberMaxTokens: 40 }
  try {
    const ledger = new BatchLedger(domain.table('batches'), 'sealed')
    await ledger.initialize(8, 80)
    const id = await ledger.reserve(10, new Set(), 2, allocation)
    await ledger.settle(id, 5)
    expect((await ledger.seal(allocation.run)).ready).toBe(true)
    await domain.close()
    domain = await ctx.storageDomain.open(spec)
    const reopened = new BatchLedger(domain.table('batches'), 'sealed')
    await reopened.initialize(8, 80)
    expect((await reopened.seal(allocation.run)).ready).toBe(true)
    await expect(reopened.reserve(1, new Set(), 2, allocation)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
  } finally { await domain.close() }
})
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function setup(root?: string, maxRequests = 2, maxTokens = 20, maxConcurrent = 1) {
  root ??= await mkdtemp(join(tmpdir(), 'lyagent-budget-test-'))
  if (!roots.includes(root)) roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root })
  await ctx.plugin(DomainStorage, { backend: 'json' })
  await ctx.plugin(LlmRuntime)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['test-budget'], adapter)
  const fiber = await ctx.plugin(Policy, { batchId: 'authorized-fixture', maxRequests, maxTokens, reservationTokens: 10, maxConcurrent })
  return { ctx, adapter, root, fiber }
}
const options: GenerateOptions = { provider: 'test-budget', model: 'fixture', messages: [] }
async function consume(ctx: Context) { for await (const _chunk of ctx.llm.stream(options)) { /* drain the complete stream */ } }

it('persists request limits across a real storage reopen and never dispatches the denied request', async () => {
  const first = await setup()
  await consume(first.ctx)
  await consume(first.ctx)
  await expect(consume(first.ctx)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
  expect(first.adapter.calls).toBe(2)
  await first.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(first.ctx), 1)
  const second = await setup(first.root)
  await expect(consume(second.ctx)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
  expect(second.adapter.calls).toBe(0)
})

it('keeps missing usage unknown and blocks another provider call', async () => {
  const { ctx, adapter } = await setup()
  adapter.missingUsage = true
  await consume(ctx)
  await expect(consume(ctx)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
  expect(adapter.calls).toBe(1)
})

it('atomically admits at most the configured concurrent requests', async () => {
  const { ctx, adapter } = await setup(undefined, 4, 40, 2)
  const release = Promise.withResolvers<undefined>()
  adapter.gate = release.promise
  const requests = Array.from({ length: 4 }, () => consume(ctx))
  const outcomes = Promise.allSettled(requests)
  try {
    await expect.poll(() => adapter.calls).toBe(2)
  } finally { release.resolve(undefined) }
  const results = await outcomes
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(2)
  expect(adapter.calls).toBe(2)
})

it('removes the middleware when its owning fiber is disposed', async () => {
  const { ctx, fiber, adapter } = await setup(undefined, 1)
  await consume(ctx)
  await expect(consume(ctx)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
  await fiber.dispose()
  expect(ctx.get('lyagentBudget')).toBeUndefined()
  await consume(ctx)
  expect(adapter.calls).toBe(2)
})

it('retains full reported overage instead of clipping it to the reservation', async () => {
  const { ctx, adapter } = await setup(undefined, 4)
  adapter.tokens = 25
  await consume(ctx)
  await expect(consume(ctx)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
  expect(adapter.calls).toBe(1)
})

it('blocks after a provider failure without retrying or releasing the unknown reservation', async () => {
  const { ctx, adapter } = await setup()
  adapter.fail = true
  await consume(ctx)
  await expect(consume(ctx)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
  expect(adapter.calls).toBe(1)
})

it('rejects a changed authorization when opening the same durable batch', async () => {
  const first = await setup()
  await first.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(first.ctx), 1)
  await expect(setup(first.root, 3)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
})

it('does not release a reservation when a consumer stops before the terminal chunk', async () => {
  const { ctx, adapter } = await setup()
  for await (const _chunk of ctx.llm.stream(options)) break
  await expect(consume(ctx)).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
  expect(adapter.calls).toBe(1)
})

it('waits for an already dispatched stream to settle before closing durable storage', async () => {
  const { ctx, adapter, fiber } = await setup()
  const release = Promise.withResolvers<undefined>()
  adapter.gate = release.promise
  const operation = consume(ctx)
  await expect.poll(() => adapter.calls).toBe(1)
  const disposal = fiber.dispose()
  release.resolve(undefined)
  await operation
  await disposal
})

it('reports missing usage as a failed terminal outcome rather than successful completion', async () => {
  const { ctx, adapter } = await setup()
  adapter.missingUsage = true
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'LYAGENT_USAGE_UNKNOWN' } } })
})
