import { useEffect, useMemo } from 'react'
import { Panel, Stat, Field, Empty, Tag, DecisionSupportNote } from '@/ui/primitives'
import { useYukti } from '@/store/useYukti'
import { useEvidence } from '@/ui/EvidenceDrawer'
import { getCommunities, getNetwork } from '@/data/network'
import { commonNeighbours, edgeLabel, shortestPath, suggestedOrigins } from '@/data/graphpaths'
import { KIND_COLOR, PALETTE } from '@/lib/palette'
import { pct } from '@/lib/format'
import type { Evidence, GraphNode } from '@/data/types'

/**
 * MOD-02 — Criminological Network & Link Analysis (§7.2).
 *
 * The module holds exactly two ideas, and keeping them apart is what makes it
 * readable:
 *
 *   SELECTION — the one entity you last clicked. The camera flies to it and the
 *     right-hand panel is its record. There is only ever one.
 *   PATH — two explicitly chosen endpoints, From and To. Filling them is a
 *     deliberate act, so the finder never has to guess which entity you meant.
 *
 * An earlier version conflated the two: a panel headed with one name sat
 * directly above a panel headed with another, with nothing on screen saying how
 * they related, next to a trail that never changed because nothing updated it.
 */

export function M2Network({ ready }: { ready: boolean }) {
  const selectedNode = useYukti((s) => s.selectedNode)
  const selectNode = useYukti((s) => s.selectNode)
  const pathFrom = useYukti((s) => s.pathFrom)
  const pathTo = useYukti((s) => s.pathTo)
  const setPathFrom = useYukti((s) => s.setPathFrom)
  const setPathTo = useYukti((s) => s.setPathTo)
  const clearPath = useYukti((s) => s.clearPath)
  const showPredicted = useYukti((s) => s.showPredicted)
  const toggleLayer = useYukti((s) => s.toggleLayer)
  const openEvidence = useEvidence()

  const graph = useMemo(() => getNetwork(), [])
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes])
  const communities = useMemo(() => getCommunities(), [])
  const origins = useMemo(() => suggestedOrigins(8), [])

  // Deep links for walkthroughs: ?node= selects one, ?path= fills both endpoints.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    // Number(null) is 0, not NaN — reading these without checking for presence
    // first meant every plain page load silently selected origins[0] and set
    // both path endpoints to the same entity.
    const read = (key: string): number | null => {
      const raw = params.get(key)
      if (raw === null || raw.trim() === '') return null
      const n = Number(raw)
      return Number.isInteger(n) ? n : null
    }

    const node = read('node')
    if (node !== null && origins[node]) selectNode(origins[node].id)

    const path = read('path')
    if (path !== null && origins[path] && origins[0] && path !== 0) {
      setPathFrom(origins[0].id)
      setPathTo(origins[path].id)
    }
  }, [origins, selectNode, setPathFrom, setPathTo])

  const selected = selectedNode ? byId.get(selectedNode) : null
  const fromNode = pathFrom ? byId.get(pathFrom) : null
  const toNode = pathTo ? byId.get(pathTo) : null

  const path = useMemo(
    () => (pathFrom && pathTo ? shortestPath(pathFrom, pathTo) : null),
    [pathFrom, pathTo],
  )
  const shared = useMemo(
    () => (pathFrom && pathTo ? commonNeighbours(pathFrom, pathTo) : []),
    [pathFrom, pathTo],
  )

  /**
   * One row per connected entity, not per edge. Two people co-accused in three
   * FIRs share three edges; listing the same name three times reads as duplicate
   * records in a platform whose premise is entity resolution.
   */
  const neighbours = useMemo(() => {
    if (!selectedNode) return []
    const merged = new Map<string, { node: GraphNode; kinds: Set<string>; predicted: boolean }>()

    for (const e of graph.edges) {
      const other =
        e.source === selectedNode ? e.target : e.target === selectedNode ? e.source : null
      if (!other) continue
      const n = byId.get(other)
      if (!n) continue

      const row = merged.get(other) ?? { node: n, kinds: new Set<string>(), predicted: true }
      row.kinds.add(edgeLabel(e.kind))
      // Only wholly-predicted relationships count as predicted: one recorded
      // edge is enough to make the association a matter of record.
      row.predicted = row.predicted && !!e.predicted
      merged.set(other, row)
    }

    return [...merged.values()]
      .map((r) => ({
        node: r.node,
        kind: [...r.kinds].join(' · '),
        ties: r.kinds.size,
        predicted: r.predicted,
      }))
      .sort((a, b) => b.node.centrality - a.node.centrality)
  }, [selectedNode, graph.edges, byId])

  if (!ready) {
    return (
      <div className="p-6">
        <Empty>Loading the entity graph.</Empty>
      </div>
    )
  }

  const predictedCount = graph.edges.filter((e) => e.predicted).length

  return (
    <div className="grid h-full grid-cols-1 gap-3 p-3 lg:grid-cols-[280px_1fr_320px]">
      <div className="pointer-events-auto hidden min-h-0 flex-col gap-3 overflow-y-auto pr-1 lg:flex">
        <Panel title="Find an entity" reference="Most connected" ticked className="shrink-0">
          <div className="border-b border-rule px-3 py-2">
            <p className="text-[0.74rem] leading-relaxed text-khaki-dim">
              Click a name, or any node in the view — the camera flies to it and its record opens on
              the right. Drag to orbit, scroll to zoom.
            </p>
          </div>
          <ul className="divide-y divide-rule/50">
            {origins.map((o) => (
              <li key={o.id}>
                <button
                  onClick={() => selectNode(o.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-brass/[0.06]"
                  style={{ background: selectedNode === o.id ? 'rgba(201,162,39,0.1)' : undefined }}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-[0.8rem]"
                      style={{ color: selectedNode === o.id ? PALETTE.brassLit : PALETTE.khaki }}
                    >
                      {o.label}
                    </span>
                    <span className="label block" style={{ fontSize: 9 }}>
                      {o.district} · {o.degree} links
                    </span>
                  </span>
                  <span
                    className="h-1 shrink-0"
                    style={{ width: 4 + o.centrality * 30, background: PALETTE.brass }}
                    aria-hidden
                  />
                </button>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          title="Connection finder"
          reference="Shortest path"
          className="shrink-0"
          action={
            pathFrom || pathTo ? (
              <button className="label transition-colors hover:text-brass" onClick={clearPath}>
                Clear
              </button>
            ) : null
          }
        >
          <div className="p-3">
            {/* Both slots stay on screen whether filled or not, so it is never
                ambiguous what the finder is about to compute. */}
            <div className="mb-3 flex flex-col gap-1.5">
              <Endpoint slot="From" node={fromNode} onClear={() => setPathFrom(null)} />
              <Endpoint slot="To" node={toNode} onClear={() => setPathTo(null)} />
            </div>

            {path ? (
              <>
                <div className="mb-3 flex items-baseline gap-4 border-t border-rule pt-3">
                  <Stat label="Steps apart" value={String(path.hops)} tone="brass" />
                  <Stat
                    label="Relationship"
                    value={path.indirect ? 'Indirect' : 'Direct'}
                    size="sm"
                    tone={path.indirect ? 'cool' : 'default'}
                    sub={path.indirect ? 'Never co-accused' : 'Recorded together'}
                  />
                </div>

                <ol className="mb-3 flex flex-col gap-1.5">
                  {path.nodes.map((n, i) => (
                    <li key={n.id} className="flex items-center gap-2">
                      <span
                        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: KIND_COLOR[n.kind] }}
                        aria-hidden
                      />
                      <button
                        onClick={() => selectNode(n.id)}
                        className="min-w-0 flex-1 truncate text-left text-[0.78rem] text-khaki transition-colors hover:text-brass"
                      >
                        {n.label}
                      </button>
                      {i < path.nodes.length - 1 && path.links[i] && (
                        <span className="label shrink-0" style={{ fontSize: 9 }}>
                          {edgeLabel(path.links[i].kind)}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>

                {shared.length > 0 && (
                  <div className="mb-3 border-t border-rule pt-2">
                    <div className="label mb-1.5">Common associates · {shared.length}</div>
                    <p className="text-[0.76rem] leading-relaxed text-khaki-dim">
                      {shared
                        .slice(0, 3)
                        .map((n) => n.label)
                        .join(', ')}
                      {shared.length > 3 ? ` +${shared.length - 3}` : ''}
                    </p>
                  </div>
                )}

                <button
                  onClick={() => openEvidence(pathEvidence(path.nodes, shared, path.hops))}
                  className="label w-full border border-brass/50 px-3 py-2 text-brass transition-colors hover:bg-brass/12"
                >
                  Show the records on this path
                </button>
              </>
            ) : (
              <p className="border-t border-rule pt-3 text-[0.76rem] leading-relaxed text-khaki-dim">
                {pathFrom && pathTo
                  ? 'No route between these two in the recorded graph.'
                  : 'Select an entity, then use Set as From or Set as To on its record. The route lights in red across the graph.'}
              </p>
            )}
          </div>
        </Panel>

        <Panel title="Communities" reference="Louvain" className="shrink-0">
          <ul className="divide-y divide-rule/50">
            {communities.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => selectNode(c.topNode.id)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-brass/[0.06]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[0.8rem] text-khaki">{c.label}</span>
                    <span className="label block" style={{ fontSize: 9 }}>
                      {c.district}
                    </span>
                  </span>
                  <span className="tnum shrink-0 text-khaki-dim" style={{ fontSize: 11 }}>
                    {c.size}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {/* The canvas sits here. */}
      <div aria-hidden />

      <div className="pointer-events-auto flex min-h-0 flex-col gap-3">
        {selected ? (
          <Panel
            title={selected.label}
            reference={selected.kind}
            ticked
            scroll
            className="min-h-0 flex-1"
            action={
              <button
                className="label transition-colors hover:text-brass"
                onClick={() => selectNode(null)}
              >
                Clear
              </button>
            }
          >
            <div className="p-3">
              <div className="mb-3 grid grid-cols-2 gap-3">
                <Stat label="PageRank" value={pct(selected.centrality, 0)} tone="brass" />
                <Stat label="Direct links" value={String(selected.degree)} />
              </div>

              <div className="mb-3">
                <Field name="Jurisdiction">{selected.district}</Field>
                {Object.entries(selected.meta ?? {}).map(([k, v]) => (
                  <Field key={k} name={k}>
                    {String(v)}
                  </Field>
                ))}
              </div>

              <div className="mb-3 flex gap-2">
                <button
                  onClick={() => setPathFrom(selected.id)}
                  disabled={pathFrom === selected.id}
                  className="label flex-1 border border-rule px-2 py-2 transition-colors hover:border-brass hover:text-brass disabled:opacity-40"
                >
                  Set as From
                </button>
                <button
                  onClick={() => setPathTo(selected.id)}
                  disabled={pathTo === selected.id}
                  className="label flex-1 border border-brass/50 px-2 py-2 text-brass transition-colors hover:bg-brass/12 disabled:opacity-40"
                >
                  Set as To
                </button>
              </div>

              <div className="label mb-2">Connected to · {neighbours.length}</div>
              <ul className="mb-3 divide-y divide-rule/50 border-y border-rule/50">
                {neighbours.slice(0, 12).map(({ node, kind, predicted }) => (
                  <li key={node.id}>
                    <button
                      onClick={() => selectNode(node.id)}
                      className="flex w-full items-center gap-2 py-1.5 text-left transition-colors hover:text-brass"
                    >
                      <span
                        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: KIND_COLOR[node.kind] }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate text-[0.78rem]">{node.label}</span>
                      <span
                        className="label shrink-0"
                        style={{ fontSize: 9, color: predicted ? PALETTE.brass : undefined }}
                      >
                        {predicted ? 'predicted' : kind}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              <DecisionSupportNote>
                Centrality and community membership are analytical signals. They are not evidence of
                an offence, and require corroboration before any investigative action.
              </DecisionSupportNote>
            </div>
          </Panel>
        ) : (
          <Panel title="Reading the view" reference="Legend" ticked className="min-h-0 flex-1">
            <div className="flex flex-col gap-2.5 p-3">
              <LegendRow
                swatch={
                  <span
                    className="inline-block rounded-full"
                    style={{ width: 10, height: 10, background: PALETTE.brass }}
                  />
                }
                label="Node size = how connected"
                note="Link count and PageRank together"
              />
              <LegendRow
                swatch={
                  <span className="inline-flex gap-[3px]">
                    {[KIND_COLOR.Person, KIND_COLOR.Incident, KIND_COLOR.Location].map((c) => (
                      <span
                        key={c}
                        className="inline-block rounded-full"
                        style={{ width: 7, height: 7, background: c }}
                      />
                    ))}
                  </span>
                }
                label="Colour = entity kind"
                note="Person · Incident · Location · Vehicle · Organisation"
              />
              <LegendRow
                swatch={
                  <span className="inline-block h-[2px] w-4" style={{ background: PALETTE.bhuvan }} />
                }
                label="Line = a recorded relationship"
                note="Taken from the FIR record"
              />
              <LegendRow
                swatch={
                  <span className="inline-block h-[2px] w-4" style={{ background: PALETTE.brass }} />
                }
                label="Brass line = predicted, not recorded"
                note="GraphSAGE suggestion — a hypothesis to check"
              />
              <LegendRow
                swatch={
                  <span className="inline-block h-[2px] w-4" style={{ background: PALETTE.redzone }} />
                }
                label="Red chain = the traced path"
                note="Shortest route between From and To"
              />

              <div className="mt-1 border-t border-rule pt-2">
                <Tag active={showPredicted} onClick={() => toggleLayer('showPredicted')}>
                  Predicted links ({predictedCount})
                </Tag>
                <p className="mt-2 text-[0.72rem] leading-relaxed text-khaki-dim">
                  Off by default. A prediction drawn like a record would claim evidence the platform
                  does not have.
                </p>
              </div>

              <p className="mt-1 border-t border-rule pt-2 text-[0.74rem] leading-relaxed text-khaki-dim">
                Hover a node to spotlight it and its links. Click to open its record and fly there.
                The layout is a live simulation — it keeps settling rather than freezing.
              </p>
            </div>
          </Panel>
        )}
      </div>
    </div>
  )
}

/** One endpoint slot — always on screen, filled or not. */
function Endpoint({
  slot,
  node,
  onClear,
}: {
  slot: string
  node: GraphNode | null | undefined
  onClear: () => void
}) {
  return (
    <div className="flex items-center gap-2 border border-rule px-2 py-1.5">
      <span className="label w-8 shrink-0">{slot}</span>
      {node ? (
        <>
          <span className="min-w-0 flex-1 truncate text-[0.78rem] text-khaki">{node.label}</span>
          <button
            onClick={onClear}
            className="label shrink-0 transition-colors hover:text-brass"
            aria-label={`Clear ${slot}`}
          >
            ×
          </button>
        </>
      ) : (
        <span className="flex-1 text-[0.76rem] text-khaki-dim">Not set</span>
      )}
    </div>
  )
}

function LegendRow({
  swatch,
  label,
  note,
}: {
  swatch: React.ReactNode
  label: string
  note: string
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-1 shrink-0" aria-hidden>
        {swatch}
      </span>
      <span className="min-w-0">
        <span className="block text-[0.78rem] text-khaki">{label}</span>
        <span className="label block" style={{ fontSize: 9 }}>
          {note}
        </span>
      </span>
    </div>
  )
}

function pathEvidence(chain: GraphNode[], shared: GraphNode[], hops: number) {
  const items: Evidence[] = [
    {
      kind: 'feature',
      ref: 'path:derivation',
      label: 'Path derivation',
      detail: `Unweighted breadth-first shortest path over the entity graph. Every hop is one documented relationship; this chain is ${hops} hops long.`,
    },
    ...chain.map<Evidence>((n) => ({
      kind: n.kind === 'Incident' ? 'incident' : n.kind === 'Person' ? 'person' : 'feature',
      ref: n.id,
      label: n.label,
      detail: `${n.kind} in ${n.district}${
        n.meta
          ? ` — ${Object.entries(n.meta)
              .map(([k, v]) => `${k}: ${v}`)
              .join(' · ')}`
          : ''
      }`,
    })),
  ]

  if (shared.length) {
    items.push({
      kind: 'feature',
      ref: 'path:common',
      label: `Common associates (${shared.length})`,
      detail: shared.map((n) => `${n.label} — ${n.district}`).join('; '),
    })
  }

  return {
    title: `${chain[0]?.label} → ${chain[chain.length - 1]?.label}`,
    subtitle: `${hops} hops · shortest path · §7.2 association detection`,
    items,
  }
}
