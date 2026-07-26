import { useEffect, useMemo } from 'react'
import { Panel, Stat, Field, Empty, DecisionSupportNote } from '@/ui/primitives'
import { useYukti } from '@/store/useYukti'
import { useEvidence } from '@/ui/EvidenceDrawer'
import { getCommunities, getNetwork } from '@/data/network'
import { commonNeighbours, shortestPath, suggestedOrigins } from '@/data/graphpaths'
import { getFocusView, edgeLabel } from '@/data/focus'
import { KIND_COLOR, PALETTE } from '@/lib/palette'
import { pct } from '@/lib/format'
import type { Evidence, GraphNode } from '@/data/types'

/**
 * MOD-02 — Criminological Network & Link Analysis (§7.2).
 *
 * §7.2 asks for a viewer analysts expand from a starting entity, and names
 * shortest-path and common-neighbour analysis as the means of surfacing indirect
 * links. This module is those three things: an origin to start from, a dial to
 * expand, and a path finder that answers "how are these two connected?".
 */

export function M2Network({ ready }: { ready: boolean }) {
  const selectedNode = useYukti((s) => s.selectedNode)
  const selectNode = useYukti((s) => s.selectNode)
  const origin = useYukti((s) => s.egoOrigin)
  const setOrigin = useYukti((s) => s.setEgoOrigin)
  const trail = useYukti((s) => s.trail)
  const trailBack = useYukti((s) => s.trailBack)
  const walkTo = useYukti((s) => s.walkTo)
  const pathTarget = useYukti((s) => s.pathTarget)
  const setPathTarget = useYukti((s) => s.setPathTarget)
  const playback = useYukti((s) => s.playback)
  const startPlayback = useYukti((s) => s.startPlayback)
  const stepPlayback = useYukti((s) => s.stepPlayback)
  const stopPlayback = useYukti((s) => s.stopPlayback)
  const openEvidence = useEvidence()

  const graph = useMemo(() => getNetwork(), [])
  const communities = useMemo(() => getCommunities(), [])
  const origins = useMemo(() => suggestedOrigins(8), [])

  // Open on the best-connected person rather than on an empty canvas.
  // ?path=<n> additionally traces to the n-th ranked origin, so the connection
  // finder can be linked to directly for a walkthrough.
  useEffect(() => {
    if (origin || !origins.length) return
    setOrigin(origins[0].id)
    const n = Number(new URLSearchParams(window.location.search).get('path'))
    if (Number.isInteger(n) && origins[n]) {
      const target = origins[n].id
      queueMicrotask(() => setPathTarget(target))
    }
  }, [origin, origins, setOrigin, setPathTarget])

  const view = useMemo(() => (origin ? getFocusView(origin) : null), [origin])

  /**
   * Playback advances one hop at a time. Each step is a full orbital transition
   * in the view, so the interval has to clear it — stepping faster than the
   * animation just produces a blur nobody can follow.
   */
  useEffect(() => {
    if (!playback) return
    const id = setTimeout(stepPlayback, 1900)
    return () => clearTimeout(id)
  }, [playback, stepPlayback])
  const path = useMemo(
    () => (origin && pathTarget ? shortestPath(origin, pathTarget) : null),
    [origin, pathTarget],
  )
  const shared = useMemo(
    () => (origin && pathTarget ? commonNeighbours(origin, pathTarget) : []),
    [origin, pathTarget],
  )

  const inspected = selectedNode ? graph.nodes.find((n) => n.id === selectedNode) : null
  const rootNode = origin ? graph.nodes.find((n) => n.id === origin) : null
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes])

  if (!ready || !view || !rootNode) {
    return (
      <div className="p-6">
        <Empty>Loading the entity graph.</Empty>
      </div>
    )
  }

  const reach = new Set(view.satellites.map((s) => s.node.district))

  return (
    <div className="grid h-full grid-cols-1 gap-3 p-3 lg:grid-cols-[272px_1fr_312px]">
      {/* Left — where to start, and what to connect */}
      <div className="pointer-events-auto hidden min-h-0 flex-col gap-3 lg:flex">
        <Panel title="Start from" reference="Origin" ticked>
          <div className="border-b border-rule px-3 py-2">
            <p className="text-[0.74rem] leading-relaxed text-khaki-dim">
              One entity at a time, with everything one step away around it. Double-click a
              satellite to bring it into focus — the ring turns and carries it in.
            </p>
          </div>
          <ul className="divide-y divide-rule/50">
            {origins.map((o) => (
              <li key={o.id}>
                <button
                  onClick={() => setOrigin(o.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-brass/[0.06]"
                  style={{ background: origin === o.id ? 'rgba(201,162,39,0.1)' : undefined }}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-[0.8rem]"
                      style={{ color: origin === o.id ? PALETTE.brassLit : PALETTE.khaki }}
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
          action={
            pathTarget ? (
              <button
                className="label transition-colors hover:text-brass"
                onClick={() => setPathTarget(null)}
              >
                Clear
              </button>
            ) : null
          }
        >
          <div className="p-3">
            {path ? (
              <>
                <div className="mb-3 flex items-baseline gap-4">
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
                      <span className="min-w-0 flex-1 truncate text-[0.78rem] text-khaki">
                        {n.label}
                      </span>
                      {i < path.nodes.length - 1 && (
                        <span className="label shrink-0" style={{ fontSize: 9 }}>
                          {path.links[i] ? edgeLabel(path.links[i].kind) : ''}
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

                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => startPlayback(path.nodes.map((n) => n.id))}
                    className="label w-full border border-brass/50 bg-brass/[0.08] px-3 py-2 text-brass transition-colors hover:bg-brass/16"
                  >
                    ▶ Walk this connection
                  </button>
                  <button
                    onClick={() => openEvidence(pathEvidence(rootNode, path.nodes, shared))}
                    className="label w-full border border-rule px-3 py-2 transition-colors hover:border-brass hover:text-brass"
                  >
                    Show the records on this path
                  </button>
                </div>
              </>
            ) : (
              <p className="text-[0.78rem] leading-relaxed text-khaki-dim">
                Click a satellite, then <span className="text-khaki">Trace connection</span> to find
                the shortest chain from {rootNode.label} — and walk it one hop at a time.
              </p>
            )}
          </div>
        </Panel>

        <Panel title="Communities" reference="Louvain" scroll className="min-h-0 flex-1">
          <ul className="divide-y divide-rule/50">
            {communities.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => setOrigin(c.topNode.id)}
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

      {/* Centre column is the canvas. Only the trail sits over it. */}
      <div className="pointer-events-none relative flex min-h-0 items-end justify-center pb-2">
        <nav
          className="pointer-events-auto plate flex max-w-full items-center gap-1 overflow-x-auto px-2 py-1.5"
          aria-label="Route walked"
        >
          <span className="label shrink-0 pr-1">Trail</span>
          {trail.map((id, i) => {
            const n = byId.get(id)
            if (!n) return null
            const last = i === trail.length - 1
            return (
              <span key={`${id}-${i}`} className="flex shrink-0 items-center gap-1">
                {i > 0 && (
                  <span className="text-rule-2" aria-hidden>
                    ›
                  </span>
                )}
                <button
                  onClick={() => trailBack(i)}
                  aria-current={last ? 'true' : undefined}
                  className="whitespace-nowrap px-1 text-[0.78rem] transition-colors hover:text-brass"
                  style={{ color: last ? PALETTE.brassLit : PALETTE.khakiDim }}
                >
                  {n.label}
                </button>
              </span>
            )
          })}
          {playback && (
            <span className="ml-2 flex shrink-0 items-center gap-2 border-l border-rule pl-2">
              <span className="label-brass" style={{ fontSize: 9 }}>
                Playing {playback.index + 1}/{playback.chain.length}
              </span>
              <button className="label transition-colors hover:text-brass" onClick={stopPlayback}>
                Stop
              </button>
            </span>
          )}
        </nav>
      </div>

      {/* Right — the dial's summary, and whatever is inspected */}
      <div className="pointer-events-auto flex min-h-0 flex-col gap-3">
        <Panel title={rootNode.label} reference="In focus" ticked>
          <div className="grid grid-cols-2 gap-3 p-3">
            <Stat label="Direct links" value={String(view.satellites.length)} tone="brass" />
            <Stat label="Jurisdictions" value={String(reach.size)} tone="cool" />
            <Stat label="Between them" value={String(view.rim.length)} sub="Rim ties" />
            <Stat label="PageRank" value={pct(rootNode.centrality, 0)} />
          </div>
          {view.hidden > 0 && (
            <div className="border-t border-rule px-3 py-2">
              <p className="text-[0.72rem] leading-relaxed text-khaki-dim">
                {view.hidden} further links are not shown — the ring holds seventeen so every one
                stays labelled.
              </p>
            </div>
          )}
        </Panel>

        {inspected ? (
          <Panel
            title={inspected.label}
            reference={inspected.kind}
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
                <Stat label="PageRank" value={pct(inspected.centrality, 0)} tone="brass" />
                <Stat label="Direct links" value={String(inspected.degree)} />
              </div>

              <div className="mb-3">
                <Field name="Jurisdiction">{inspected.district}</Field>
                {Object.entries(inspected.meta ?? {}).map(([k, v]) => (
                  <Field key={k} name={k}>
                    {String(v)}
                  </Field>
                ))}
              </div>

              <div className="flex flex-col gap-2">
                <button
                  onClick={() => walkTo(inspected.id)}
                  disabled={inspected.id === origin}
                  className="label w-full border border-rule px-3 py-2 transition-colors hover:border-brass hover:text-brass disabled:opacity-40"
                >
                  Bring into focus
                </button>
                <button
                  onClick={() => setPathTarget(inspected.id)}
                  disabled={inspected.id === origin}
                  className="label w-full border border-brass/50 px-3 py-2 text-brass transition-colors hover:bg-brass/12 disabled:opacity-40"
                >
                  Trace connection
                </button>
              </div>

              <div className="mt-3">
                <DecisionSupportNote>
                  A path through the graph records that documents connect two people. It is not
                  evidence of a shared offence, and requires corroboration before any investigative
                  action.
                </DecisionSupportNote>
              </div>
            </div>
          </Panel>
        ) : (
          <Panel title="Reading the view" reference="Legend" className="min-h-0 flex-1">
            <div className="flex flex-col gap-2.5 p-3">
              <LegendRow
                swatch={
                  <span
                    className="inline-block rounded-full"
                    style={{ width: 10, height: 10, background: PALETTE.brassLit }}
                  />
                }
                label="Centre = the entity in focus"
                note="Everything around it is one step away"
              />
              <LegendRow
                swatch={
                  <span className="inline-block h-[2px] w-4" style={{ background: PALETTE.brass }} />
                }
                label="Spoke = a direct relationship"
                note="Shorter spoke means a stronger tie"
              />
              <LegendRow
                swatch={
                  <span className="inline-block h-[2px] w-4" style={{ background: PALETTE.bhuvan }} />
                }
                label="Outer arc = they know each other"
                note="Two of their contacts, also linked"
              />
              <p className="mt-1 border-t border-rule pt-2 text-[0.74rem] leading-relaxed text-khaki-dim">
                Click a satellite to inspect it. Double-click to bring it into focus — the ring turns
                and it moves to the centre. The trail below records the route.
              </p>
            </div>
          </Panel>
        )}
      </div>
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

function pathEvidence(root: GraphNode, chain: GraphNode[], shared: GraphNode[]) {
  const items: Evidence[] = [
    {
      kind: 'feature',
      ref: `${root.id}:path`,
      label: 'Path derivation',
      detail: `Unweighted breadth-first shortest path over the entity graph. Every hop is one documented relationship; this chain is ${chain.length - 1} hops long.`,
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
      ref: `${root.id}:common`,
      label: `Common associates (${shared.length})`,
      detail: shared.map((n) => `${n.label} — ${n.district}`).join('; '),
    })
  }

  return {
    title: `${chain[0]?.label} → ${chain[chain.length - 1]?.label}`,
    subtitle: `${chain.length - 1} hops · shortest path · §7.2 association detection`,
    items,
  }
}
