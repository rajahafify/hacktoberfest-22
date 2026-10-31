"""Cross-document and country-rule checks that a diligence reviewer would run."""

import datetime as dt

from .normalize import ASEAN, COUNTRY_NAMES, entity_key, to_usd

# Synthetic watchlist for the demo. A real deployment would query OFAC/UN/MAS lists.
DEMO_WATCHLIST = {"VIKTOR SHELL", "OCEANIC FRONT HOLDINGS LTD"}

ID_PMA_MIN_PAID_UP_IDR = 10_000_000_000  # BKPM Reg. 4/2021
VN_CAPITAL_DEADLINE_DAYS = 90            # Law on Enterprises 2020, Art. 75


def finding(severity, pillar, title, detail, docs=()):
    return {"severity": severity, "pillar": pillar, "title": title, "detail": detail, "docs": list(docs)}


def run_checks(docs, graph, today=None):
    """docs: list of {id, name, extraction}. Returns a list of findings."""
    today = today or dt.date.today()
    out = []
    by_id = {n["id"]: n for n in graph["nodes"]}
    registry = [d for d in docs if d["extraction"]["doc_type"] == "registry_profile"]

    for d in registry:
        ex, name = d["extraction"], d["extraction"]["company"]["name"]
        shares = [s["percent"] for s in ex["shareholders"] if s.get("percent") is not None]
        if shares and abs(sum(shares) - 100) > 0.5:
            out.append(finding("high", "ubo", f"Shareholdings of {name} sum to {sum(shares):g}%",
                               "The register should reconcile to 100%; a gap suggests a missing or hidden holder.", [d["id"]]))
        if ex["company"].get("status") not in ("active", None, "unknown"):
            out.append(finding("high", "esg", f"{name} is not active in the {ex['registry']} register",
                               f"Registry status reads '{ex['company']['status']}'.", [d["id"]]))
        for p in ex["shareholders"] + ex["officers"]:
            if entity_key(p["name"]) in DEMO_WATCHLIST:
                out.append(finding("high", "ubo", f"Watchlist hit: {p['name']}",
                                   f"Appears in {name}'s register and on the screening list.", [d["id"]]))
        out += _country_rules(d, today)

    for nid, gaps in graph["undisclosed"].items():
        for g in gaps:
            if by_id[g["id"]]["offshore"] and nid == graph["subject"]:
                out.append(finding(
                    "high", "ubo", f"Undisclosed beneficial owners behind {g['name']}",
                    f"{g['percent']:g}% of {by_id[nid]['label']} is held through a {COUNTRY_NAMES.get(g['jurisdiction'], g['jurisdiction'])} "
                    "entity with no ownership disclosure on file. Upload its register or a UBO declaration.",
                    by_id[nid]["sources"]))

    out += _capital_vs_financials(docs)
    out += _common_officers(registry)
    out += _data_compliance(docs, graph)
    return out


def _country_rules(d, today):
    ex, out = d["extraction"], []
    c, name = ex["company"], ex["company"]["name"]
    foreign = [s for s in ex["shareholders"] if s.get("jurisdiction") and s["jurisdiction"] != ex["country"]]
    foreign_pct = sum(s["percent"] or 0 for s in foreign)

    if ex["country"] == "ID" and foreign:
        cap = c.get("paid_up_capital") or {}
        if not c.get("foreign_investment"):
            out.append(finding("high", "ubo", f"{name} has foreign shareholders but is not registered as PMA",
                               "Foreign-owned Indonesian companies must hold PMA status.", [d["id"]]))
        elif cap.get("currency") == "IDR" and (cap.get("amount") or 0) < ID_PMA_MIN_PAID_UP_IDR:
            out.append(finding("high", "financial", f"{name} is below the PMA paid-up capital minimum",
                               f"Paid-up Rp {cap['amount']:,.0f} vs required Rp {ID_PMA_MIN_PAID_UP_IDR:,.0f}.", [d["id"]]))

    if ex["country"] == "TH" and foreign:
        thai = [s for s in ex["shareholders"] if s.get("jurisdiction") == "TH"]
        if foreign_pct >= 50:
            out.append(finding("high", "ubo", f"{name} is majority foreign-owned ({foreign_pct:g}%)",
                               "Services businesses need a Foreign Business Licence under the FBA 1999.", [d["id"]]))
        elif foreign_pct >= 45 and len(thai) == 1:
            out.append(finding("medium", "ubo", f"Possible nominee structure in {name}",
                               f"Foreign holding sits at {foreign_pct:g}%, just under the 50% FBA line, and a single Thai individual "
                               f"({thai[0]['name']}) holds the rest. Verify their source of funds and any side agreements (FBA s.36).",
                               [d["id"]]))

    if ex["country"] == "VN":
        charter, paid = c.get("charter_capital") or {}, c.get("paid_up_capital") or {}
        if charter.get("amount") and paid.get("amount") is not None and paid["amount"] < charter["amount"]:
            inc = c.get("incorporation_date")
            overdue = inc and (today - dt.date.fromisoformat(inc)).days > VN_CAPITAL_DEADLINE_DAYS
            share = 100 * paid["amount"] / charter["amount"]
            out.append(finding("high" if overdue else "medium", "financial",
                               f"{name} has contributed {share:.0f}% of its charter capital",
                               f"Charter capital {charter['amount']:,.0f} VND vs contributed {paid['amount']:,.0f} VND."
                               + (f" The {VN_CAPITAL_DEADLINE_DAYS}-day contribution window from {inc} has passed." if overdue else ""),
                               [d["id"]]))
    return out


