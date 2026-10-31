"""End-to-end: documents in, passport report out."""

import hashlib

from . import credential
from .backends import ExtractionError, MockBackend, get_backend, normalize_extraction
from .crossverify import run_checks
from .graph import build_graph
from .scoring import score


def analyze(documents, backend=None, today=None):
    """documents: list of {name, text}. Returns the full passport report."""
    backend = backend or get_backend()
    fallback = MockBackend()
    docs, warnings = [], []
    for i, doc in enumerate(documents):
        doc_id = f"doc{i + 1}"
        used = backend.name
        try:
            raw = backend.extract(doc["name"], doc["text"])
        except ExtractionError as exc:
            warnings.append(f"{doc['name']}: {exc}. Fell back to the mock extractor.")
            raw, used = fallback.extract(doc["name"], doc["text"]), "mock (fallback)"
        docs.append({
            "id": doc_id, "name": doc["name"], "text": doc["text"], "backend": used,
            "sha256": hashlib.sha256(doc["text"].encode()).hexdigest(),
            "extraction": normalize_extraction(raw),
        })

    registry = [(d["id"], d["extraction"]) for d in docs if d["extraction"]["doc_type"] == "registry_profile"]
    graph = build_graph(registry)
    findings = run_checks(docs, graph, today=today)
    findings += [{"severity": "low", "pillar": "regulatory", "title": f"Model note on {d['name']}", "detail": n, "docs": [d["id"]]}
                 for d in docs for n in d["extraction"]["risk_notes"]]
    order = {"high": 0, "medium": 1, "low": 2, "info": 3}
    findings.sort(key=lambda f: order[f["severity"]])
    report = {
        "backend": backend.description,
        "warnings": warnings,
        "documents": [{k: v for k, v in d.items() if k != "text"} for d in docs],
        "graph": graph,
        "findings": findings,
        "score": score(docs, graph, findings),
    }
    report["credential"] = credential.issue(report, docs)
    return report
