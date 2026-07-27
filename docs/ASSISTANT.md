# YUKTI: The Natural-Language Assistant

`POST /api/ask` answers questions about the crime database in plain language.
This document explains how it stays inside the constraints DATA-AND-MODELS.md
sets, because those constraints are the reason it is built the way it is rather
than the way a chatbot is usually built.

---

## The constraint

DATA-AND-MODELS.md is unambiguous. Under CIAP §10 and the DPDP Act 2023:

> FIR text cannot be sent to third-party services, including commercial LLMs.

and the ML session primer lists **"self-hosted models only"** as a hard
constraint. §2.6 applies it concretely: Kannada NER must run on
`ai4bharat/IndicNER` locally, never a hosted endpoint.

A conventional RAG chatbot — retrieve records, paste them into a prompt, let
the model narrate — violates this on its first request. So this is not that.

## The design

The model never sees data. It sees the **schema** and the **question**, and it
returns a **query**. The query executes inside the jurisdiction, and the prose
the user reads is assembled from the result set by code.

```
question
   │
   ├─ scrub ............ identifiers replaced with <ID_n> placeholders
   │                     (app/services/nl_guard.py)
   ├─ plan ............. THE ONLY STEP INVOLVING THE MODEL
   │                     it receives: the schema catalogue + the scrubbed question
   │                     it returns:  one SELECT statement
   │                     (app/services/nl_provider.py)
   ├─ rehydrate ........ real identifiers substituted back, locally
   ├─ validate ......... read-only, allowlisted, bounded — or rejected outright
   │                     (app/services/nl_guard.py)
   ├─ execute .......... local SQLAlchemy session, or Catalyst over ZCQL
   │                     (app/services/nl_query.py)
   └─ summarise ........ answer text composed in code from the rows
```

Nothing after `plan` crosses the network boundary. No row, no FIR narrative, no
person record is ever an input to a model.

### Why the identifier scrub exists

The schema is safe to send. The *question* is not: "what is the status of crime
number 100051428201600001" carries an identifier to a third party even though
no row does. Rather than reject such questions, `scrub` replaces the
identifiers with `<ID_1>`-style placeholders. The model writes
`WHERE crime_no = '<ID_1>'`; the real value goes back in locally. The query
still works and the identifier never left.

The response reports how many were redacted in `redactedIdentifiers`.

**Residual risk, stated plainly:** the scrubber catches structured identifiers —
long numeric ids, emails, phone numbers. It cannot reliably catch a person's
*name* typed into a question, because names are not distinguishable from
ordinary words by pattern. If that matters for your threat model, move to a
self-hosted planner (below), where the question never leaves at all.

### Why the validator exists

Everything the prompt asks for is re-checked as a hard rule in
`validate_query`. A prompt is a request; a validator is a guarantee. It rejects,
rather than repairs:

| Rejected | Because |
|---|---|
| Anything but a single `SELECT` | No writes, no DDL, no stacked statements |
| `case_master.narrative`, `BriefFacts` | The FIR free text §10 protects |
| `caste_master`, `religion_master`, `occupation_master` | Protected attributes, §2.0 |
| `audit_log` | Who asked what is not itself queryable |
| Any table or column not in the catalogue | Allowlist, not blocklist |
| Missing or oversized `LIMIT` | Clamped to 500 rows |

`narrative` is empty across all 10,000 current cases. It will not be once CCTNS
data lands, which is exactly why the block is in place now.

### Evidence

Per BACKEND.md, every answer carries `evidence` — the record ids the rows came
from. When a result is a pure aggregate with no per-record id, `evidence` is
empty and `notes` says so explicitly rather than leaving it ambiguous.

### Audit

Every call writes to `audit_log` per §10.1 — the question, the generated query,
the records touched, success or failure. This is unconditional; it does not
respect the `audit_reads` flag that governs ordinary GETs, because a
natural-language query is exactly the kind of access that should always be
attributable.

---

## Data sources

`source` selects where the query runs. Both are read through the same endpoint.

| `source` | Runs against | Dialect |
|---|---|---|
| `local` (default) | This backend's SQLAlchemy session | SQL |
| `catalyst` | Zoho Catalyst Data Store | ZCQL |

`app/services/catalyst.py` adds the Catalyst Data Store as a backend data
source — CATALYST-DEPLOY.md previously treated Catalyst as hosting only (Slate +
AppSail). Auth is the Zoho OAuth refresh-token grant; access tokens are minted
on demand and cached.

> **Catalyst paging gotcha, encoded in the client:** ZCQL treats the offset in
> `LIMIT offset, count` as **1-indexed**, so offset-based paging silently
> repeats one row at every page boundary. `paged_query` cursors on `ROWID`
> instead. Do not "simplify" it back to offsets.

---

## The model

The default is a **free local model served by Ollama**. No API key, no
per-query cost, and — the part that matters here — the question never leaves
the machine, so §10 holds without needing an argument about *what* we send.
This is the "self-hosted models only" path DATA-AND-MODELS.md asks for.

```bash
ollama serve
ollama pull qwen2.5-coder:7b     # ~4.7 GB, strong at text-to-SQL
```

Then nothing else is required — `ASK_PROVIDER=ollama` is the default.

