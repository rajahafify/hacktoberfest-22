// Cross-document checks and the AIRS readiness score. Ports passport/crossverify.py and passport/scoring.py.
import { COUNTRY_NAMES, entityKey, toUsd } from "./normalize.js";
import { operatingMarkets } from "./graph.js";

const DEMO_WATCHLIST = new Set(["VIKTOR SHELL", "OCEANIC FRONT HOLDINGS LTD"]);
const ID_PMA_MIN_PAID_UP_IDR = 10_000_000_000; // BKPM Reg. 4/2021
const VN_CAPITAL_DEADLINE_DAYS = 90; // Law on Enterprises 2020, Art. 75
const LOCALISATION_REQUIRED = {
  VN: "Decree 53/2022 requires covered enterprises to store Vietnamese user data in Vietnam.",
};
const FRAMEWORKS = {
  SG: ["SG PDPA"], MY: ["MY PDPA"], ID: ["ID PDP", "UU 27"], TH: ["TH PDPA", "THAI PDPA"],
  VN: ["DECREE 13", "PDPD", "VN PDP"], PH: ["DPA 2012", "PH DPA"],
};

const finding = (severity, pillar, title, detail, docs = []) => ({ severity, pillar, title, detail, docs });

export function frameworkCoverage(declared, market) {
  const tokens = FRAMEWORKS[market] || [];
  return declared.some((f) => tokens.some((t) => f.toUpperCase().includes(t)));
}

export function runChecks(docs, graph, today = new Date()) {
  const out = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const registry = docs.filter((d) => d.extraction.doc_type === "registry_profile");

  for (const d of registry) {
    const ex = d.extraction;
    const name = ex.company.name;
    const shares = ex.shareholders.map((s) => s.percent).filter((p) => p !== null);
    const total = shares.reduce((a, b) => a + b, 0);
    if (shares.length && Math.abs(total - 100) > 0.5) {
      out.push(finding("high", "ubo", `Shareholdings of ${name} sum to ${total}%`,
        "The register should reconcile to 100%; a gap suggests a missing or hidden holder.", [d.id]));
    }
    if (!["active", null, "unknown"].includes(ex.company.status)) {
      out.push(finding("high", "esg", `${name} is not active in the ${ex.registry} register`,
        `Registry status reads '${ex.company.status}'.`, [d.id]));
    }
    for (const p of [...ex.shareholders, ...ex.officers]) {
      if (DEMO_WATCHLIST.has(entityKey(p.name))) {
        out.push(finding("high", "ubo", `Watchlist hit: ${p.name}`,
          `Appears in ${name}'s register and on the screening list.`, [d.id]));
      }
    }
    out.push(...countryRules(d, today));
  }

  for (const [nid, gaps] of Object.entries(graph.undisclosed)) {
    for (const g of gaps) {
      if (byId.get(g.id).offshore && nid === graph.subject) {
        out.push(finding("high", "ubo", `Undisclosed beneficial owners behind ${g.name}`,
          `${g.percent}% of ${byId.get(nid).label} is held through a ${COUNTRY_NAMES[g.jurisdiction] || g.jurisdiction} ` +
          "entity with no ownership disclosure on file. Upload its register or a UBO declaration.",
          byId.get(nid).sources));
      }
    }
  }

  out.push(...capitalVsFinancials(docs));
  out.push(...commonOfficers(registry));
  out.push(...dataCompliance(docs, graph));
  return out;
}

