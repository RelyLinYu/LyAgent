import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { textDigest } from '../src/text-digest.ts'

it('hashes decoded text independently of chunk and surrogate-pair boundaries', async () => {
  const text = 'alpha\r\n\uD83D\uDE80\uD800end'
  for (let split = 0; split <= text.length; split++) {
    const chunks = (async function* () { yield text.slice(0, split); yield ''; yield text.slice(split) })()
    expect(await textDigest(chunks, new AbortController().signal)).toBe(createHash('sha256').update(text).digest('hex'))
  }
})

it('propagates cancellation without returning a partial digest', async () => {
  const controller = new AbortController()
  const chunks = (async function* () { yield 'before'; controller.abort(); yield 'after' })()
  await expect(textDigest(chunks, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
