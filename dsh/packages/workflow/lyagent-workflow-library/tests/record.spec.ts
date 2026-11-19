/** Run records live beside the workspace and never overwrite earlier evidence. */
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { writeRunRecord } from '../src/record.ts'

const created: string[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'lyagent-record-'))
  created.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true })
})

const record = { id: 'audit', version: 3, sha256: 'abc123', content: { ok: true, notes: ['一', '二'] } }

it('writes one run under workflows/ with the identity, stamp and nonce in its name', async () => {
  const cwd = await workspace()
  const path = await writeRunRecord(cwd, record, { at: new Date('2026-11-15T17:50:00.123Z'), nonce: 'deadbeef' })
  expect(path).toBe(join(cwd, 'workflows', 'audit-v3-2026-11-15T17-50-00-123Z-deadbeef.json'))
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(record)
})

it('keeps every run of one saved version instead of overwriting the previous one', async () => {
  const cwd = await workspace()
  const first = await writeRunRecord(cwd, record, { at: new Date('2026-11-15T17:50:00.000Z'), nonce: 'aaaa1111' })
  const second = await writeRunRecord(cwd, { ...record, content: { ok: false } }, { at: new Date('2026-11-15T17:51:00.000Z'), nonce: 'bbbb2222' })
  expect(first).not.toBe(second)
  expect((await readdir(join(cwd, 'workflows'))).sort()).toEqual([
    'audit-v3-2026-11-15T17-50-00-000Z-aaaa1111.json',
    'audit-v3-2026-11-15T17-51-00-000Z-bbbb2222.json',
  ])
  expect(JSON.parse(await readFile(first, 'utf8'))).toEqual(record)
  expect(JSON.parse(await readFile(second, 'utf8'))).toEqual({ ...record, content: { ok: false } })
})

it('refuses to reuse an existing run path', async () => {
  const cwd = await workspace()
  const stamp = { at: new Date('2026-11-15T17:50:00.000Z'), nonce: 'cccc3333' }
  await writeRunRecord(cwd, record, stamp)
  await expect(writeRunRecord(cwd, record, stamp)).rejects.toThrow()
})

it('refuses a workflows directory that is redirected outside the workspace', async () => {
  const cwd = await workspace()
  const outside = await workspace()
  const link = join(cwd, 'workflows')
  const { symlink } = await import('node:fs/promises')
  try {
    await symlink(outside, link, 'junction')
  } catch (error) {
    // Directory junction creation needs no elevation on Windows; other hosts may refuse.
    expect(String(error)).toMatch(/EPERM|EEXIST|ENOTSUP|operation not permitted/i)
    return
  }
  await expect(writeRunRecord(cwd, record, { at: new Date('2026-11-15T17:50:00.000Z'), nonce: 'dddd4444' }))
    .rejects.toThrow('resolves outside the workspace')
  expect(await readdir(outside)).toEqual([])
})

it('reports a workspace that cannot host a record directory', async () => {
  const cwd = await workspace()
  await expect(writeRunRecord(join(cwd, 'missing', 'nested'), record,
    { at: new Date('2026-11-15T17:50:00.000Z'), nonce: 'eeee5555' })).rejects.toThrow()
})
