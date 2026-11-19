/** Durable role/team publication keeps exact references and rejects invalid membership. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import { TeamLibrary, teamLibraryDomain } from '../src/team.ts'
import { compilePlan } from '../src/plan.ts'

it('pins team roles before later publications and retains definitions across storage reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-team-library-'))
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(JsonStorage, { root })
    await ctx.plugin(DomainStorage, { backend: 'json' })
    const domain = await ctx.storageDomain.open(teamLibraryDomain)
    const teams = new TeamLibrary(domain.table('definitions'), 8000, 5)
    const original = { kind: 'profile' as const, description: 'Reviewer', instructions: 'Original instructions',
      provider: 'first-provider', model: 'first-model', enabled: true }
    await teams.publish({ id: 'reviewer', expectedVersion: 0, definition: original })
    const team = { kind: 'team' as const, description: 'Pinned reviewers', members: [{ role: 'review', profile: { id: 'reviewer', version: 1 } }] }
    await teams.publish({ id: 'reviewers', expectedVersion: 0, definition: team })
    await expect(teams.publish({ id: 'invalid', expectedVersion: 0, definition: { ...team,
      members: [{ role: 'review', profile: { id: 'missing', version: 1 } }] } })).rejects.toThrow('unavailable')
    await expect(teams.publish({ id: 'invalid', expectedVersion: 0, definition: { ...team,
      members: [...team.members, ...team.members] } })).rejects.toThrow('unique')
    const plan = { id: 'pinned-team', expectedVersion: 0, description: 'Pinned team', nodes: [
      { id: 'review', kind: 'role' as const, dependsOn: [], team: { id: 'reviewers', version: 1 }, role: 'review', prompt: 'Review', retry: 1 },
    ] }
    const read = (id: string, version: number) => teams.read(id, version)
    const saved = compilePlan(plan, () => { throw new Error('No saved script expected') }, read)
    await teams.publish({ id: 'reviewer', expectedVersion: 1, definition: { ...original, provider: 'new-provider', enabled: false } })
    expect(compilePlan(plan, () => { throw new Error('No saved script expected') }, read)).toEqual(saved)
    expect(saved.script).toContain('first-provider')
    expect(saved.script).not.toContain('new-provider')
    await teams.publish({ id: 'reviewers', expectedVersion: 1, definition: { ...team,
      members: [{ role: 'review', profile: { id: 'reviewer', version: 2 } }] } })
    expect(() => compilePlan({ ...plan, nodes: [{ ...plan.nodes[0]!, team: { id: 'reviewers', version: 2 } }] },
      () => { throw new Error('No saved script expected') }, read)).toThrow('disabled')
    await expect(teams.publish({ id: 'reviewer', expectedVersion: 2, definition: team })).rejects.toThrow('cannot change')
    await teams.close()
    await domain.close()
    const reopened = await ctx.storageDomain.open(teamLibraryDomain)
    try {
      const restored = new TeamLibrary(reopened.table('definitions'), 8000, 5)
      expect(restored.read('reviewer', 1).definition).toEqual(original)
      expect(restored.read('reviewers', 1).definition).toEqual(team)
    } finally { await reopened.close() }
  } finally {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})
