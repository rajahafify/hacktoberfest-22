// Deterministic stand-in for Gemma. Port of passport/mock_extract.py.
// Reads "Label: value" lines and pipe tables in the labels each registry prints.
import { countryCode, parseMoney, parseNumber, splitNativeName } from "./normalize.js";

const LABELS = {
  name_en: ["name of company", "nama syarikat", "nama perseroan", "nama wajib pajak",
    "ชื่อภาษาอังกฤษ", "tên công ty viết bằng tiếng nước ngoài", "company"],
  name_native: ["ชื่อบริษัท", "tên công ty"],
  registration_no: ["uen", "no. pendaftaran", "nomor sk menkumham", "เลขทะเบียนนิติบุคคล",
    "mã số doanh nghiệp", "company number"],
  incorporation_date: ["incorporation date", "tarikh diperbadankan", "tanggal akta pendirian",
    "วันที่จดทะเบียน", "đăng ký lần đầu"],
  status: ["status", "status perseroan", "สถานะ", "tình trạng"],
  paid_up_capital: ["paid-up capital", "modal berbayar", "modal disetor", "ทุนชำระแล้ว", "vốn đã góp"],
  charter_capital: ["vốn điều lệ"],
  investment_status: ["status penanaman modal"],
  doc_kind: ["document type", "jenis dokumen"],
};
const ACTIVE_WORDS = ["live", "wujud", "existing", "aktif", "active", "ยังดำเนินกิจการอยู่", "đang hoạt động"];
const COL_NAME = ["name", "nama", "ชื่อ", "tên", "họ và tên"];
const COL_TYPE = ["type", "jenis", "ประเภท", "loại"];
const COL_JURIS = ["jurisdiction", "negara", "สัญชาติ", "quốc gia", "nationality", "kewarganegaraan", "quốc tịch"];
const COL_PERCENT = ["percentage", "peratus", "persentase", "ร้อยละ", "tỷ lệ"];
const COL_ROLE = ["position", "jawatan", "jabatan", "ตำแหน่ง", "chức danh"];
const ENTITY_WORDS = ["corporate", "syarikat", "badan hukum", "นิติบุคคล", "tổ chức", "company"];
const ROLE_EN = {
  pengarah: "Director", "direktur utama": "President Director", direktur: "Director",
  komisaris: "Commissioner", กรรมการผู้มีอำนาจลงนาม: "Authorised Signatory Director",
  กรรมการ: "Director", "giám đốc": "Director", director: "Director", secretary: "Secretary",
};
const REGISTRY_CUES = [
  ["DIREKTORAT JENDERAL PAJAK", "ID", "DJP", "tax_filing"],
  ["BENEFICIAL OWNERSHIP SECURE SEARCH", "VG", "BVI BOSS", "registry_profile"],
  ["ACRA", "SG", "ACRA", "registry_profile"],
  ["SURUHANJAYA SYARIKAT MALAYSIA", "MY", "SSM", "registry_profile"],
  ["(AHU)", "ID", "AHU", "registry_profile"],
  ["กรมพัฒนาธุรกิจการค้า", "TH", "DBD", "registry_profile"],
  ["ĐĂNG KÝ DOANH NGHIỆP", "VN", "DPI", "registry_profile"],
  ["UEN", "SG", null, null],
];

function detectLanguage(text) {
  if (/[฀-๿]/.test(text)) return "th";
  if (/[ăơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđ]/.test(text.toLowerCase())) return "vi";
  const low = text.toLowerCase();
  if (/\b(syarikat|pengarah|jawatan|berbayar)\b/.test(low)) return "ms";
  if (/\b(perseroan|pemegang saham|wajib pajak|disetor)\b/.test(low)) return "id";
  return "en";
}

