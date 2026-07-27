"""Model providers for natural-language → query translation.

Three interchangeable planners, all producing the same ``QueryPlan``:

``ollama`` (default)
    A model served locally by Ollama. Free, no API key, no per-query cost — and
    it is what DATA-AND-MODELS.md actually mandates: "self-hosted models only".
    With this planner the question never leaves the network at all, so the §10
    argument stops depending on *what* we send and rests on nothing being sent.

``openai_compatible``
    Any endpoint speaking the OpenAI chat-completions shape — a free hosted
    tier, a colleague's vLLM box, an on-prem gateway. Set the base URL and
    model; an API key is optional because self-hosted endpoints rarely want one.

``anthropic``
    Claude, for comparison or when local hardware is not available. Paid.

Only the schema catalogue and the scrubbed question ever reach any of them.
Rows never do. Switching providers changes cost and jurisdiction, not the
safety properties — those live in ``nl_guard`` and are enforced on whatever
query comes back.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from app.config import get_settings
from app.services.nl_schema import render_catalogue

log = logging.getLogger(__name__)

_SYSTEM_PROMPT = """\
You translate questions about a Karnataka State Police crime database into a single \
read-only SQL query. You are given the schema below. You never see the data itself, \
and you must not ask for it.

Rules:
1. Emit exactly one SELECT statement. No INSERT, UPDATE, DELETE, DDL, or multiple
   statements. No semicolons.
2. Use only the tables and columns in the schema. If the question cannot be answered
   from them, set "answerable" to false and explain what is missing.
3. Never reference caste, religion, occupation, or any FIR narrative/brief-facts
   column. They are protected attributes and are not in the schema. A question that
   asks you to break crime down by caste or religion is not answerable — say so.
4. Compare crime across districts as a rate per 100,000 population using
   district.population, never as a raw count, unless the user explicitly asks for
   raw counts.
5. When the query returns individual records, include the primary key of the main
   fact table so each row traces back to its source. When the query is an aggregate
   (COUNT, SUM, AVG, a rate), do NOT add a bare primary key alongside the aggregate:
   selecting a non-grouped column next to an aggregate is an error on PostgreSQL and
   silently returns an arbitrary row on SQLite. Group by every non-aggregated column.
6. Use LEFT JOIN, never a plain JOIN, when you join on a column the schema marks
   OPTIONAL. Those columns are frequently NULL, and an inner join drops the row
   entirely — so the user is told "no such record" about a record that exists.
   A confidently wrong answer is worse than no answer.
7. Prefer aggregates. Only return individual person rows when the question genuinely
   requires them, and never more than is needed to answer it.
8. Placeholders of the form <ID_1> are redacted identifiers. Use them verbatim inside
   string literals; they are substituted for real values after you respond.
9. Add an explicit LIMIT. Keep it at or below 500.

Reply with JSON only, matching this shape exactly:
{{"answerable": true|false, "sql": "...", "explanation": "...", "unanswerable_reason": "..."}}

