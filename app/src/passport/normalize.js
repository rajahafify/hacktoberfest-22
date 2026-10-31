// Locale-aware helpers shared by every extraction backend. Port of passport/normalize.py.

const COUNTRY_ALIASES = {
  SG: ["singapore", "singaporean", "singapura", "สิงคโปร์", "xinh-ga-po", "xin-ga-po", "sg"],
  MY: ["malaysia", "malaysian", "มาเลเซีย", "ma-lai-xi-a", "my"],
  ID: ["indonesia", "indonesian", "อินโดนีเซีย", "in-đô-nê-xi-a", "id"],
  TH: ["thailand", "thai", "ไทย", "ประเทศไทย", "thái lan", "th"],
  VN: ["vietnam", "viet nam", "việt nam", "vietnamese", "เวียดนาม", "vn"],
  PH: ["philippines", "filipino", "ph"],
  VG: ["british virgin islands", "bvi", "vg"],
  KY: ["cayman islands", "cayman", "ky"],
};
const ALIAS_TO_CODE = new Map();
for (const [code, aliases] of Object.entries(COUNTRY_ALIASES)) {
  for (const a of aliases) ALIAS_TO_CODE.set(a, code);
}
const BY_LENGTH = [...ALIAS_TO_CODE.entries()].sort((a, b) => b[0].length - a[0].length);

export const OFFSHORE_JURISDICTIONS = new Set(["VG", "KY", "BM", "SC", "PA", "MH", "WS"]);
export const ASEAN = new Set(["SG", "MY", "ID", "TH", "VN", "PH", "BN", "KH", "LA", "MM"]);
export const COUNTRY_NAMES = {
  SG: "Singapore", MY: "Malaysia", ID: "Indonesia", TH: "Thailand",
  VN: "Vietnam", PH: "Philippines", VG: "British Virgin Islands", KY: "Cayman Islands",
};

const CURRENCY_ALIASES = {
  SGD: ["sgd", "s$"], MYR: ["myr", "rm"], IDR: ["idr", "rp"],
  THB: ["thb", "บาท", "฿"], VND: ["vnd", "đồng", "dong", "₫"], USD: ["usd", "us$"],
};
// Rough FX to USD, only used to compare capital figures across documents.
const FX_TO_USD = { SGD: 0.74, MYR: 0.21, IDR: 0.000063, THB: 0.028, VND: 0.000039, USD: 1 };

export function countryCode(value) {
  if (!value) return null;
  const key = value.trim().toLowerCase();
  if (ALIAS_TO_CODE.has(key)) return ALIAS_TO_CODE.get(key);
  for (const [alias, code] of BY_LENGTH) {
    if (alias.length > 3 && key.includes(alias)) return code;
  }
  return value.trim().length === 2 ? value.trim().toUpperCase() : null;
}

export function parseNumber(text) {
  if (text === null || text === undefined) return null;
  if (typeof text === "number") return text;
  let s = String(text).trim();
  const negative = (s.startsWith("(") && s.endsWith(")")) || s.startsWith("-");
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) {
    const decimal = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    s = s.split(thousands).join("").replace(decimal, ".");
  } else if (s.includes(",") || s.includes(".")) {
    const sep = s.includes(",") ? "," : ".";
    const parts = s.split(sep);
    s = parts.length > 2 || (parts.length === 2 && parts[1].length === 3)
      ? parts.join("") : s.replace(sep, ".");
  }
  const value = Number(s);
  if (Number.isNaN(value)) return null;
  return negative ? -value : value;
}

export function parseMoney(text) {
  if (!text) return null;
  const lowered = String(text).toLowerCase();
  let currency = null;
  for (const [code, aliases] of Object.entries(CURRENCY_ALIASES)) {
    if (aliases.some((a) => new RegExp(`(?<![a-zà-ỹ])${escapeRe(a)}(?![a-zà-ỹ])`).test(lowered))) {
      currency = code;
      break;
    }
  }
  const match = String(text).match(/\(?-?\d[\d.,]*\)?/);
  const amount = match ? parseNumber(match[0]) : null;
  return amount === null ? null : { amount, currency };
}

export function toUsd(money) {
  if (!money || money.amount === null || money.amount === undefined || !(money.currency in FX_TO_USD)) return null;
  return money.amount * FX_TO_USD[money.currency];
}

const hasNonLatin = (text) => [...text].some((c) => /\p{L}/u.test(c) && c.codePointAt(0) > 0x24f);

export function splitNativeName(raw) {
  const trimmed = raw.trim();
  const m = trimmed.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (m && hasNonLatin(m[1]) && !hasNonLatin(m[2])) return [m[2].trim(), m[1].trim()];
  return [trimmed, null];
}

const SUFFIXES = [
  [/\bPTE\.?\s*LTD\.?/g, "PTE LTD"], [/\bSDN\.?\s*BHD\.?/g, "SDN BHD"],
  [/\bCO\.?,?\s*LTD\.?/g, "CO LTD"], [/\bLTD\.?/g, "LTD"],
];

export function entityKey(name) {
  if (!name) return "";
  let s = name.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().replace(/Đ/g, "D");
  for (const [re, repl] of SUFFIXES) s = s.replace(re, repl);
  return s.replace(/[^\p{L}\p{N}_\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