> ⚠️ **A `:cloud` tag is not a local model.** Ollama can route tags like
> `kimi-k2.5:cloud` to its hosted service. That needs a paid subscription *and*
> sends the question off the machine, which defeats the point. The client
> detects this and says so rather than failing obscurely. Use plain tags.

Three providers are available, all producing the same plan:

| `ASK_PROVIDER` | Cost | Question leaves the machine? | Satisfies §10 as written? |
|---|---|---|---|
| `ollama` (default) | Free | **No** | **Yes** |
| `openai_compatible` | Depends on the endpoint | Yes, unless the endpoint is yours | Only if self-hosted |
| `anthropic` | Paid | Yes (schema + question; never rows) | No |

**Choosing a hosted provider is a compliance decision, not a performance one.**
Measured on the assistant's own question set: Groq `llama-3.3-70b-versatile`
scored 7/7 at ~670 ms, OpenRouter `ling-3.0-flash:free` 7/7 at ~3.2 s. Both are
far quicker than a 7B model on CPU. But DATA-AND-MODELS.md states "self-hosted
models only" without qualification, and CIAP §10 requires processing to stay
inside Indian jurisdiction — and Groq, OpenRouter and Anthropic are all outside
it.

The mitigation in this design is real: the model receives the schema and the
question, never a row, and never FIR text. That is a much weaker exposure than
a retrieval chatbot. It is **not** the same as complying with the constraint as
written. So the shipped default is the self-hosted one, and pointing
`OPENAI_COMPATIBLE_BASE_URL` at a third party is a deliberate act recorded in
your own `.env`.

`openai_compatible` covers free hosted tiers and self-hosted servers (vLLM,
LM Studio, llama.cpp) with the same code path — set a base URL and a model, and
leave the key blank for a local server that does not want one.

Whichever you pick, the safety properties do not move: they live in
`nl_guard.py` and are enforced on whatever query comes back. A worse model
produces worse SQL, not less safe SQL.

## Configuration

```bash
ASK_ENABLED=true
ASK_DEFAULT_SOURCE=local     # local | catalyst

ASK_PROVIDER=ollama
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5-coder:7b

# ASK_PROVIDER=openai_compatible
OPENAI_COMPATIBLE_BASE_URL=
OPENAI_COMPATIBLE_MODEL=
OPENAI_COMPATIBLE_API_KEY=

# ASK_PROVIDER=anthropic   (paid; pip install anthropic)
ANTHROPIC_API_KEY=
ASK_EFFORT=medium

CATALYST_PROJECT_ID=
CATALYST_ENVIRONMENT_ID=
CATALYST_REFRESH_TOKEN=
CATALYST_CLIENT_ID=
CATALYST_CLIENT_SECRET=
CATALYST_DC=in
CATALYST_ENVIRONMENT=Development
```

With no model reachable, `/api/ask` returns a clear 422 naming the fix rather
than failing obscurely, and every other endpoint is unaffected.

## Tests

```bash
cd backend && python test_ask_guards.py
```

No key, no database, no network — the scrubber and validator are pure
functions, which is the point. Add a case whenever you add a table or column.

---

## Endpoints

### `POST /api/ask`

```json
{ "question": "which districts have the most vehicle theft per capita?",
  "source": "local" }
```

Returns the standard envelope. `data`:

| Field | Meaning |
|---|---|
| `answer` | Prose composed in code from the rows — not model-generated |
| `query` | The exact statement executed, for review |
| `columns`, `rows` | The result set |
| `evidence` | Record ids behind the answer |
| `answerable` | False when the question cannot or should not be answered |
| `redactedIdentifiers` | How many identifiers were scrubbed from the question |
| `notes` | Caveats worth surfacing in the UI |

A question that asks for something protected comes back with
`answerable: false` and a reason, not an error.

### `GET /api/ask/schema`

The catalogue as data, for a UI that wants to show what can be asked about.
This is the same text the model receives — there is no hidden second schema.

---

## Adding another provider

Implement `QueryPlanner` and add a branch to `build_planner()`:

```python
class MyQueryPlanner:
    name = "whatever-model"

    def plan(self, question: str, source: str, dialect: str) -> QueryPlan:
        ...
```

Nothing else changes. The scrubber, validator, executor, summariser, evidence
collection and audit trail are all provider-agnostic, and `test_ask_guards.py`
covers them independently of which model produced the query.

`_parse()` is deliberately forgiving about reply formatting — small local
models wrap JSON in markdown fences and open with "Sure! Here is the query:"
no matter what the prompt says. It strips both. What it does **not** forgive is
the query itself; that goes to the validator like any other.

---

## Known limitations

- **Name scrubbing.** See the residual-risk note above.
- **The summariser is deliberately simple.** It handles scalars, single rows,
  and label/value pairs; anything else it reports as shape plus columns. This is
  a floor, not a ceiling — but improving it must not mean sending rows to a
  model.
- **No conversational memory.** Each question is independent. Multi-turn
  follow-ups ("and for last year?") are not resolved. Adding them means sending
  prior questions, not prior data — the boundary holds either way.
- **The local and Catalyst schemas differ.** They are two different datasets
  with two different shapes, not two views of one. A question phrased for one
  may not be answerable against the other.
