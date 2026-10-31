// Cross-border ownership graph and ultimate beneficial owner (UBO) resolution.
// Port of passport/graph.py.
import { ASEAN, OFFSHORE_JURISDICTIONS, entityKey } from "./normalize.js";

export const UBO_THRESHOLD = 25;

export function buildGraph(extractions) {
  const nodes = new Map();
  const edges = [];

  const node = (name, kind, jurisdiction, extra = {}) => {
    const key = entityKey(name);
    if (!nodes.has(key)) {
      nodes.set(key, {
        id: key, label: name, kind, jurisdiction: jurisdiction ?? null,
        documented: false, sources: [], native_name: null,
      });
    }
    const n = nodes.get(key);
    if (jurisdiction && !n.jurisdiction) n.jurisdiction = jurisdiction;
    for (const [k, v] of Object.entries(extra)) if (v) n[k] = v;
    return n;
  };

  for (const { id: docId, extraction: ex } of extractions) {
    const company = ex.company;
    if (!company.name) continue;
    const c = node(company.name, "entity", ex.country, {
      native_name: company.native_name, registry: ex.registry, registration_no: company.registration_no,
    });
    c.documented = true;
    c.kind = "entity";
    c.jurisdiction = ex.country || c.jurisdiction;
    c.sources.push(docId);
    for (const sh of ex.shareholders) {
      const o = node(sh.name, sh.kind, sh.jurisdiction, { native_name: sh.native_name });
      edges.push({ from: o.id, to: c.id, percent: sh.percent, source: docId });
    }
  }

  const ownersOf = new Map();
  for (const e of edges) {
    if (!ownersOf.has(e.to)) ownersOf.set(e.to, []);
    ownersOf.get(e.to).push(e);
  }

  for (const n of nodes.values()) {
    n.offshore = n.kind === "entity" && OFFSHORE_JURISDICTIONS.has(n.jurisdiction);
    n.undisclosed = n.kind === "entity" && !ownersOf.has(n.id);
  }

  const levels = new Map();
  const level = (nid, stack = []) => {
    if (levels.has(nid)) return levels.get(nid);
    if (stack.includes(nid)) return 0;
    const owners = ownersOf.get(nid) || [];
    const lv = 1 + Math.max(-1, ...owners.map((e) => level(e.from, [...stack, nid])));
    levels.set(nid, lv);
    return lv;
  };
  for (const nid of nodes.keys()) nodes.get(nid).level = level(nid);

  // The passport subject is the documented holding company with the most subsidiaries.
  let subject = null;
  let best = null;
  for (const [nid, n] of nodes) {
    if (!n.documented) continue;
    const subs = edges.filter((e) => e.from === nid).length;
    const rank = [subs, -n.level];
    if (best === null || rank[0] > best[0] || (rank[0] === best[0] && rank[1] > best[1])) {
      best = rank;
      subject = nid;
    }
  }

  const ubo = {};
  const undisclosed = {};
  for (const [nid, n] of nodes) {
    if (!n.documented) continue;
    const { persons, gaps } = effectiveOwnership(nid, ownersOf, nodes);
    ubo[nid] = [...persons.entries()]
      .map(([p, v]) => ({ id: p, name: nodes.get(p).label, percent: round2(v), is_ubo: v >= UBO_THRESHOLD }))
      .sort((a, b) => b.percent - a.percent);
    undisclosed[nid] = [...gaps.entries()].map(([g, v]) => ({
      id: g, name: nodes.get(g).label, jurisdiction: nodes.get(g).jurisdiction, percent: round2(v),
    }));
  }

  const resolved = (ubo[subject] || []).reduce((s, p) => s + p.percent, 0);
  return {
    nodes: [...nodes.values()],
    edges,
    subject,
    group: subject ? [...groupOf(subject, edges)].sort() : [],
    ubo,
    undisclosed,
    subject_resolved_percent: round2(Math.min(resolved, 100)),
    threshold: UBO_THRESHOLD,
  };
}

export function effectiveOwnership(company, ownersOf, nodes, stack = []) {
  const persons = new Map();
  const gaps = new Map();
  const add = (map, k, v) => map.set(k, (map.get(k) || 0) + v);
  for (const e of ownersOf.get(company) || []) {
    const pct = e.percent || 0;
    const owner = nodes.get(e.from);
    if (owner.kind === "person") {
      add(persons, owner.id, pct);
    } else if (stack.includes(owner.id) || !ownersOf.has(owner.id)) {
      add(gaps, owner.id, pct);
    } else {
      const sub = effectiveOwnership(owner.id, ownersOf, nodes, [...stack, company]);
      for (const [k, v] of sub.persons) add(persons, k, (pct * v) / 100);
      for (const [k, v] of sub.gaps) add(gaps, k, (pct * v) / 100);
    }
  }
  return { persons, gaps };
}

function groupOf(subject, edges) {
  const seen = new Set([subject]);
  const frontier = [subject];
  while (frontier.length) {
    const cur = frontier.pop();
    for (const e of edges) {
      if (e.from === cur && !seen.has(e.to)) {
        seen.add(e.to);
        frontier.push(e.to);
      }
    }
  }
  return seen;
}

export function operatingMarkets(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const markets = new Set();
  for (const g of graph.group) {
    const j = byId.get(g)?.jurisdiction;
    if (j && ASEAN.has(j)) markets.add(j);
  }
  return [...markets].sort();
}

const round2 = (v) => Math.round(v * 100) / 100;
