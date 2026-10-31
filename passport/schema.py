"""The structured-output contract every extraction backend must satisfy."""

DOC_TYPES = [
    "registry_profile",       # ACRA bizfile, SSM s14/17, AHU profile, DBD BorOrJor.5, VN ERC, BVI extract
    "financial_statement",    # audited P&L / balance sheet
    "tax_filing",             # SPT, Form C-S, e-filing receipts
    "compliance_declaration", # data protection, IP assignment, ESG, licences
    "other",
]

_party = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "Romanized name in upper case"},
        "native_name": {"type": ["string", "null"], "description": "Name in original script if not Latin"},
        "kind": {"type": "string", "enum": ["person", "entity"]},
        "jurisdiction": {"type": ["string", "null"], "description": "ISO 3166 alpha-2 nationality or place of incorporation"},
        "percent": {"type": ["number", "null"]},
        "role": {"type": ["string", "null"], "description": "Role translated to English, e.g. Director"},
    },
    "required": ["name", "kind"],
}

_money = {
    "type": ["object", "null"],
    "properties": {"amount": {"type": "number"}, "currency": {"type": "string"}},
}

EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "doc_type": {"type": "string", "enum": DOC_TYPES},
        "country": {"type": ["string", "null"], "description": "ISO alpha-2 of the issuing authority"},
        "registry": {"type": ["string", "null"], "description": "ACRA, SSM, AHU, DBD, DPI, BVI BOSS, DJP, ..."},
        "language": {"type": "string", "description": "BCP-47 code of the main document language"},
        "company": {
            "type": "object",
            "properties": {
                "name": {"type": ["string", "null"]},
                "native_name": {"type": ["string", "null"]},
                "registration_no": {"type": ["string", "null"]},
                "incorporation_date": {"type": ["string", "null"], "description": "YYYY-MM-DD"},
                "status": {"type": ["string", "null"], "description": "active | inactive | unknown"},
                "foreign_investment": {"type": ["boolean", "null"], "description": "True for PMA / FDI entities"},
                "paid_up_capital": _money,
                "charter_capital": _money,
            },
        },
        "officers": {"type": "array", "items": _party},
        "shareholders": {"type": "array", "items": _party},
        "financials": {
            "type": ["object", "null"],
            "properties": {
                "fiscal_year_end": {"type": ["string", "null"]},
                "years_covered": {"type": "array", "items": {"type": "integer"}},
                "audited": {"type": ["boolean", "null"]},
                "auditor": {"type": ["string", "null"]},
                "opinion": {"type": ["string", "null"]},
                "revenue": _money,
                "net_income": _money,
                "share_capital": _money,
            },
        },
        "tax": {
            "type": ["object", "null"],
            "properties": {
                "tax_id": {"type": ["string", "null"]},
                "tax_year": {"type": ["integer", "null"]},
                "filed": {"type": ["boolean", "null"]},
                "filed_date": {"type": ["string", "null"]},
            },
        },
        "compliance": {
            "type": ["object", "null"],
            "properties": {
                "privacy_frameworks": {"type": "array", "items": {"type": "string"}},
                "dpo_appointed": {"type": ["boolean", "null"]},
                "hosting": {"type": "object", "description": "Map of market ISO code -> hosting country ISO code"},
                "ip_assigned_to_company": {"type": ["boolean", "null"]},
                "trademarks": {"type": "array", "items": {"type": "string"}},
                "esg_report": {"type": ["boolean", "null"]},
                "emissions_disclosed": {"type": ["boolean", "null"]},
                "licences": {"type": "array", "items": {"type": "string"}},
                "premises_verified": {"type": "array", "items": {"type": "string"}},
            },
        },
        "summary_en": {"type": "string", "description": "Two-sentence English due-diligence summary"},
        "risk_notes": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["doc_type", "company", "officers", "shareholders", "summary_en"],
}

SYSTEM_PROMPT = """You are a multilingual corporate due-diligence analyst for ASEAN eKYB.
You read registry extracts, financial statements, tax filings and compliance
declarations written in English, Bahasa Melayu, Bahasa Indonesia, Thai or
Vietnamese, and return ONLY a JSON object matching the provided schema.

Rules:
- Never invent data. Use null or [] when a field is absent from the document.
- Romanize names in UPPER CASE; put the original script in native_name.
- Translate roles to English (Pengarah -> Director, Komisaris -> Commissioner,
  กรรมการ -> Director, Giám đốc -> Director).
- kind is "person" for natural persons (Individual, Perorangan, บุคคลธรรมดา,
  Cá nhân) and "entity" for companies (Corporate, Syarikat, Badan Hukum,
  นิติบุคคล, Tổ chức).
- Percentages are numbers 0-100. Money is {amount, currency ISO 4217}.
  Read locale separators correctly: "10.050.000.000" is ten billion,
  "95,00%" is 95.
- Dates are YYYY-MM-DD.
- risk_notes lists anything a compliance reviewer should look at."""


def user_prompt(filename, text):
    return f"Document file name: {filename}\n\n<document>\n{text}\n</document>\n\nReturn the JSON object now."
