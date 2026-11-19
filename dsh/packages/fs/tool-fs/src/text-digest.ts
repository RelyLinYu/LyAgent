/** Streaming UTF-8 text hashing independent of provider chunk boundaries. */
import { createHash } from 'node:crypto'

/** Hash complete decoded text without retaining its contents.
 * @param chunks - ordered text chunks; UTF-16 surrogate pairs may cross chunks.
 * @param signal - caller-owned cancellation.
 * @returns lowercase SHA-256 matching the concatenated text's UTF-8 encoding.
 */
export async function textDigest(chunks: AsyncIterable<string>, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  let pending = ''
  for await (const chunk of chunks) {
    signal.throwIfAborted()
    const text = pending + chunk
    const last = text.charCodeAt(text.length - 1)
    const split = last >= 0xD800 && last <= 0xDBFF
    pending = split ? text.slice(-1) : ''
    hash.update(split ? text.slice(0, -1) : text, 'utf8')
  }
  signal.throwIfAborted()
  hash.update(pending, 'utf8')
  return hash.digest('hex')
}
