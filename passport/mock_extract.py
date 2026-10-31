"""Deterministic stand-in for Gemma, used when no model endpoint is configured.

It knows the field labels each ASEAN registry prints (in English, Malay,
Indonesian, Thai and Vietnamese) and reads "Label: value" lines and pipe
tables. It produces exactly the same JSON shape Gemma is asked for, so the
rest of the pipeline cannot tell the two apart.
"""

import re

from .normalize import country_code, parse_money, parse_number, split_native_name

LABELS = {
    "name_en": ["name of company", "nama syarikat", "nama perseroan", "nama wajib pajak",
                "ชื่อภาษาอังกฤษ", "tên công ty viết bằng tiếng nước ngoài", "company"],
    "name_native": ["ชื่อบริษัท", "tên công ty"],
    "registration_no": ["uen", "no. pendaftaran", "nomor sk menkumham", "เลขทะเบียนนิติบุคคล",
                        "mã số doanh nghiệp", "company number"],
    "incorporation_date": ["incorporation date", "tarikh diperbadankan", "tanggal akta pendirian",
                           "วันที่จดทะเบียน", "đăng ký lần đầu"],
    "status": ["status", "status perseroan", "สถานะ", "tình trạng"],
    "paid_up_capital": ["paid-up capital", "modal berbayar", "modal disetor", "ทุนชำระแล้ว", "vốn đã góp"],
    "charter_capital": ["vốn điều lệ"],
    "investment_status": ["status penanaman modal"],
    "doc_kind": ["document type", "jenis dokumen"],
}

ACTIVE_WORDS = ["live", "wujud", "existing", "aktif", "active", "ยังดำเนินกิจการอยู่", "đang hoạt động"]

COL_NAME = ["name", "nama", "ชื่อ", "tên", "họ và tên"]
COL_TYPE = ["type", "jenis", "ประเภท", "loại"]
COL_JURIS = ["jurisdiction", "negara", "สัญชาติ", "quốc gia", "nationality", "kewarganegaraan", "quốc tịch"]
COL_PERCENT = ["percentage", "peratus", "persentase", "ร้อยละ", "tỷ lệ"]
COL_ROLE = ["position", "jawatan", "jabatan", "ตำแหน่ง", "chức danh"]

ENTITY_WORDS = ["corporate", "syarikat", "badan hukum", "นิติบุคคล", "tổ chức", "company"]

ROLE_EN = {
    "pengarah": "Director", "direktur utama": "President Director", "direktur": "Director",
    "komisaris": "Commissioner", "กรรมการผู้มีอำนาจลงนาม": "Authorised Signatory Director",
    "กรรมการ": "Director", "giám đốc": "Director", "director": "Director", "secretary": "Secretary",
}

# (text cue, country, registry, default doc type) checked in order.
REGISTRY_CUES = [
    ("DIREKTORAT JENDERAL PAJAK", "ID", "DJP", "tax_filing"),
    ("BENEFICIAL OWNERSHIP SECURE SEARCH", "VG", "BVI BOSS", "registry_profile"),
    ("ACRA", "SG", "ACRA", "registry_profile"),
    ("SURUHANJAYA SYARIKAT MALAYSIA", "MY", "SSM", "registry_profile"),
    ("(AHU)", "ID", "AHU", "registry_profile"),
    ("กรมพัฒนาธุรกิจการค้า", "TH", "DBD", "registry_profile"),
    ("ĐĂNG KÝ DOANH NGHIỆP", "VN", "DPI", "registry_profile"),
    ("UEN", "SG", None, None),
]


def _lang(text):
    if re.search(r"[฀-๿]", text):
        return "th"
    if re.search(r"[ăơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđ]", text.lower()):
        return "vi"
    low = text.lower()
    if re.search(r"\b(syarikat|pengarah|jawatan|berbayar)\b", low):
        return "ms"
    if re.search(r"\b(perseroan|pemegang saham|wajib pajak|disetor)\b", low):
        return "id"
    return "en"


def _iso_date(value):
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", value or "")
    return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}" if m else None


def _split_list(value):
    return [v.strip() for v in re.split(r",\s*", value or "") if v.strip()]