function isoDate(value) {
  const m = (value || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

const splitList = (value) => (value || "").split(/,\s*/).map((v) => v.trim()).filter(Boolean);
const yes = (value) => !!value && /^(yes|ya|appointed|ใช่|có)/i.test(value.trim());

function parse(text) {
  const kv = new Map();
  const tables = [];
  const lines = text.split("\n").map((l) => l.trimEnd());
  let heading = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes("|")) {
      const header = line.split("|").map((c) => c.trim());
      const rows = [];
      i++;
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(lines[i].split("|").map((c) => c.trim()));
        i++;
      }
      tables.push({ heading, header, rows });
      continue;
    }
    if (line.includes(":")) {
      const idx = line.indexOf(":");
      const label = line.slice(0, idx).trim().toLowerCase();
      if (!kv.has(label)) kv.set(label, line.slice(idx + 1).trim());
    } else if (line) {
      heading = line;
    }
    i++;
  }
  return { kv, tables };
}

const get = (kv, field) => {
  for (const label of LABELS[field]) if (kv.has(label)) return kv.get(label);
  return null;
};

function col(header, names) {
  const idx = header.findIndex((h) => names.includes(h.toLowerCase()));
  return idx === -1 ? null : idx;
}

function party(row, header, defaultKind) {
  const nameIdx = col(header, COL_NAME) ?? 0;
  const [name, native] = splitNativeName(row[nameIdx]);
  const typeIdx = col(header, COL_TYPE);
  const jurisIdx = col(header, COL_JURIS);
  const pctIdx = col(header, COL_PERCENT);
  const roleIdx = col(header, COL_ROLE);
  let kind = defaultKind;
  if (typeIdx !== null) {
    kind = ENTITY_WORDS.some((w) => row[typeIdx].toLowerCase().includes(w)) ? "entity" : "person";
  }
  let role = null;
  if (roleIdx !== null) {
    const raw = row[roleIdx].trim();
    role = ROLE_EN[raw.toLowerCase()] ?? raw;
  }
  return {
    name: name.toUpperCase(),
    native_name: native,
    kind,
    jurisdiction: jurisIdx !== null ? countryCode(row[jurisIdx]) : null,
    percent: pctIdx !== null ? parseNumber(row[pctIdx]) : null,
    role,
  };
}

function financials(kv, tables) {
  if (!kv.has("auditor") && !kv.has("financial year end")) return null;
  const currency = kv.get("currency") ?? null;
  const out = {
    fiscal_year_end: isoDate(kv.get("financial year end")),
    years_covered: (kv.get("years covered") || "").match(/\d{4}/g)?.map(Number) ?? [],
    audited: !!kv.get("auditor"),
    auditor: kv.get("auditor") ?? null,
    opinion: kv.get("audit opinion") ?? null,
    revenue: null, net_income: null, share_capital: null,
  };
  const targets = { revenue: "revenue", "net profit/(loss)": "net_income", "share capital": "share_capital" };
  for (const table of tables) {
    for (const row of table.rows) {
      const key = targets[row[0].toLowerCase()];
      if (key && row.length > 1) out[key] = { amount: parseNumber(row[1]), currency };
    }
  }
  return out;
}

function tax(kv) {
  const taxId = kv.get("npwp") || kv.get("tax reference");
  if (!taxId) return null;
  const year = kv.get("tahun pajak");
  const filedDate = isoDate(kv.get("tanggal penyampaian"));
  return { tax_id: taxId, tax_year: year ? Number(year) : null, filed: filedDate !== null, filed_date: filedDate };
}

function compliance(kv) {
  if (!kv.has("privacy frameworks") && !kv.has("ip assignment")) return null;
  const hosting = {};
  for (const pair of splitList(kv.get("hosting regions"))) {
    if (pair.includes("=")) {
      const [market, where] = pair.split("=", 2);
      hosting[market.trim().toUpperCase()] = countryCode(where) || where.trim();
    }
  }
  return {
    privacy_frameworks: splitList(kv.get("privacy frameworks")),
    dpo_appointed: yes(kv.get("data protection officer")),
    hosting,
    ip_assigned_to_company: (kv.get("ip assignment") || "").toLowerCase().includes("assigned to"),
    trademarks: splitList(kv.get("registered trademarks")),
    esg_report: yes(kv.get("esg report")),
    emissions_disclosed: yes(kv.get("scope 1-2 emissions disclosed")),
    licences: splitList(kv.get("licences")),
    premises_verified: splitList(kv.get("physical premises verified")),
  };
}

