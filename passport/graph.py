"""Build the cross-border ownership graph and resolve ultimate beneficial owners."""

from .normalize import ASEAN, OFFSHORE_JURISDICTIONS, entity_key

UBO_THRESHOLD = 25.0  # FATF-style threshold used by ACRA, SSM, AHU (PP 13/2018) and DBD guidance


def build_graph(extractions):
    """extractions: list of (doc_id, normalized extraction) for registry profiles."""
    nodes, edges = {}, []

    def node(name, kind, jurisdiction=None, **extra):
        key = entity_key(name)
        n = nodes.setdefault(key, {
            "id": key, "label": name, "kind": kind, "jurisdiction": jurisdiction,
            "documented": False, "sources": [], "native_name": None,
        })
        if jurisdiction and not n["jurisdiction"]:
            n["jurisdiction"] = jurisdiction
        for k, v in extra.items():
            if v:
                n[k] = v
        return n

    for doc_id, ex in extractions:
        company = ex["company"]
        if not company.get("name"):
            continue
        c = node(company["name"], "entity", ex.get("country"), native_name=company.get("native_name"),
                 registry=ex.get("registry"), registration_no=company.get("registration_no"))
        c["documented"] = True
        c["kind"] = "entity"
        c["jurisdiction"] = ex.get("country") or c["jurisdiction"]
        c["sources"].append(doc_id)
        for sh in ex["shareholders"]:
            o = node(sh["name"], sh["kind"], sh.get("jurisdiction"), native_name=sh.get("native_name"))
            edges.append({"from": o["id"], "to": c["id"], "percent": sh.get("percent"), "source": doc_id})

    owners_of = {}
    for e in edges:
        owners_of.setdefault(e["to"], []).append(e)

    for n in nodes.values():
        n["offshore"] = n["kind"] == "entity" and n["jurisdiction"] in OFFSHORE_JURISDICTIONS
        n["undisclosed"] = n["kind"] == "entity" and n["id"] not in owners_of

    levels = {}

    def level(nid, stack=()):
        if nid in levels:
            return levels[nid]
        if nid in stack:
            return 0
        owners = owners_of.get(nid, [])
        lv = 1 + max((level(e["from"], stack + (nid,)) for e in owners), default=-1)
        levels[nid] = lv
        return lv

    for nid in nodes:
        nodes[nid]["level"] = level(nid)

    # The passport subject is the documented holding company with the most subsidiaries.
    subs = {nid: sum(1 for e in edges if e["from"] == nid) for nid, n in nodes.items() if n["documented"]}
    subject = max(subs, key=lambda k: (subs[k], -nodes[k]["level"]), default=None)

    ubo = {}
    undisclosed = {}
    for nid, n in nodes.items():
        if n["documented"]:
            persons, gaps = effective_ownership(nid, owners_of, nodes)
            ubo[nid] = sorted(({"id": p, "name": nodes[p]["label"], "percent": round(v, 2),
                                "is_ubo": v >= UBO_THRESHOLD} for p, v in persons.items()),
                              key=lambda x: -x["percent"])
            undisclosed[nid] = [{"id": g, "name": nodes[g]["label"], "jurisdiction": nodes[g]["jurisdiction"],
                                 "percent": round(v, 2)} for g, v in gaps.items()]

    resolved = sum(p["percent"] for p in ubo.get(subject, []))
    return {
        "nodes": list(nodes.values()),
        "edges": edges,
        "subject": subject,
        "group": sorted(_group(subject, edges)) if subject else [],
        "ubo": ubo,
        "undisclosed": undisclosed,
        "subject_resolved_percent": round(min(resolved, 100.0), 2),
        "threshold": UBO_THRESHOLD,
    }


def effective_ownership(company, owners_of, nodes, _stack=()):
    """Multiply stakes down every chain. Returns (person -> %, undisclosed entity -> %)."""
    persons, gaps = {}, {}
    for e in owners_of.get(company, []):
        pct = e["percent"] or 0.0
        owner = nodes[e["from"]]
        if owner["kind"] == "person":
            persons[owner["id"]] = persons.get(owner["id"], 0.0) + pct
        elif owner["id"] in _stack or owner["id"] not in owners_of:
            gaps[owner["id"]] = gaps.get(owner["id"], 0.0) + pct
        else:
            p2, g2 = effective_ownership(owner["id"], owners_of, nodes, _stack + (company,))
            for k, v in p2.items():
                persons[k] = persons.get(k, 0.0) + pct * v / 100
            for k, v in g2.items():
                gaps[k] = gaps.get(k, 0.0) + pct * v / 100
    return persons, gaps


def _group(subject, edges):
    """The subject plus every entity it owns directly or indirectly."""
    seen, frontier = {subject}, [subject]
    while frontier:
        cur = frontier.pop()
        for e in edges:
            if e["from"] == cur and e["to"] not in seen:
                seen.add(e["to"])
                frontier.append(e["to"])
    return seen


def operating_markets(graph):
    """ASEAN jurisdictions where the subject's group has a registered entity."""
    by_id = {n["id"]: n for n in graph["nodes"]}
    return sorted({by_id[g]["jurisdiction"] for g in graph["group"] if by_id[g]["jurisdiction"] in ASEAN})