def _yes(value):
    return bool(value) and value.strip().lower().startswith(("yes", "ya", "appointed", "ใช่", "có"))


def _parse(text):
    kv, tables = {}, []
    lines = [l.rstrip() for l in text.splitlines()]
    heading, i = None, 0
    while i < len(lines):
        line = lines[i].strip()
        if "|" in line:
            header = [c.strip() for c in line.split("|")]
            rows = []
            i += 1
            while i < len(lines) and "|" in lines[i]:
                rows.append([c.strip() for c in lines[i].split("|")])
                i += 1
            tables.append({"heading": heading or "", "header": header, "rows": rows})
            continue
        if ":" in line:
            label, value = line.split(":", 1)
            kv.setdefault(label.strip().lower(), value.strip())
        elif line:
            heading = line
        i += 1
    return kv, tables


def _get(kv, field):
    for label in LABELS[field]:
        if label in kv:
            return kv[label]
    return None


def _col(header, names):
    for idx, h in enumerate(header):
        if h.lower() in names:
            return idx
    return None


def _party(row, header, default_kind):
    name_idx = _col(header, COL_NAME) or 0
    name, native = split_native_name(row[name_idx])
    type_idx, juris_idx = _col(header, COL_TYPE), _col(header, COL_JURIS)
    pct_idx, role_idx = _col(header, COL_PERCENT), _col(header, COL_ROLE)
    kind = default_kind
    if type_idx is not None:
        kind = "entity" if any(w in row[type_idx].lower() for w in ENTITY_WORDS) else "person"
    role = None
    if role_idx is not None:
        raw = row[role_idx].strip()
        role = next((en for k, en in ROLE_EN.items() if raw.lower() == k), None) or raw
    return {
        "name": name.upper(), "native_name": native, "kind": kind,
        "jurisdiction": country_code(row[juris_idx]) if juris_idx is not None else None,
        "percent": parse_number(row[pct_idx]) if pct_idx is not None else None,
        "role": role,
    }


def _financials(kv, tables):
    if "auditor" not in kv and "financial year end" not in kv:
        return None
    currency = kv.get("currency")
    out = {
        "fiscal_year_end": _iso_date(kv.get("financial year end")),
        "years_covered": [int(y) for y in re.findall(r"\d{4}", kv.get("years covered", ""))],
        "audited": bool(kv.get("auditor")),
        "auditor": kv.get("auditor"),
        "opinion": kv.get("audit opinion"),
        "revenue": None, "net_income": None, "share_capital": None,
    }
    targets = {"revenue": "revenue", "net profit/(loss)": "net_income", "share capital": "share_capital"}
    for table in tables:
        for row in table["rows"]:
            key = targets.get(row[0].lower())
            if key and len(row) > 1:
                out[key] = {"amount": parse_number(row[1]), "currency": currency}
    return out


def _tax(kv):
    tax_id = kv.get("npwp") or kv.get("tax reference")
    if not tax_id:
        return None
    year = kv.get("tahun pajak")
    filed_date = _iso_date(kv.get("tanggal penyampaian"))
    return {"tax_id": tax_id, "tax_year": int(year) if year else None,
            "filed": filed_date is not None, "filed_date": filed_date}


def _compliance(kv):
    if "privacy frameworks" not in kv and "ip assignment" not in kv:
        return None
    hosting = {}
    for pair in _split_list(kv.get("hosting regions")):
        if "=" in pair:
            market, where = pair.split("=", 1)
            hosting[market.strip().upper()] = country_code(where) or where.strip()
    return {
        "privacy_frameworks": _split_list(kv.get("privacy frameworks")),
        "dpo_appointed": _yes(kv.get("data protection officer")),
        "hosting": hosting,
        "ip_assigned_to_company": "assigned to" in (kv.get("ip assignment") or "").lower(),
        "trademarks": _split_list(kv.get("registered trademarks")),
        "esg_report": _yes(kv.get("esg report")),
        "emissions_disclosed": _yes(kv.get("scope 1-2 emissions disclosed")),
        "licences": _split_list(kv.get("licences")),
        "premises_verified": _split_list(kv.get("physical premises verified")),
    }


