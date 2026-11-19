/** Read-only node view for a plan publication: layers, nodes and dependency edges. */
import { useMemo, useState } from 'react'
import css from './Panel.module.css'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locale.ts'

/** One published plan node as the preview reads it. */
interface PlanNode {
  readonly id: string
  readonly kind?: string
  readonly dependsOn?: readonly string[]
}

/**
 * Parse a plan publication and lay its nodes out by dependency layer.
 * @param input - Raw JSON typed or pasted by the operator.
 * @returns Layers of node ids, or the parse failure to show instead of a graph.
 */
function layout(input: string): { layers: readonly (readonly PlanNode[])[] } | { error: string } {
  if (input.trim() === '') return { layers: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return { error: 'JSON' }
  }
  const nodes = (parsed as { nodes?: unknown } | null)?.nodes
  if (!Array.isArray(nodes)) return { error: 'nodes' }
  const byId = new Map<string, PlanNode>()
  for (const raw of nodes) {
    const candidate = raw as { id?: unknown; kind?: unknown; dependsOn?: unknown }
    if (typeof candidate.id !== 'string' || candidate.id === '') return { error: 'id' }
    byId.set(candidate.id, {
      id: candidate.id,
      ...typeof candidate.kind === 'string' ? { kind: candidate.kind } : {},
      ...Array.isArray(candidate.dependsOn)
        ? { dependsOn: candidate.dependsOn.filter((value): value is string => typeof value === 'string') }
        : {},
    })
  }
  const layers: PlanNode[][] = []
  const placed = new Set<string>()
  let pending = [...byId.values()]
  while (pending.length > 0) {
    const layer = pending.filter(node => (node.dependsOn ?? []).every(id => placed.has(id)))
    // A cycle leaves no node placeable; show what is left as one final layer.
    const settled = layer.length === 0 ? pending : layer
    for (const node of settled) placed.add(node.id)
    layers.push(settled)
    pending = pending.filter(node => !placed.has(node.id))
    if (layers.length > 12) break
  }
  return { layers }
}

/**
 * Render the dependency graph of a plan publication without editing it.
 * @param props - Localized seat for captions.
 * @returns node columns by layer with each node's dependency list.
 */
export function PlanPreview({ t }: PropsLocale<typeof NS>) {
  const [input, setInput] = useState('')
  const result = useMemo(() => layout(input), [input])
  const failure = 'error' in result ? result.error : undefined
  return (
    <div className={css.preview}>
      <label htmlFor="lyagent-plan-preview">{t('planPreview')}</label>
      <textarea
        id="lyagent-plan-preview"
        className={css.previewInput}
        placeholder={t('planPlaceholder')}
        value={input}
        spellCheck={false}
        onChange={(event) => { setInput(event.target.value) }}
      />
      {failure === undefined ? null : (
        <p className={css.previewError} role="alert">{t('planInvalid')}: {failure}</p>
      )}
      {'layers' in result && result.layers.length > 0 && (
        <div className={css.layers} data-plan-preview>
          {result.layers.map((layer, index) => (
            <div key={`layer-${index}`} className={css.layer}>
              <span className={css.layerIndex}>{index + 1}</span>
              {layer.map(node => (
                <span key={node.id} className={css.node} data-kind={node.kind ?? 'agent'}>
                  <span className={css.nodeId}>{node.id}</span>
                  {node.kind === undefined ? null : <span className={css.nodeKind}>{node.kind}</span>}
                  {(node.dependsOn ?? []).length === 0 ? null : (
                    <span className={css.nodeDeps}>← {(node.dependsOn ?? []).join(', ')}</span>
                  )}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
