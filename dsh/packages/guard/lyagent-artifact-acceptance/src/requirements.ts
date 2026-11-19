/** Human-added artifact requirements can strengthen, never replace, deployment checks. */
import { z } from 'zod'

/** Bounded relative paths and literal content; no executable evaluator input. */
export const requirementsSchema = z.array(z.object({
  path: z.string().min(1).max(240).refine(path => !path.includes('\\') && !path.includes(':')
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')),
  minBytes: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  includes: z.array(z.string().min(1).max(4000)).max(20),
}).strict().refine(rule => rule.maxBytes >= rule.minBytes)).max(20)
  .refine(rules => new Set(rules.map(rule => rule.path)).size === rules.length)
/** Immutable registration input, without Python commands or hidden test selection. */
export type TaskRequirements = z.infer<typeof requirementsSchema>
