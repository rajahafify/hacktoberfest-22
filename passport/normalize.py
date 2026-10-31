"""Locale-aware helpers shared by every extraction backend.

Whatever the model returns (mock or Gemma), it is run through these helpers so
the downstream graph, cross-checks and scoring only ever see normalized data.
"""

import re
import unicodedata

# ISO 3166 alpha-2 codes keyed by the spellings found in ASEAN registry
# documents (English, Bahasa Melayu/Indonesia, Thai, Vietnamese).
COUNTRY_ALIASES = {
    "SG": ["singapore", "singaporean", "singapura", "สิงคโปร์", "xinh-ga-po", "xin-ga-po", "sg"],
    "MY": ["malaysia", "malaysian", "มาเลเซีย", "ma-lai-xi-a", "my"],
    "ID": ["indonesia", "indonesian", "อินโดนีเซีย", "in-đô-nê-xi-a", "id"],
    "TH": ["thailand", "thai", "ไทย", "ประเทศไทย", "thái lan", "th"],
    "VN": ["vietnam", "viet nam", "việt nam", "vietnamese", "เวียดนาม", "vn"],
    "PH": ["philippines", "filipino", "ph"],
    "VG": ["british virgin islands", "bvi", "vg"],
    "KY": ["cayman islands", "cayman", "ky"],
}
_ALIAS_TO_CODE = {alias: code for code, aliases in COUNTRY_ALIASES.items() for alias in aliases}

OFFSHORE_JURISDICTIONS = {"VG", "KY", "BM", "SC", "PA", "MH", "WS"}
ASEAN = {"SG", "MY", "ID", "TH", "VN", "PH", "BN", "KH", "LA", "MM"}

COUNTRY_NAMES = {
    "SG": "Singapore", "MY": "Malaysia", "ID": "Indonesia", "TH": "Thailand",
    "VN": "Vietnam", "PH": "Philippines", "VG": "British Virgin Islands", "KY": "Cayman Islands",
}

CURRENCY_ALIASES = {
    "SGD": ["sgd", "s$"], "MYR": ["myr", "rm"], "IDR": ["idr", "rp"],
    "THB": ["thb", "บาท", "฿"], "VND": ["vnd", "đồng", "dong", "₫"], "USD": ["usd", "us$"],
}

# Rough FX to USD, only used to compare capital figures across documents.
FX_TO_USD = {"SGD": 0.74, "MYR": 0.21, "IDR": 0.000063, "THB": 0.028, "VND": 0.000039, "USD": 1.0}


def country_code(value):
    """Map a nationality/jurisdiction string in any supported language to ISO alpha-2."""
    if not value:
        return None
    key = value.strip().lower()
    if key in _ALIAS_TO_CODE:
        return _ALIAS_TO_CODE[key]
    for alias, code in sorted(_ALIAS_TO_CODE.items(), key=lambda kv: -len(kv[0])):
        if len(alias) > 3 and alias in key:
            return code
    return value.strip().upper() if len(value.strip()) == 2 else None


def parse_number(text):
    """Parse '1,200,000.00', '10.050.000.000', '95,00' or '(640,000)' into a float."""
    if text is None:
        return None
    if isinstance(text, (int, float)):
        return float(text)
    s = str(text).strip()
    negative = s.startswith("(") and s.endswith(")") or s.startswith("-")
    s = re.sub(r"[^\d.,]", "", s)
    if not s:
        return None
    if "," in s and "." in s:
        decimal = "," if s.rfind(",") > s.rfind(".") else "."
        thousands = "." if decimal == "," else ","
        s = s.replace(thousands, "").replace(decimal, ".")
    elif "," in s or "." in s:
        sep = "," if "," in s else "."
        parts = s.split(sep)
        if len(parts) > 2 or (len(parts) == 2 and len(parts[1]) == 3):
            s = s.replace(sep, "")
        else:
            s = s.replace(sep, ".")
    value = float(s)
    return -value if negative else value


def parse_money(text):
    """Return {'amount': float, 'currency': 'SGD'} from a localized money string."""
    if not text:
        return None
    lowered = str(text).lower()
    currency = None
    for code, aliases in CURRENCY_ALIASES.items():
        if any(re.search(r"(?<![a-zà-ỹ])" + re.escape(a) + r"(?![a-zà-ỹ])", lowered) for a in aliases):
            currency = code
            break
    match = re.search(r"\(?-?[\d][\d.,]*\)?", str(text))
    amount = parse_number(match.group(0)) if match else None
    if amount is None:
        return None
    return {"amount": amount, "currency": currency}


def to_usd(money):
    if not money or money.get("amount") is None or money.get("currency") not in FX_TO_USD:
        return None
    return money["amount"] * FX_TO_USD[money["currency"]]


def has_non_latin(text):
    return any(unicodedata.category(c).startswith("L") and ord(c) > 0x24F for c in text)


def split_native_name(raw):
    """'นายสมชาย ใจดี (SOMCHAI JAIDEE)' -> ('SOMCHAI JAIDEE', 'นายสมชาย ใจดี')."""
    raw = raw.strip()
    m = re.match(r"^(.*?)\s*\(([^()]*)\)\s*$", raw)
    if m and has_non_latin(m.group(1)) and not has_non_latin(m.group(2)):
        return m.group(2).strip(), m.group(1).strip()
    return raw, None


_SUFFIXES = [
    (r"\bPTE\.?\s*LTD\.?", "PTE LTD"), (r"\bSDN\.?\s*BHD\.?", "SDN BHD"),
    (r"\bCO\.?,?\s*LTD\.?", "CO LTD"), (r"\bLTD\.?", "LTD"),
]


def entity_key(name):
    """Stable key for matching the same party across documents and languages."""
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c)).upper()
    s = s.replace("Đ", "D")
    for pattern, repl in _SUFFIXES:
        s = re.sub(pattern, repl, s)
    s = re.sub(r"[^\w\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()
