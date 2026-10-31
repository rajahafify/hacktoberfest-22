"""Issue and verify the Passport as a W3C Verifiable Credential (VC Data Model 2.0 shape).

The proof here is an HMAC-SHA256 over the canonical JSON so the demo runs with
the standard library only. A production issuer would sign with Ed25519
(eddsa-rdfc-2022) or BBS+ for selective disclosure, and publish its key as a DID.
"""

import datetime as dt
import hashlib
import hmac
import json
import os
import uuid

ISSUER = "did:web:passport.example.asean"
_DEMO_KEY = "asean-startup-passport-demo-key-not-for-production"


def _key():
    return os.environ.get("PASSPORT_SIGNING_KEY", _DEMO_KEY).encode()


def _canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def issue(report, docs, now=None):
    now = now or dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    graph, score = report["graph"], report["score"]
    subject = next((n for n in graph["nodes"] if n["id"] == graph["subject"]), None) or {}
    vc = {
        "@context": ["https://www.w3.org/ns/credentials/v2", "https://passport.example.asean/contexts/v1"],
        "id": f"urn:uuid:{uuid.uuid4()}",
        "type": ["VerifiableCredential", "AseanStartupPassport"],
        "issuer": {"id": ISSUER, "name": "ASEAN Startup Passport (demo issuer)"},
        "validFrom": now.isoformat().replace("+00:00", "Z"),
        "validUntil": (now + dt.timedelta(days=180)).isoformat().replace("+00:00", "Z"),
        "credentialSubject": {
            "id": f"urn:asean:{(subject.get('jurisdiction') or 'xx').lower()}:{subject.get('registration_no') or graph['subject']}",
            "legalName": subject.get("label"),
            "jurisdiction": subject.get("jurisdiction"),
            "registry": subject.get("registry"),
            "readinessScore": {"value": score["total"], "max": score["max"], "grade": score["grade"], "band": score["band"],
                               "pillars": {p["key"]: p["score"] for p in score["pillars"]}},
            "verifiedEntities": [
                {"name": n["label"], "jurisdiction": n["jurisdiction"], "registry": n.get("registry"),
                 "registrationNo": n.get("registration_no")}
                for n in graph["nodes"] if n["documented"] and n["id"] in graph["group"]
            ],
            "beneficialOwnership": {
                "threshold": graph["threshold"],
                "resolvedPercent": graph["subject_resolved_percent"],
                # Only the count is disclosed; names stay with the issuer unless the holder consents.
                "uboCount": sum(1 for u in graph["ubo"].get(graph["subject"], []) if u["is_ubo"]),
            },
            "openFindings": {s: sum(1 for f in report["findings"] if f["severity"] == s) for s in ("high", "medium", "low")},
        },
        "evidence": [
            {"type": "DocumentHash", "name": d["name"], "sha256": hashlib.sha256(d["text"].encode()).hexdigest()}
            for d in docs
        ],
    }
    vc["proof"] = {
        "type": "DataIntegrityProof",
        "cryptosuite": "hmac-sha256-demo",
        "created": vc["validFrom"],
        "verificationMethod": f"{ISSUER}#demo-key",
        "proofPurpose": "assertionMethod",
        "proofValue": hmac.new(_key(), _canonical(vc), hashlib.sha256).hexdigest(),
    }
    return vc


def verify(vc, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    if not isinstance(vc, dict) or "proof" not in vc:
        return {"valid": False, "reason": "No proof attached"}
    body = {k: v for k, v in vc.items() if k != "proof"}
    expected = hmac.new(_key(), _canonical(body), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, str(vc["proof"].get("proofValue", ""))):
        return {"valid": False, "reason": "Signature does not match: the credential was altered or issued by someone else"}
    until = vc.get("validUntil")
    if until and dt.datetime.fromisoformat(until.replace("Z", "+00:00")) < now:
        return {"valid": False, "reason": f"Credential expired on {until}"}
    return {"valid": True, "reason": "Signature valid and credential in date"}