export function extract(filename, text) {
  const { kv, tables } = parse(text);
  let country = null, registry = null, docType = null;
  for (const [cue, c, r, d] of REGISTRY_CUES) {
    if (text.includes(cue)) { country = c; registry = r; docType = d; break; }
  }
  const kind = (get(kv, "doc_kind") || "").toLowerCase();
  if (kind.includes("financial")) docType = "financial_statement";
  else if (kind.includes("spt") || kind.includes("tax")) docType = "tax_filing";
  else if (kind.includes("compliance")) docType = "compliance_declaration";
  docType = docType || "other";

  const nameEn = get(kv, "name_en");
  const nameNative = get(kv, "name_native");
  const statusRaw = (get(kv, "status") || "").toLowerCase();
  const investment = get(kv, "investment_status") || "";
  const company = {
    name: (nameEn || nameNative || "").toUpperCase() || null,
    native_name: nameEn && nameNative ? nameNative : null,
    registration_no: get(kv, "registration_no"),
    incorporation_date: isoDate(get(kv, "incorporation_date")),
    status: statusRaw ? (ACTIVE_WORDS.some((w) => statusRaw.includes(w)) ? "active" : "inactive") : "unknown",
    foreign_investment: investment.includes("PMA") ? true : null,
    paid_up_capital: parseMoney(get(kv, "paid_up_capital")),
    charter_capital: parseMoney(get(kv, "charter_capital")),
  };
  if (!company.name) {
    // Financial statements lead with "COMPANY NAME (UEN ...)" rather than a label.
    const first = text.split("\n").map((l) => l.trim()).find(Boolean) || "";
    company.name = first.replace(/\s*\(.*$/, "").toUpperCase() || null;
    const m = first.match(/UEN\s+(\w+)/);
    company.registration_no = company.registration_no || (m ? m[1] : null);
  }

  const officers = [], shareholders = [];
  for (const table of tables) {
    const header = table.header.map((h) => h.toLowerCase());
    if (col(header, COL_PERCENT) !== null) shareholders.push(...table.rows.map((r) => party(r, header, "person")));
    else if (col(header, COL_ROLE) !== null) officers.push(...table.rows.map((r) => party(r, header, "person")));
  }

  const result = {
    doc_type: docType, country, registry, language: detectLanguage(text),
    company, officers, shareholders,
    financials: financials(kv, tables), tax: tax(kv), compliance: compliance(kv),
    risk_notes: [],
  };
  result.summary_en = summary(result);
  return result;
}

function summary(r) {
  const c = r.company;
  const name = c.name || "Unknown entity";
  if (r.doc_type === "registry_profile") {
    const owners = r.shareholders.filter((s) => s.percent !== null)
      .map((s) => `${s.name} (${s.percent}%)`).join(", ");
    const cap = c.paid_up_capital;
    const capS = cap ? ` Paid-up capital ${cap.currency} ${Math.round(cap.amount).toLocaleString("en-US")}.` : "";
    return `${r.registry || "Registry"} profile for ${name} (${c.status}).${capS} Shareholders: ${owners || "not listed"}.`;
  }
  if (r.doc_type === "financial_statement" && r.financials) {
    const f = r.financials;
    const rev = f.revenue || {};
    return `Financial statements for ${name}, FY ending ${f.fiscal_year_end}, audited by ${f.auditor || "n/a"} (${f.opinion || "no opinion stated"}). Revenue ${rev.currency || ""} ${Math.round(rev.amount || 0).toLocaleString("en-US")}.`;
  }
  if (r.doc_type === "tax_filing" && r.tax) {
    return `Corporate income tax return for ${name}, tax year ${r.tax.tax_year}, filed ${r.tax.filed_date}.`;
  }
  if (r.doc_type === "compliance_declaration" && r.compliance) {
    const cp = r.compliance;
    return `Self-declared compliance posture for ${name}: privacy frameworks ${cp.privacy_frameworks.join(", ") || "none"}; IP ${cp.ip_assigned_to_company ? "is" : "is not"} assigned to the company.`;
  }
  return `Document about ${name}; no structured fields recognised.`;
}
