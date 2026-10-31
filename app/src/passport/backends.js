// Extraction backends. The static app ships the mock extractor; an OpenAI-compatible
// Gemma endpoint (vLLM, LM Studio, a local gateway) can be used when it allows CORS.
import { extract as mockExtract } from "./mockExtract.js";
import { countryCode, parseMoney, parseNumber, splitNativeName } from "./normalize.js";

export const SCHEMA_SUMMARY = `Return ONLY a JSON object with keys: doc_type (registry_profile | financial_statement |
tax_filing | compliance_declaration | other), country (ISO alpha-2), registry, language, company {name, native_name,
registration_no, incorporation_date (YYYY-MM-DD), status (active|inactive|unknown), foreign_investment, paid_up_capital
{amount,currency}, charter_capital}, officers [{name, kind (person|entity), jurisdiction, role}], shareholders
[{name, kind, jurisdiction, percent}], financials, tax, compliance, summary_en, risk_notes [].
Never invent data; use null or [] when absent. Romanize names in UPPER CASE. Translate roles to English.`;

export const mockBackend = {
  name: "mock",
  description: "Deterministic label-dictionary extractor (no model call)",
  extract: async (filename, text) => mockExtract(filename, text),
};

export function gemmaBackend({ url, model, apiKey } = {}) {
  return {
    name: "gemma",
    description: `Gemma (${model}) via OpenAI-compatible API at ${url}`,
    async extract(filename, text) {
      const res = await fetch(`${url.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: `${SCHEMA_SUMMARY}\n\nDocument file name: ${filename}\n\n<document>\n${text}\n</document>` }],
        }),
      });
      if (!res.ok) throw new Error(`Gemma endpoint returned ${res.status}`);
      const data = await res.json();
      return parseModelJson(data.choices?.[0]?.message?.content ?? "");
    },
  };
}

export function parseModelJson(content) {
  const s = content.trim();
  const fenced = s.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  const body = fenced ? fenced[1] : s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1);
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`Model reply was not valid JSON: ${err.message}`);
  }
}

const money = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    const amount = parseNumber(v.amount);
    return amount === null ? null : { amount, currency: v.currency || null };
  }
  return parseMoney(String(v));
};

function party(p) {
  if (!p || !p.name) return null;
  const [name, native] = splitNativeName(String(p.name));
  return {
    name: name.toUpperCase(),
    native_name: p.native_name || native,
    kind: String(p.kind || "").toLowerCase() === "entity" ? "entity" : "person",
    jurisdiction: p.jurisdiction ? countryCode(p.jurisdiction) : null,
    percent: p.percent !== null && p.percent !== undefined && p.percent !== "" ? parseNumber(String(p.percent).replace("%", "")) : null,
    role: p.role ?? null,
  };
}

export function normalizeExtraction(raw) {
  const c = raw.company || {};
  let fin = raw.financials && typeof raw.financials === "object" ? { ...raw.financials } : null;
  if (fin) {
    for (const k of ["revenue", "net_income", "share_capital"]) fin[k] = money(fin[k]);
    fin.years_covered = (fin.years_covered || []).map(Number).filter(Number.isInteger);
  }
  const hosting = raw.compliance?.hosting && typeof raw.compliance.hosting === "object" ? raw.compliance.hosting : {};
  return {
    doc_type: raw.doc_type || "other",
    country: raw.country ? countryCode(raw.country) : null,
    registry: raw.registry ?? null,
    language: raw.language || "und",
    company: {
      name: (c.name || "").toUpperCase() || null,
      native_name: c.native_name ?? null,
      registration_no: c.registration_no ?? null,
      incorporation_date: c.incorporation_date ?? null,
      status: (c.status || "unknown").toLowerCase(),
      foreign_investment: c.foreign_investment ?? null,
      paid_up_capital: money(c.paid_up_capital),
      charter_capital: money(c.charter_capital),
    },
    officers: (raw.officers || []).map(party).filter(Boolean),
    shareholders: (raw.shareholders || []).map(party).filter(Boolean),
    financials: fin,
    tax: raw.tax && typeof raw.tax === "object" ? raw.tax : null,
    compliance: raw.compliance && typeof raw.compliance === "object" ? {
      ...raw.compliance,
      hosting: Object.fromEntries(Object.entries(hosting).map(([k, v]) => [countryCode(k) || k, countryCode(v) || v])),
      premises_verified: (raw.compliance.premises_verified || []).map((p) => countryCode(p) || p),
    } : null,
    summary_en: raw.summary_en || "",
    risk_notes: (raw.risk_notes || []).map(String),
  };
}