function countryRules(d, today) {
  const ex = d.extraction;
  const c = ex.company;
  const name = c.name;
  const out = [];
  const foreign = ex.shareholders.filter((s) => s.jurisdiction && s.jurisdiction !== ex.country);
  const foreignPct = foreign.reduce((a, s) => a + (s.percent || 0), 0);

  if (ex.country === "ID" && foreign.length) {
    const cap = c.paid_up_capital || {};
    if (!c.foreign_investment) {
      out.push(finding("high", "ubo", `${name} has foreign shareholders but is not registered as PMA`,
        "Foreign-owned Indonesian companies must hold PMA status.", [d.id]));
    } else if (cap.currency === "IDR" && (cap.amount || 0) < ID_PMA_MIN_PAID_UP_IDR) {
      out.push(finding("high", "financial", `${name} is below the PMA paid-up capital minimum`,
        `Paid-up Rp ${Math.round(cap.amount).toLocaleString("en-US")} vs required Rp ${ID_PMA_MIN_PAID_UP_IDR.toLocaleString("en-US")}.`, [d.id]));
    }
  }

  if (ex.country === "TH" && foreign.length) {
    const thai = ex.shareholders.filter((s) => s.jurisdiction === "TH");
    if (foreignPct >= 50) {
      out.push(finding("high", "ubo", `${name} is majority foreign-owned (${foreignPct}%)`,
        "Services businesses need a Foreign Business Licence under the FBA 1999.", [d.id]));
    } else if (foreignPct >= 45 && thai.length === 1) {
      out.push(finding("medium", "ubo", `Possible nominee structure in ${name}`,
        `Foreign holding sits at ${foreignPct}%, just under the 50% FBA line, and a single Thai individual ` +
        `(${thai[0].name}) holds the rest. Verify their source of funds and any side agreements (FBA s.36).`, [d.id]));
    }
  }

  if (ex.country === "VN") {
    const charter = c.charter_capital || {};
    const paid = c.paid_up_capital || {};
    if (charter.amount && paid.amount !== null && paid.amount !== undefined && paid.amount < charter.amount) {
      const inc = c.incorporation_date;
      const days = inc ? (today - new Date(inc)) / 86_400_000 : 0;
      const overdue = !!inc && days > VN_CAPITAL_DEADLINE_DAYS;
      const share = Math.round((100 * paid.amount) / charter.amount);
      out.push(finding(overdue ? "high" : "medium", "financial",
        `${name} has contributed ${share}% of its charter capital`,
        `Charter capital ${charter.amount.toLocaleString("en-US")} VND vs contributed ${paid.amount.toLocaleString("en-US")} VND.` +
        (overdue ? ` The ${VN_CAPITAL_DEADLINE_DAYS}-day contribution window from ${inc} has passed.` : ""),
        [d.id]));
    }
  }
  return out;
}

function capitalVsFinancials(docs) {
  const out = [];
  const reg = new Map(docs.filter((d) => d.extraction.doc_type === "registry_profile")
    .map((d) => [entityKey(d.extraction.company.name || ""), d]));
  for (const d of docs) {
    const fsCap = d.extraction.financials?.share_capital;
    const r = reg.get(entityKey(d.extraction.company.name || ""));
    if (!fsCap || !r) continue;
    const regCap = r.extraction.company.paid_up_capital;
    const a = toUsd(regCap);
    const b = toUsd(fsCap);
    if (a && b && Math.abs(a - b) / Math.max(a, b) > 0.02) {
      out.push(finding("medium", "financial", "Paid-up capital differs between registry and financial statements",
        `${r.extraction.registry} shows ${regCap.currency} ${regCap.amount.toLocaleString("en-US")}; audited accounts show ` +
        `${fsCap.currency} ${fsCap.amount.toLocaleString("en-US")}. Confirm whether shares were issued after year end.`,
        [r.id, d.id]));
    }
  }
  return out;
}

function commonOfficers(registry) {
  const seen = new Map();
  for (const d of registry) {
    for (const o of d.extraction.officers) {
      const key = entityKey(o.name);
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(d.extraction.company.name);
    }
  }
  const out = [];
  for (const [key, companies] of seen) {
    if (companies.size > 1) {
      out.push(finding("info", "ubo", `${key} holds office in ${companies.size} group entities`,
        `Common control across: ${[...companies].sort().join(", ")}.`, []));
    }
  }
  return out;
}

