import { useEffect, useRef, useState } from 'react'
import { askQuestion, logAudit, type AskAnswer } from '@/data/api'
import { Panel, Empty, Tag, DecisionSupportNote } from '@/ui/primitives'
import { useEvidence } from '@/ui/EvidenceDrawer'
import { PALETTE } from '@/lib/palette'

/**
 * The natural-language assistant.
 *
 * Every other module answers a question the product decided to ask. This one
 * answers the question the officer actually has — which means the usual
 * chatbot affordances are wrong here. Three things are deliberate:
 *
 * The generated query is shown, not hidden. An assistant over a crime database
 * that cannot be checked is a liability; §10.3 puts the officer in the loop,
 * and they cannot be in a loop they cannot see.
 *
 * The answer text is composed by the backend from the result set, not written
 * by the model. So it reads flatter than a chat product — that is the cost of
 * never sending a record to a third party, and it is the right trade.
 *
 * Refusals are answers. When a question asks for something protected, the
 * backend returns `answerable: false` with a reason. That renders as a reply,
 * not an error toast, because "you cannot ask that, and here is why" is
 * information the user needs.
 */

interface Turn {
  id: number
  question: string
  pending: boolean
  answer?: AskAnswer
  error?: string
}

const SUGGESTIONS = [
  'Which districts have the highest crime rate per 100,000?',
  'How many cases are still under investigation?',
  'Chargesheet rate by district',
  'Which stations registered the most vehicle theft?',
]

let nextId = 1

export function AskPanel({ source }: { source?: 'local' | 'catalyst' }) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [showQuery, setShowQuery] = useState<Record<number, boolean>>({})
  const openEvidence = useEvidence()
  const log = useRef<HTMLDivElement>(null)

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
  }, [turns])

  async function submit(question: string) {
    const trimmed = question.trim()
    if (!trimmed) return
    const id = nextId++
    setTurns((t) => [...t, { id, question: trimmed, pending: true }])
    setDraft('')
    try {
      const answer = await askQuestion(trimmed, source)
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, pending: false, answer } : x)))
    } catch (err) {
      setTurns((t) =>
        t.map((x) => (x.id === id ? { ...x, pending: false, error: (err as Error).message } : x)),
      )
    }
  }

  function openRows(turn: Turn) {
    const a = turn.answer
    if (!a) return
    void logAudit('evidence_open', a.evidence, `ask: ${turn.question}`)
    openEvidence({
      title: 'Records behind this answer',
      subtitle: turn.question,
      items: a.evidence.map((ref) => ({
        kind: 'incident' as const,
        ref,
        label: ref,
        detail: 'Returned by the assistant query',
      })),
    })
  }

  return (
    <Panel title="Ask" reference={source === 'catalyst' ? 'Catalyst' : 'Data Store'} ticked scroll>
      <div className="flex h-full min-h-0 flex-col">
        <div ref={log} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {turns.length === 0 && (
            <Empty>
              Ask about districts, stations, categories, case status or clearance. The assistant
              writes a query against the Data Store — it never reads FIR narrative text.
            </Empty>
          )}

          {turns.map((turn) => (
            <article key={turn.id} className="space-y-2">
              <p className="text-[0.86rem] leading-relaxed text-khaki">
                <span className="label-brass mr-2">Q</span>
                {turn.question}
              </p>

              {turn.pending && <p className="label text-khaki-dim">Composing query…</p>}

              {turn.error && (
                <p
                  className="border-l pl-3 text-[0.8rem] leading-relaxed text-khaki-dim"
                  style={{ borderColor: `${PALETTE.redzone}80` }}
                >
                  {turn.error}
                </p>
              )}

              {turn.answer && (
                <div className="space-y-2 border-l border-brass/40 pl-3">
                  <p className="text-[0.86rem] leading-relaxed text-khaki">{turn.answer.answer}</p>

                  {turn.answer.notes.map((note) => (
                    <p key={note} className="text-[0.74rem] leading-relaxed text-khaki-dim">
                      {note}
                    </p>
                  ))}

                  {turn.answer.answerable && (
                    <>
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <Tag
                          onClick={() => setShowQuery((s) => ({ ...s, [turn.id]: !s[turn.id] }))}
                          active={!!showQuery[turn.id]}
                        >
                          {showQuery[turn.id] ? 'Hide query' : 'Show query'}
                        </Tag>
                        {turn.answer.evidence.length > 0 && (
                          <Tag onClick={() => openRows(turn)}>
                            {turn.answer.evidence.length} record
                            {turn.answer.evidence.length === 1 ? '' : 's'}
                          </Tag>
                        )}
                        <span className="label text-khaki-dim">{turn.answer.elapsedMs} ms</span>
                      </div>

                      {showQuery[turn.id] && (
                        <pre className="tnum overflow-x-auto border border-rule bg-black/20 p-2 text-[0.72rem] leading-relaxed text-khaki-dim">
                          {turn.answer.query}
                        </pre>
                      )}

                      {turn.answer.rows.length > 0 && (
                        <div className="max-h-56 overflow-auto border border-rule">
                          <table className="tnum w-full text-[0.74rem]">
                            <thead className="sticky top-0 bg-black/40">
                              <tr>
                                {turn.answer.columns.map((c) => (
                                  <th key={c} className="label border-b border-rule px-2 py-1 text-left text-khaki">
                                    {c}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {turn.answer.rows.slice(0, 50).map((row, i) => (
                                <tr key={i} className="border-b border-rule/40">
                                  {turn.answer!.columns.map((c) => (
                                    <td key={c} className="px-2 py-1 text-khaki-dim">
                                      {String(row[c] ?? '')}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>

        <div className="shrink-0 space-y-2 border-t border-rule p-3">
          {turns.length === 0 && (
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <Tag key={s} onClick={() => void submit(s)}>
                  {s}
                </Tag>
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault()
              void submit(draft)
            }}
            className="flex items-center gap-2"
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask about the crime data…"
              aria-label="Ask a question about the crime data"
              className="min-w-0 flex-1 border border-rule bg-transparent px-2 py-1.5 text-[0.82rem] text-khaki outline-none placeholder:text-khaki-dim focus:border-brass"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              className="label border border-rule px-3 py-1.5 text-khaki transition-colors hover:border-brass hover:text-brass disabled:opacity-40"
            >
              Ask
            </button>
          </form>

          <DecisionSupportNote>
            Answers are generated by querying the Data Store, not by a model reading records. Check
            the query before acting on the result. Figures shown are synthetic.
          </DecisionSupportNote>
        </div>
      </div>
    </Panel>
  )
}