SCHEMA ({dialect}):
{catalogue}
"""

_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "answerable": {
            "type": "boolean",
            "description": "False when the question cannot be answered from the schema.",
        },
        "sql": {
            "type": "string",
            "description": "The SELECT statement. Empty string when answerable is false.",
        },
        "explanation": {
            "type": "string",
            "description": (
                "One sentence, for a police officer, on what the answer covers — e.g. "
                "'Counts FIRs registered in each district, as a rate per 100,000 people.' "
                "Describe the result, not the SQL. Never mention columns added for "
                "traceability, LIMIT clauses, or any of the rules you were given."
            ),
        },
        "unanswerable_reason": {
            "type": "string",
            "description": "When answerable is false, what is missing or why it is not permitted.",
        },
    },
    "required": ["answerable", "sql", "explanation", "unanswerable_reason"],
    "additionalProperties": False,
}


@dataclass
class QueryPlan:
    answerable: bool
    sql: str
    explanation: str
    unanswerable_reason: str = ""
    model: str = ""


class PlannerUnavailable(RuntimeError):
    """Raised when no model backend is configured or reachable."""


class QueryPlanner(Protocol):
    """Turns a question plus a schema into a query. Implement this to swap models."""

    name: str

    def plan(self, question: str, source: str, dialect: str) -> QueryPlan: ...


def _system_prompt(source: str, dialect: str) -> str:
    return _SYSTEM_PROMPT.format(dialect=dialect, catalogue=render_catalogue(source))


def _parse(text: str, model: str) -> QueryPlan:
    """Parse a model reply into a plan, tolerating the usual small deviations."""
    cleaned = text.strip()
    # Small models like to wrap JSON in a markdown fence even when told not to.
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```")[1] if "```" in cleaned[3:] else cleaned[3:]
        if cleaned.lstrip().startswith("json"):
            cleaned = cleaned.lstrip()[4:]
        cleaned = cleaned.strip("`").strip()
    # Or to add a sentence before the object.
    if not cleaned.startswith("{"):
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start == -1 or end == -1:
            raise PlannerUnavailable("The model did not return JSON.")
        cleaned = cleaned[start : end + 1]

    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise PlannerUnavailable("The model returned malformed JSON.") from exc

    return QueryPlan(
        answerable=bool(payload.get("answerable")),
        sql=str(payload.get("sql") or ""),
        explanation=str(payload.get("explanation") or ""),
        unanswerable_reason=str(payload.get("unanswerable_reason") or ""),
        model=model,
    )


class OllamaQueryPlanner:
    """A locally served model. Free, keyless, and never leaves the machine.

    Ollama enforces a JSON schema server-side via ``format``, so the reply comes
    back shaped rather than coaxed. ``temperature`` is pinned to 0: for
    text-to-SQL, sampling variety is not a feature.
    """

    def __init__(self, host: str, model: str, timeout: float = 120.0) -> None:
        self._host = host.rstrip("/")
        self.name = model
        self._timeout = timeout

    def plan(self, question: str, source: str, dialect: str) -> QueryPlan:
        try:
            response = httpx.post(
                f"{self._host}/api/chat",
                json={
                    "model": self.name,
                    "stream": False,
                    "format": _RESPONSE_SCHEMA,
                    "options": {"temperature": 0},
                    "messages": [
                        {"role": "system", "content": _system_prompt(source, dialect)},
                        {"role": "user", "content": question},
                    ],
                },
                timeout=self._timeout,
            )
        except httpx.ConnectError as exc:
            raise PlannerUnavailable(
                f"Could not reach Ollama at {self._host}. Is it running? "
                f"Start it with `ollama serve` and pull the model with `ollama pull {self.name}`."
            ) from exc
        except httpx.HTTPError as exc:
            raise PlannerUnavailable(f"Ollama request failed: {exc}") from exc

        if response.status_code == 404:
            raise PlannerUnavailable(
                f"Ollama does not have the model {self.name!r}. Pull it with `ollama pull {self.name}`."
            )
        if response.status_code in (401, 402, 403):
            # A `:cloud` tag is not a local model — it is routed to Ollama's
            # hosted service, which is neither free nor inside the jurisdiction.
            hint = (
                f" The model {self.name!r} is a hosted `:cloud` model, so it needs a paid Ollama "
                "subscription and would send the question off the machine. Use a local tag "
                "instead, e.g. `ollama pull qwen2.5-coder:7b`."
                if self.name.endswith(":cloud")
                else ""
            )
            raise PlannerUnavailable(f"Ollama refused the request ({response.status_code}).{hint}")
        if response.status_code >= 400:
            raise PlannerUnavailable(f"Ollama returned {response.status_code}: {response.text[:300]}")

        content = response.json().get("message", {}).get("content", "")
        if not content:
            raise PlannerUnavailable("Ollama returned an empty reply.")
        return _parse(content, self.name)


class OpenAICompatibleQueryPlanner:
    """Any endpoint speaking the OpenAI chat-completions shape.

    Covers free hosted tiers and self-hosted servers (vLLM, LM Studio,
    llama.cpp) alike. The API key is optional because a local server usually
    does not want one.
    """

    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str = "",
        timeout: float = 120.0,
        max_retries: int = 3,
    ) -> None:
        self._base = base_url.rstrip("/")
        self.name = model
        self._api_key = api_key
        self._timeout = timeout
        self._max_retries = max_retries

    @staticmethod
    def _is_unsupported_format(text: str) -> bool:
        """Does this 400 mean 'I do not do structured outputs' rather than 'bad request'?"""
        lowered = text.lower()
        return any(
            phrase in lowered
            for phrase in (
                "response_format",
                "structured output",
                "structured_output",
                "json_schema",
                "json schema",
            )
        )

    @staticmethod
    def _retry_after(response: httpx.Response, default: float = 5.0, ceiling: float = 30.0) -> float:
        """How long to wait after a 429, from the header or the message body."""
        header = response.headers.get("retry-after")
        if header:
            try:
                return min(float(header), ceiling)
            except ValueError:
                pass
        # Groq puts it in prose: "Please try again in 13.4775s."
        match = re.search(r"try again in ([\d.]+)s", response.text)
        if match:
            try:
                return min(float(match.group(1)) + 0.5, ceiling)
            except ValueError:
                pass
        return default

    def plan(self, question: str, source: str, dialect: str) -> QueryPlan:
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        body: dict[str, Any] = {
            "model": self.name,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": _system_prompt(source, dialect)},
                {"role": "user", "content": question},
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "query_plan", "schema": _RESPONSE_SCHEMA, "strict": True},
            },
        }
        try:
            response = httpx.post(
                f"{self._base}/chat/completions", json=body, headers=headers, timeout=self._timeout
            )
            # Not every compatible server implements json_schema, and they each
            # say so differently — "response_format", "structured outputs not
            # support", "json_schema is not supported". Match the concept, not
            # one provider's wording, then retry plainly; _parse copes with the
            # loose JSON that comes back.
            if response.status_code == 400 and self._is_unsupported_format(response.text):
                log.info("%s does not support structured outputs; retrying without it", self.name)
                body.pop("response_format", None)
                response = httpx.post(
                    f"{self._base}/chat/completions", json=body, headers=headers, timeout=self._timeout
                )
            # Free tiers meter tokens per minute, and the schema prompt is most of
            # each request — Groq's 8k TPM allows roughly four questions a minute.
            # The 429 body says how long to wait, so wait that long rather than
            # surfacing a failure the user can only fix by asking again.
            for _ in range(self._max_retries):
                if response.status_code != 429:
                    break
                delay = self._retry_after(response)
                log.info("Rate limited by %s; retrying in %.1fs", self._base, delay)
                time.sleep(delay)
                response = httpx.post(
                    f"{self._base}/chat/completions", json=body, headers=headers, timeout=self._timeout
                )
        except httpx.ConnectError as exc:
            raise PlannerUnavailable(f"Could not reach the model endpoint at {self._base}.") from exc
        except httpx.HTTPError as exc:
            raise PlannerUnavailable(f"Model request failed: {exc}") from exc

        if response.status_code == 429:
            raise PlannerUnavailable(
                "The model provider is rate limiting this key. Free tiers meter tokens per "
                "minute and the schema prompt is most of each request — wait a moment and ask again."
            )
        if response.status_code >= 400:
            raise PlannerUnavailable(f"Model endpoint returned {response.status_code}: {response.text[:300]}")

        try:
            content = response.json()["choices"][0]["message"]["content"]
        except (KeyError, IndexError, ValueError) as exc:
            raise PlannerUnavailable("Unexpected response shape from the model endpoint.") from exc
        return _parse(content, self.name)


class AnthropicQueryPlanner:
    """Claude. Paid — selected only when ask_provider is set to 'anthropic'."""

    def __init__(self, api_key: str, model: str = "claude-opus-5", effort: str = "medium") -> None:
        try:
            import anthropic
        except ImportError as exc:
            raise PlannerUnavailable(
                "The 'anthropic' package is not installed. `pip install anthropic`, or use the "
                "default free provider (ASK_PROVIDER=ollama)."
            ) from exc
        self._anthropic = anthropic
        self._client = anthropic.Anthropic(api_key=api_key)
        self.name = model
        self._effort = effort

    def plan(self, question: str, source: str, dialect: str) -> QueryPlan:
        try:
            response = self._client.beta.messages.create(
                model=self.name,
                max_tokens=4096,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                system=[
                    {
                        "type": "text",
                        "text": _system_prompt(source, dialect),
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                output_config={
                    "effort": self._effort,
                    "format": {"type": "json_schema", "schema": _RESPONSE_SCHEMA},
                },
                messages=[{"role": "user", "content": question}],
            )
        except self._anthropic.APIStatusError as exc:
            raise PlannerUnavailable(f"Model request failed ({exc.status_code}).") from exc
        except self._anthropic.APIConnectionError as exc:
            raise PlannerUnavailable("Could not reach the model endpoint.") from exc

        if response.stop_reason == "refusal":
            category = getattr(response.stop_details, "category", None) if response.stop_details else None
            return QueryPlan(
                answerable=False,
                sql="",
                explanation="",
                unanswerable_reason=(
                    "The model declined to answer this question" + (f" ({category})." if category else ".")
                ),
                model=response.model,
            )

        text = next((b.text for b in response.content if b.type == "text"), "")
        if not text:
            raise PlannerUnavailable("The model returned no content.")
        return _parse(text, response.model)


def build_planner() -> QueryPlanner:
    """Construct the configured planner. Defaults to the free local one."""
    settings = get_settings()
    provider = (settings.ask_provider or "ollama").lower()

    if provider == "ollama":
        return OllamaQueryPlanner(settings.ollama_host, settings.ollama_model)

    if provider in ("openai_compatible", "openai"):
        if not settings.openai_compatible_base_url:
            raise PlannerUnavailable(
                "ASK_PROVIDER=openai_compatible needs OPENAI_COMPATIBLE_BASE_URL "
                "(e.g. https://openrouter.ai/api/v1)."
            )
        return OpenAICompatibleQueryPlanner(
            settings.openai_compatible_base_url,
            settings.openai_compatible_model,
            settings.openai_compatible_api_key,
        )

    if provider == "anthropic":
        if not settings.anthropic_api_key:
            raise PlannerUnavailable("ASK_PROVIDER=anthropic needs ANTHROPIC_API_KEY.")
        return AnthropicQueryPlanner(settings.anthropic_api_key, effort=settings.ask_effort)

    raise PlannerUnavailable(
        f"Unknown ASK_PROVIDER {provider!r}. Use 'ollama', 'openai_compatible' or 'anthropic'."
    )