def _capital_vs_financials(docs):
    out = []
    reg = {entity_key(d["extraction"]["company"]["name"] or ""): d for d in docs
           if d["extraction"]["doc_type"] == "registry_profile"}
    for d in docs:
        fin = d["extraction"].get("financials") or {}
        fs_cap = fin.get("share_capital")
        r = reg.get(entity_key(d["extraction"]["company"]["name"] or ""))
        if not fs_cap or not r:
            continue
        reg_cap = r["extraction"]["company"].get("paid_up_capital")
        a, b = to_usd(reg_cap), to_usd(fs_cap)
        if a and b and abs(a - b) / max(a, b) > 0.02:
            out.append(finding(
                "medium", "financial", f"Paid-up capital differs between registry and financial statements",
                f"{r['extraction']['registry']} shows {reg_cap['currency']} {reg_cap['amount']:,.0f}; audited accounts show "
                f"{fs_cap['currency']} {fs_cap['amount']:,.0f}. Confirm whether shares were issued after year end.",
                [r["id"], d["id"]]))
    return out


def _common_officers(registry):
    seen = {}
    for d in registry:
        for o in d["extraction"]["officers"]:
            seen.setdefault(entity_key(o["name"]), set()).add(d["extraction"]["company"]["name"])
    out = []
    for key, companies in seen.items():
        if len(companies) > 1:
            out.append(finding("info", "ubo", f"{key} holds office in {len(companies)} group entities",
                               "Common control across: " + ", ".join(sorted(companies)) + ".", []))
    return out


FRAMEWORKS = {"SG": ["SG PDPA"], "MY": ["MY PDPA"], "ID": ["ID PDP", "UU 27"], "TH": ["TH PDPA", "THAI PDPA"],
              "VN": ["DECREE 13", "PDPD", "VN PDP"], "PH": ["DPA 2012", "PH DPA"]}
LOCALISATION_REQUIRED = {"VN": "Decree 53/2022 requires covered enterprises to store Vietnamese user data in Vietnam."}


def framework_coverage(declared, market):
    upper = [f.upper() for f in declared]
    return any(any(token in f for token in FRAMEWORKS.get(market, [])) for f in upper)


def _data_compliance(docs, graph):
    from .graph import operating_markets
    markets = operating_markets(graph)
    decls = [d for d in docs if d["extraction"].get("compliance")]
    if not decls:
        return [finding("medium", "regulatory", "No data-protection or IP declaration provided",
                        "Upload a compliance declaration covering privacy frameworks, hosting and IP assignment.")]
    out = []
    comp, ids = decls[0]["extraction"]["compliance"], [decls[0]["id"]]
    for m in markets:
        if not framework_coverage(comp.get("privacy_frameworks") or [], m):
            out.append(finding("medium", "regulatory", f"No {COUNTRY_NAMES.get(m, m)} privacy framework declared",
                               f"The group operates a registered entity in {COUNTRY_NAMES.get(m, m)} but its declaration does not "
                               f"reference {FRAMEWORKS.get(m, ['local law'])[0]}.", ids))
        hosted = (comp.get("hosting") or {}).get(m)
        if m in LOCALISATION_REQUIRED and hosted and hosted != m:
            out.append(finding("medium", "regulatory", f"{COUNTRY_NAMES[m]} user data hosted in {COUNTRY_NAMES.get(hosted, hosted)}",
                               LOCALISATION_REQUIRED[m], ids))
    if comp.get("ip_assigned_to_company") is False:
        out.append(finding("high", "regulatory", "Core IP is not assigned to the company",
                           "Founders or contractors may still own the technology personally.", ids))
    return out