def extract(filename, text):
    kv, tables = _parse(text)
    country = registry = doc_type = None
    for cue, c, r, d in REGISTRY_CUES:
        if cue in text:
            country, registry, doc_type = c, r, d
            break

    kind = (_get(kv, "doc_kind") or "").lower()
    if "financial" in kind:
        doc_type = "financial_statement"
    elif "spt" in kind or "tax" in kind:
        doc_type = "tax_filing"
    elif "compliance" in kind:
        doc_type = "compliance_declaration"
    doc_type = doc_type or "other"

    name_en, name_native = _get(kv, "name_en"), _get(kv, "name_native")
    status_raw = (_get(kv, "status") or "").lower()
    investment = _get(kv, "investment_status") or ""
    company = {
        "name": (name_en or name_native or "").upper() or None,
        "native_name": name_native if name_en and name_native else None,
        "registration_no": _get(kv, "registration_no"),
        "incorporation_date": _iso_date(_get(kv, "incorporation_date")),
        "status": ("active" if any(w in status_raw for w in ACTIVE_WORDS) else "inactive") if status_raw else "unknown",
        "foreign_investment": True if "PMA" in investment else None,
        "paid_up_capital": parse_money(_get(kv, "paid_up_capital")),
        "charter_capital": parse_money(_get(kv, "charter_capital")),
    }
    if not company["name"]:
        # Financial statements lead with "COMPANY NAME (UEN ...)" rather than a label.
        first = next((l.strip() for l in text.splitlines() if l.strip()), "")
        company["name"] = re.sub(r"\s*\(.*$", "", first).upper() or None
        m = re.search(r"UEN\s+(\w+)", first)
        company["registration_no"] = company["registration_no"] or (m.group(1) if m else None)

    officers, shareholders = [], []
    for table in tables:
        header = [h.lower() for h in table["header"]]
        if _col(header, COL_PERCENT) is not None:
            shareholders += [_party(r, header, "person") for r in table["rows"]]
        elif _col(header, COL_ROLE) is not None:
            officers += [_party(r, header, "person") for r in table["rows"]]

    result = {
        "doc_type": doc_type, "country": country, "registry": registry, "language": _lang(text),
        "company": company, "officers": officers, "shareholders": shareholders,
        "financials": _financials(kv, tables), "tax": _tax(kv), "compliance": _compliance(kv),
        "risk_notes": [],
    }
    result["summary_en"] = _summary(result)
    return result


def _summary(r):
    c = r["company"]
    name = c.get("name") or "Unknown entity"
    if r["doc_type"] == "registry_profile":
        owners = ", ".join(f"{s['name']} ({s['percent']:g}%)" for s in r["shareholders"] if s.get("percent") is not None)
        cap = c.get("paid_up_capital")
        cap_s = f" Paid-up capital {cap['currency']} {cap['amount']:,.0f}." if cap else ""
        return f"{r['registry'] or 'Registry'} profile for {name} ({c.get('status')}).{cap_s} Shareholders: {owners or 'not listed'}."
    if r["doc_type"] == "financial_statement" and r["financials"]:
        f = r["financials"]
        rev = f.get("revenue") or {}
        return (f"Financial statements for {name}, FY ending {f.get('fiscal_year_end')}, audited by "
                f"{f.get('auditor') or 'n/a'} ({f.get('opinion') or 'no opinion stated'}). "
                f"Revenue {rev.get('currency', '')} {rev.get('amount') or 0:,.0f}.")
    if r["doc_type"] == "tax_filing" and r["tax"]:
        t = r["tax"]
        return f"Corporate income tax return for {name}, tax year {t.get('tax_year')}, filed {t.get('filed_date')}."
    if r["doc_type"] == "compliance_declaration" and r["compliance"]:
        cp = r["compliance"]
        return (f"Self-declared compliance posture for {name}: privacy frameworks {', '.join(cp['privacy_frameworks']) or 'none'}; "
                f"IP {'is' if cp['ip_assigned_to_company'] else 'is not'} assigned to the company.")
    return f"Document about {name}; no structured fields recognised."
