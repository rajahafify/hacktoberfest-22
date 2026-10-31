"""Pluggable extraction backends.

PASSPORT_BACKEND selects one:
  mock    deterministic label-dictionary extractor (default, no network)
  ollama  Gemma via a local Ollama server, e.g. `ollama run gemma3:12b`
  openai  Gemma via any OpenAI-compatible server: vLLM, llama.cpp, LM Studio,
          or Google AI Studio's OpenAI endpoint

Self-hosting Gemma (ollama / vLLM in an in-country VPC) is what keeps
director IDs and cap tables inside the jurisdiction they came from.
"""

import json
import os
import re
import urllib.request

from . import mock_extract
from .normalize import country_code, parse_money, parse_number, split_native_name
from .schema import EXTRACTION_SCHEMA, SYSTEM_PROMPT, user_prompt


class ExtractionError(RuntimeError):
    pass


class MockBackend:
    name = "mock"
    description = "Deterministic label-dictionary extractor (no model call)"

    def extract(self, filename, text):
        return mock_extract.extract(filename, text)


class _HTTPBackend:
    timeout = float(os.environ.get("GEMMA_TIMEOUT", "180"))

    def _post(self, url, payload, headers=None):
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode(), method="POST",
            headers={"Content-Type": "application/json", **(headers or {})},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode())
        except Exception as exc:  # urllib raises several unrelated types
            raise ExtractionError(f"{self.name} request to {url} failed: {exc}") from exc


class OllamaBackend(_HTTPBackend):
    name = "ollama"

    def __init__(self, url=None, model=None):
        self.url = (url or os.environ.get("GEMMA_URL", "http://localhost:11434")).rstrip("/")
        self.model = model or os.environ.get("GEMMA_MODEL", "gemma3:12b")
        self.description = f"Gemma ({self.model}) via Ollama at {self.url}"

    def extract(self, filename, text):
        data = self._post(f"{self.url}/api/chat", {
            "model": self.model,
            "stream": False,
            "format": EXTRACTION_SCHEMA,  # Ollama constrains decoding to this schema
            "options": {"temperature": 0},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt(filename, text)},
            ],
        })
        return parse_model_json(data.get("message", {}).get("content", ""))


class OpenAICompatBackend(_HTTPBackend):
    name = "openai"

    def __init__(self, url=None, model=None, api_key=None):
        self.url = (url or os.environ.get("GEMMA_URL", "http://localhost:8000/v1")).rstrip("/")
        self.model = model or os.environ.get("GEMMA_MODEL", "google/gemma-3-12b-it")
        self.api_key = api_key or os.environ.get("GEMMA_API_KEY", "")
        self.description = f"Gemma ({self.model}) via OpenAI-compatible API at {self.url}"

    def extract(self, filename, text):
        schema_hint = "\n\nJSON schema:\n" + json.dumps(EXTRACTION_SCHEMA)
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        data = self._post(f"{self.url}/chat/completions", {
            "model": self.model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            # Gemma has no separate system role, so the instructions lead the user turn.
            "messages": [{"role": "user", "content": SYSTEM_PROMPT + schema_hint + "\n\n" + user_prompt(filename, text)}],
        }, headers)
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ExtractionError(f"Unexpected response shape: {str(data)[:200]}") from exc
        return parse_model_json(content)


BACKENDS = {"mock": MockBackend, "ollama": OllamaBackend, "openai": OpenAICompatBackend}


def get_backend(name=None):
    name = (name or os.environ.get("PASSPORT_BACKEND", "mock")).lower()
    if name not in BACKENDS:
        raise ValueError(f"Unknown backend {name!r}; choose one of {', '.join(BACKENDS)}")
    return BACKENDS[name]()


def parse_model_json(content):
    """Pull the JSON object out of a model reply, tolerating ```json fences or chatter."""
    if isinstance(content, dict):
        return content
    s = content.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", s, re.S)
    if fenced:
        s = fenced.group(1)
    elif not s.startswith("{"):
        start, end = s.find("{"), s.rfind("}")
        if start == -1 or end <= start:
            raise ExtractionError(f"Model reply contained no JSON object: {s[:200]}")
        s = s[start:end + 1]
    try:
        return json.loads(s)
    except json.JSONDecodeError as exc:
        raise ExtractionError(f"Model reply was not valid JSON: {exc}") from exc


def _money(value):
    if value is None:
        return None
    if isinstance(value, dict):
        amount = parse_number(value.get("amount"))
        return {"amount": amount, "currency": (value.get("currency") or None)} if amount is not None else None
    return parse_money(str(value))


def _party(p):
    if not isinstance(p, dict) or not p.get("name"):
        return None
    name, native = split_native_name(str(p["name"]))
    pct = p.get("percent")
    return {
        "name": name.upper(),
        "native_name": p.get("native_name") or native,
        "kind": "entity" if str(p.get("kind", "")).lower() == "entity" else "person",
        "jurisdiction": country_code(p.get("jurisdiction")) if p.get("jurisdiction") else None,
        "percent": parse_number(str(pct).rstrip("%")) if pct not in (None, "") else None,
        "role": p.get("role"),
    }


def _compliance(c):
    if not isinstance(c, dict):
        return None
    hosting = c.get("hosting") if isinstance(c.get("hosting"), dict) else {}
    return {
        **c,
        "hosting": {(country_code(k) or k): (country_code(v) or v) for k, v in hosting.items()},
        "premises_verified": [country_code(p) or p for p in c.get("premises_verified") or []],
    }


def normalize_extraction(raw):
    """Coerce any backend's output into the exact shape the pipeline expects."""
    company = raw.get("company") or {}
    fin = raw.get("financials")
    if isinstance(fin, dict):
        fin = {**fin, **{k: _money(fin.get(k)) for k in ("revenue", "net_income", "share_capital")}}
        fin["years_covered"] = [int(y) for y in fin.get("years_covered") or [] if str(y).isdigit()]
    return {
        "doc_type": raw.get("doc_type") or "other",
        "country": country_code(raw.get("country")) if raw.get("country") else None,
        "registry": raw.get("registry"),
        "language": raw.get("language") or "und",
        "company": {
            "name": (company.get("name") or "").upper() or None,
            "native_name": company.get("native_name"),
            "registration_no": company.get("registration_no"),
            "incorporation_date": company.get("incorporation_date"),
            "status": (company.get("status") or "unknown").lower(),
            "foreign_investment": company.get("foreign_investment"),
            "paid_up_capital": _money(company.get("paid_up_capital")),
            "charter_capital": _money(company.get("charter_capital")),
        },
        "officers": [p for p in map(_party, raw.get("officers") or []) if p],
        "shareholders": [p for p in map(_party, raw.get("shareholders") or []) if p],
        "financials": fin if isinstance(fin, dict) else None,
        "tax": raw.get("tax") if isinstance(raw.get("tax"), dict) else None,
        "compliance": _compliance(raw.get("compliance")),
        "summary_en": raw.get("summary_en") or "",
        "risk_notes": [str(n) for n in raw.get("risk_notes") or []],
    }