function dataCompliance(docs, graph) {
  const markets = operatingMarkets(graph);
  const decl = docs.find((d) => d.extraction.compliance);
  if (!decl) {
    return [finding("medium", "regulatory", "No data-protection or IP declaration provided",
      "Upload a compliance declaration covering privacy frameworks, hosting and IP assignment.")];
  }
  const out = [];
  const comp = decl.extraction.compliance;
  const ids = [decl.id];
  for (const m of markets) {
    if (!frameworkCoverage(comp.privacy_frameworks || [], m)) {
      out.push(finding("medium", "regulatory", `No ${COUNTRY_NAMES[m] || m} privacy framework declared`,
        `The group operates a registered entity in ${COUNTRY_NAMES[m] || m} but its declaration does not reference ` +
        `${(FRAMEWORKS[m] || ["local law"])[0]}.`, ids));
    }
    const hosted = (comp.hosting || {})[m];
    if (LOCALISATION_REQUIRED[m] && hosted && hosted !== m) {
      out.push(finding("medium", "regulatory", `${COUNTRY_NAMES[m]} user data hosted in ${COUNTRY_NAMES[hosted] || hosted}`,
        LOCALISATION_REQUIRED[m], ids));
    }
  }
  if (comp.ip_assigned_to_company === false) {
    out.push(finding("high", "regulatory", "Core IP is not assigned to the company",
      "Founders or contractors may still own the technology personally.", ids));
  }
  return out;
}

// ---- Score ----------------------------------------------------------------

const PILLARS = {
  ubo: ["UBO & Governance Hygiene", 300],
  financial: ["Financial & Tax Auditability", 300],
  regulatory: ["Cross-Border Regulatory & Data Compliance", 250],
  esg: ["ESG & Operational Legitimacy", 150],
};
const GRADES = [[800, "A", "Enterprise-ready"], [650, "B", "Investable with conditions"],
  [500, "C", "Needs remediation"], [0, "D", "Not ready"]];

const check = (pillar, label, points, fraction, note) => ({
  pillar, label, max: points,
  score: Math.round(points * Math.max(0, Math.min(1, fraction))),
  note,
});

