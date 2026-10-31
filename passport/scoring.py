"""ASEAN Investment Readiness Score (AIRS), 0-1000, built from transparent checks."""

from .crossverify import LOCALISATION_REQUIRED, framework_coverage
from .graph import operating_markets
from .normalize import entity_key

PILLARS = {
    "ubo": ("UBO & Governance Hygiene", 300),
    "financial": ("Financial & Tax Auditability", 300),
    "regulatory": ("Cross-Border Regulatory & Data Compliance", 250),
    "esg": ("ESG & Operational Legitimacy", 150),
}

GRADES = [(800, "A", "Enterprise-ready"), (650, "B", "Investable with conditions"),
          (500, "C", "Needs remediation"), (0, "D", "Not ready")]


def _check(pillar, label, points, fraction, note):
    fraction = max(0.0, min(1.0, fraction))
    return {"pillar": pillar, "label": label, "max": points, "score": round(points * fraction), "note": note}


def score(docs, graph, findings):
    by_id = {n["id"]: n for n in graph["nodes"]}
    group = [by_id[g] for g in graph["group"]]
    markets = operating_markets(graph)
    group_keys = set(graph["group"])
    reg_docs = [d for d in docs if d["extraction"]["doc_type"] == "registry_profile"]
    group_docs = [d for d in reg_docs if entity_key(d["extraction"]["company"]["name"] or "") in group_keys]
    sev = lambda pillar, *levels: [f for f in findings if f["pillar"] == pillar and f["severity"] in levels]

    checks = []
    resolved = graph["subject_resolved_percent"]
    checks.append(_check("ubo", "Ownership traced to natural persons", 120, resolved / 100,
                         f"{resolved:g}% of the holding company resolved to individuals"))
    offshore = [f for f in findings if f["title"].startswith("Undisclosed beneficial owners")]
    checks.append(_check("ubo", "No undisclosed offshore holders", 60, 0 if offshore else 1,
                         f"{len(offshore)} opaque offshore holder(s)" if offshore else "All corporate holders disclosed"))
    bad_sum = [f for f in findings if "sum to" in f["title"]]
    checks.append(_check("ubo", "Share registers reconcile to 100%", 40, 1 - len(bad_sum) / max(len(reg_docs), 1),
                         f"{len(reg_docs) - len(bad_sum)} of {len(reg_docs)} registers reconcile"))
    fo = [f for f in sev("ubo", "high", "medium") if f not in offshore and f not in bad_sum]
    checks.append(_check("ubo", "Foreign ownership & screening rules", 50,
                         1 - sum(1 if f["severity"] == "high" else 0.5 for f in fo) / 2,
                         "; ".join(f["title"] for f in fo) or "No foreign-ownership or watchlist issues"))
    with_officers = sum(1 for d in group_docs if d["extraction"]["officers"])
    checks.append(_check("ubo", "Officers on record for every entity", 30, with_officers / max(len(group_docs), 1),
                         f"{with_officers} of {len(group_docs)} entities list directors"))

    fin_docs = [d["extraction"]["financials"] for d in docs if d["extraction"].get("financials")]
    audited = [f for f in fin_docs if f.get("audited")]
    clean = [f for f in audited if (f.get("opinion") or "").lower() in ("unqualified", "unmodified", "clean")]
    checks.append(_check("financial", "Audited financial statements", 100,
                         1.0 if clean else 0.5 if audited else 0.3 if fin_docs else 0,
                         "Unqualified audit opinion" if clean else "Audited, opinion modified" if audited
                         else "Unaudited statements only" if fin_docs else "No financial statements provided"))
    years = max((len(f.get("years_covered") or []) for f in fin_docs), default=0)
    checks.append(_check("financial", "Three-year financial history", 50, years / 3, f"{years} of 3 years covered"))
    cap_mismatch = [f for f in findings if f["title"].startswith("Paid-up capital differs")]
    checks.append(_check("financial", "Registry capital matches accounts", 70,
                         0 if cap_mismatch else 1 if fin_docs else 0.5,
                         "Mismatch found" if cap_mismatch else "Consistent" if fin_docs else "Nothing to compare"))
    cap_gaps = sev("financial", "high", "medium")
    cap_gaps = [f for f in cap_gaps if f not in cap_mismatch]
    checks.append(_check("financial", "Capital fully contributed", 40, 1 - 0.5 * len(cap_gaps),
                         "; ".join(f["title"] for f in cap_gaps) or "No contribution gaps"))
    taxed = {d["extraction"]["country"] for d in docs if d["extraction"]["doc_type"] == "tax_filing"}
    if any(d["extraction"]["doc_type"] == "financial_statement" for d in docs):
        # Audited accounts are filed with the tax authority alongside the return in SG/MY.
        taxed |= {d["extraction"]["country"] for d in docs if d["extraction"]["doc_type"] == "financial_statement"}
    taxed &= set(markets)
    checks.append(_check("financial", "Tax filings on record per market", 40, len(taxed) / max(len(markets), 1),
                         f"{len(taxed)} of {len(markets)} markets ({', '.join(sorted(taxed)) or 'none'})"))

    comp = next((d["extraction"]["compliance"] for d in docs if d["extraction"].get("compliance")), None) or {}
    covered = [m for m in markets if framework_coverage(comp.get("privacy_frameworks") or [], m)]
    checks.append(_check("regulatory", "Privacy law coverage per market", 90, len(covered) / max(len(markets), 1),
                         f"{len(covered)} of {len(markets)} markets covered"))
    hosting = comp.get("hosting") or {}
    ok = [m for m in markets if m in hosting and (m not in LOCALISATION_REQUIRED or hosting[m] == m)]
    checks.append(_check("regulatory", "Data residency declared and compliant", 60, len(ok) / max(len(markets), 1),
                         f"{len(ok)} of {len(markets)} markets compliant"))
    checks.append(_check("regulatory", "IP assigned to the company", 60, 1 if comp.get("ip_assigned_to_company") else 0,
                         "Deed of assignment on file" if comp.get("ip_assigned_to_company") else "No IP assignment evidence"))
    checks.append(_check("regulatory", "Data protection officer appointed", 40, 1 if comp.get("dpo_appointed") else 0,
                         "DPO appointed" if comp.get("dpo_appointed") else "No DPO declared"))

    active = [d for d in group_docs if d["extraction"]["company"]["status"] == "active"]
    checks.append(_check("esg", "All entities active in their registry", 50, len(active) / max(len(group_docs), 1),
                         f"{len(active)} of {len(group_docs)} active"))
    esg = sum(bool(comp.get(k)) for k in ("esg_report", "emissions_disclosed")) / 2
    checks.append(_check("esg", "ESG report & emissions disclosure", 40, esg,
                         "Both provided" if esg == 1 else "Partially provided" if esg else "Not provided"))
    premises = [m for m in markets if m in (comp.get("premises_verified") or [])]
    checks.append(_check("esg", "Physical premises verified", 30, len(premises) / max(len(markets), 1),
                         f"{len(premises)} of {len(markets)} markets"))
    licences = comp.get("licences") or []
    checks.append(_check("esg", "Sector licences on file", 30, 1 if licences else 0,
                         f"{len(licences)} licence(s)" if licences else "None declared"))

    pillars = []
    for key, (label, maximum) in PILLARS.items():
        pts = sum(c["score"] for c in checks if c["pillar"] == key)
        pillars.append({"key": key, "label": label, "max": maximum, "score": pts})
    total = sum(p["score"] for p in pillars)
    grade, band = next((g, b) for floor, g, b in GRADES if total >= floor)
    return {"total": total, "max": 1000, "grade": grade, "band": band, "pillars": pillars,
            "checks": checks, "markets": markets, "entities": len(group)}

