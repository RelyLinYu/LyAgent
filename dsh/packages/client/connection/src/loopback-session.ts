/** Optional loopback-only authentication bypass shared by HTTP and WebSocket admission. */
import { isTrustedApiRequest } from './api-request-trust.ts'
import { isLoopbackHostname } from './loopback-hostname.ts'
import type { ConnectionTrustRequest } from './rpc.ts'

function header(headers: ConnectionTrustRequest['headers'], name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority: string, protocol: 'http:' | 'https:'): URL | undefined {
  try {
    return new URL(`${protocol}//${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Whether a trusted request is loopback-to-loopback.
 * @param request - Node HTTP or Fetch request facts.
 * @param bindHost - configured listener bind address.
 * @param protocol - listener protocol for Host normalization.
 * @returns true only when the listener and request authority are both loopback.
 */
export function isTrustedLoopbackRequest(
  request: ConnectionTrustRequest,
  bindHost?: string,
  protocol: 'http:' | 'https:' = 'http:',
): boolean {
  if (bindHost === undefined || !isTrustedApiRequest(request, [], bindHost, protocol)) return false
  const zoneAt = bindHost.indexOf('%')
  const address = zoneAt === -1 ? bindHost : bindHost.slice(0, zoneAt)
  const bindUrl = parseAuthority(address.includes(':') ? `[${address}]` : address, protocol)
  if (bindUrl === undefined || !isLoopbackHostname(bindUrl.hostname)) return false
  const host = header(request.headers, 'host')
  const hostUrl = host === undefined ? undefined : parseAuthority(host, protocol)
  return hostUrl !== undefined && isLoopbackHostname(hostUrl.hostname)
}
