/** Deterministic pre-dispatch selection among explicitly authorized repair routes. */
import { RunError } from './run.ts'

/** Host-audited route and tools; capability labels are declarations, not inferred guarantees. */
export interface RepairWorker {
  /** Registered native model provider identity. */
  provider: string
  /** Model identity resolved by the selected provider. */
  model: string
  /** Explicit read-only tool allowlist for the repair child. */
  readOnlyTools: string[]
}

/** Explicit candidate policy; disabled candidates never reach provider dispatch. */
export interface RepairCandidate extends RepairWorker {
  /** Stable host-assigned route identity used in capacity accounting. */
  id: string
  /** Whether this candidate may be selected. */
  enabled: boolean
  /** Host-declared labels required by repair targets. */
  capabilities: string[]
  /** Omission leaves candidate capacity unrestricted; explicit values bound live repair activations. */
  maxActive?: number | undefined
}

type DecisionReason = 'disabled' | 'capability-mismatch' | 'provider-unavailable' | 'capacity-full' | 'selected' | 'lower-preference'

/** Resolve one eligible candidate in configured order without probing or dispatching a provider.
 * @param candidates - ordered, host-authorized repair candidates.
 * @param required - required declared capability labels.
 * @param providers - currently registered provider identities.
 * @param active - live reservations by candidate identity; omission treats all loads as zero.
 * @returns selected candidate and an auditable decision for every candidate.
 */
export function selectRepairWorker(candidates: readonly RepairCandidate[], required: readonly string[], providers: ReadonlySet<string>,
  active: ReadonlyMap<string, number> = new Map()): {
  worker: RepairCandidate
  decisions: { id: string; reason: DecisionReason }[]
} {
  let worker: RepairCandidate | undefined
  const decisions = candidates.map((candidate) => {
    const reason: DecisionReason = !candidate.enabled ? 'disabled'
      : required.some(capability => !candidate.capabilities.includes(capability)) ? 'capability-mismatch'
        : !providers.has(candidate.provider) ? 'provider-unavailable'
          : candidate.maxActive !== undefined && (active.get(candidate.id) ?? 0) >= candidate.maxActive ? 'capacity-full'
            : worker === undefined ? 'selected' : 'lower-preference'
    if (reason === 'selected') worker = candidate
    return { id: candidate.id, reason }
  })
  if (worker === undefined) throw new RunError(`No eligible authorized repair worker: ${JSON.stringify(decisions)}`)
  return { worker, decisions }
}