export function score(docs, graph, findings) {
  const groupKeys = new Set(graph.group);
  const markets = operatingMarkets(graph);
  const regDocs = docs.filter((d) => d.extraction.doc_type === "registry_profile");
  const groupDocs = regDocs.filter((d) => groupKeys.has(entityKey(d.extraction.company.name || "")));
  const sev = (pillar, ...levels) => findings.filter((f) => f.pillar === pillar && levels.includes(f.severity));
  const n = (list) => Math.max(list.length, 1);
  const checks = [];

  const resolved = graph.subject_resolved_percent;
  checks.push(check("ubo", "Ownership traced to natural persons", 120, resolved / 100,
    `${resolved}% of the holding company resolved to individuals`));
  const offshore = findings.filter((f) => f.title.startsWith("Undisclosed beneficial owners"));
  checks.push(check("ubo", "No undisclosed offshore holders", 60, offshore.length ? 0 : 1,
    offshore.length ? `${offshore.length} opaque offshore holder(s)` : "All corporate holders disclosed"));
  const badSum = findings.filter((f) => f.title.includes("sum to"));
  checks.push(check("ubo", "Share registers reconcile to 100%", 40, 1 - badSum.length / n(regDocs),
    `${regDocs.length - badSum.length} of ${regDocs.length} registers reconcile`));
  const fo = sev("ubo", "high", "medium").filter((f) => !offshore.includes(f) && !badSum.includes(f));
  checks.push(check("ubo", "Foreign ownership & screening rules", 50,
    1 - fo.reduce((a, f) => a + (f.severity === "high" ? 1 : 0.5), 0) / 2,
    fo.map((f) => f.title).join("; ") || "No foreign-ownership or watchlist issues"));
  const withOfficers = groupDocs.filter((d) => d.extraction.officers.length).length;
  checks.push(check("ubo", "Officers on record for every entity", 30, withOfficers / n(groupDocs),
    `${withOfficers} of ${groupDocs.length} entities list directors`));

  const finDocs = docs.map((d) => d.extraction.financials).filter(Boolean);
  const audited = finDocs.filter((f) => f.audited);
  const clean = audited.filter((f) => ["unqualified", "unmodified", "clean"].includes((f.opinion || "").toLowerCase()));
  checks.push(check("financial", "Audited financial statements", 100,
    clean.length ? 1 : audited.length ? 0.5 : finDocs.length ? 0.3 : 0,
    clean.length ? "Unqualified audit opinion" : audited.length ? "Audited, opinion modified"
      : finDocs.length ? "Unaudited statements only" : "No financial statements provided"));
  const years = Math.max(0, ...finDocs.map((f) => (f.years_covered || []).length));
  checks.push(check("financial", "Three-year financial history", 50, years / 3, `${years} of 3 years covered`));
  const capMismatch = findings.filter((f) => f.title.startsWith("Paid-up capital differs"));
  checks.push(check("financial", "Registry capital matches accounts", 70,
    capMismatch.length ? 0 : finDocs.length ? 1 : 0.5,
    capMismatch.length ? "Mismatch found" : finDocs.length ? "Consistent" : "Nothing to compare"));
  const capGaps = sev("financial", "high", "medium").filter((f) => !capMismatch.includes(f));
  checks.push(check("financial", "Capital fully contributed", 40, 1 - 0.5 * capGaps.length,
    capGaps.map((f) => f.title).join("; ") || "No contribution gaps"));
  const taxed = new Set(docs.filter((d) => d.extraction.doc_type === "tax_filing").map((d) => d.extraction.country));
  if (docs.some((d) => d.extraction.doc_type === "financial_statement")) {
    // Audited accounts are filed with the tax authority alongside the return in SG/MY.
    for (const d of docs) if (d.extraction.doc_type === "financial_statement") taxed.add(d.extraction.country);
  }
  const taxedInMarkets = markets.filter((m) => taxed.has(m));
  checks.push(check("financial", "Tax filings on record per market", 40, taxedInMarkets.length / n(markets),
    `${taxedInMarkets.length} of ${markets.length} markets (${taxedInMarkets.sort().join(", ") || "none"})`));

  const comp = docs.map((d) => d.extraction.compliance).find(Boolean) || {};
  const covered = markets.filter((m) => frameworkCoverage(comp.privacy_frameworks || [], m));
  checks.push(check("regulatory", "Privacy law coverage per market", 90, covered.length / n(markets),
    `${covered.length} of ${markets.length} markets covered`));
  const hosting = comp.hosting || {};
  const ok = markets.filter((m) => m in hosting && (!LOCALISATION_REQUIRED[m] || hosting[m] === m));
  checks.push(check("regulatory", "Data residency declared and compliant", 60, ok.length / n(markets),
    `${ok.length} of ${markets.length} markets compliant`));
  checks.push(check("regulatory", "IP assigned to the company", 60, comp.ip_assigned_to_company ? 1 : 0,
    comp.ip_assigned_to_company ? "Deed of assignment on file" : "No IP assignment evidence"));
  checks.push(check("regulatory", "Data protection officer appointed", 40, comp.dpo_appointed ? 1 : 0,
    comp.dpo_appointed ? "DPO appointed" : "No DPO declared"));

  const active = groupDocs.filter((d) => d.extraction.company.status === "active");
  checks.push(check("esg", "All entities active in their registry", 50, active.length / n(groupDocs),
    `${active.length} of ${groupDocs.length} active`));
  const esg = [comp.esg_report, comp.emissions_disclosed].filter(Boolean).length / 2;
  checks.push(check("esg", "ESG report & emissions disclosure", 40, esg,
    esg === 1 ? "Both provided" : esg ? "Partially provided" : "Not provided"));
  const premises = markets.filter((m) => (comp.premises_verified || []).includes(m));
  checks.push(check("esg", "Physical premises verified", 30, premises.length / n(markets),
    `${premises.length} of ${markets.length} markets`));
  const licences = comp.licences || [];
  checks.push(check("esg", "Sector licences on file", 30, licences.length ? 1 : 0,
    licences.length ? `${licences.length} licence(s)` : "None declared"));

  const pillars = Object.entries(PILLARS).map(([key, [label, max]]) => ({
    key, label, max,
    score: checks.filter((c) => c.pillar === key).reduce((a, c) => a + c.score, 0),
  }));
  const total = pillars.reduce((a, p) => a + p.score, 0);
  const [, grade, band] = GRADES.find(([floor]) => total >= floor);
  return { total, max: 1000, grade, band, pillars, checks, markets, entities: graph.group.length };
}
