// Verifiable credential issue/verify with Web Crypto. Port of passport/credential.py.
// HMAC-SHA256 over canonical JSON. Demo key only: production would use Ed25519 and a DID.
const ISSUER = "did:web:passport.example.asean";
const DEMO_KEY = "asean-startup-passport-demo-key-not-for-production";
const enc = new TextEncoder();

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function hmacHex(message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(DEMO_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
}));

export async function issue(report, docs, now = new Date()) {
  const { graph, score } = report;
  const subject = graph.nodes.find((n) => n.id === graph.subject) || {};
  const stamp = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const vc = {
    "@context": ["https://www.w3.org/ns/credentials/v2", "https://passport.example.asean/contexts/v1"],
    id: `urn:uuid:${uuid()}`,
    type: ["VerifiableCredential", "AseanStartupPassport"],
    issuer: { id: ISSUER, name: "ASEAN Startup Passport (demo issuer)" },
    validFrom: stamp(now),
    validUntil: stamp(new Date(now.getTime() + 180 * 86_400_000)),
    credentialSubject: {
      id: `urn:asean:${(subject.jurisdiction || "xx").toLowerCase()}:${subject.registration_no || graph.subject}`,
      legalName: subject.label,
      jurisdiction: subject.jurisdiction,
      registry: subject.registry,
      readinessScore: {
        value: score.total, max: score.max, grade: score.grade, band: score.band,
        pillars: Object.fromEntries(score.pillars.map((p) => [p.key, p.score])),
      },
      verifiedEntities: graph.nodes
        .filter((n) => n.documented && graph.group.includes(n.id))
        .map((n) => ({ name: n.label, jurisdiction: n.jurisdiction, registry: n.registry, registrationNo: n.registration_no })),
      beneficialOwnership: {
        threshold: graph.threshold,
        resolvedPercent: graph.subject_resolved_percent,
        // Only the count is disclosed; names stay with the issuer unless the holder consents.
        uboCount: (graph.ubo[graph.subject] || []).filter((u) => u.is_ubo).length,
      },
      openFindings: Object.fromEntries(["high", "medium", "low"].map((s) =>
        [s, report.findings.filter((f) => f.severity === s).length])),
    },
    evidence: await Promise.all(docs.map(async (d) => ({ type: "DocumentHash", name: d.name, sha256: await sha256Hex(d.text) }))),
  };
  vc.proof = {
    type: "DataIntegrityProof",
    cryptosuite: "hmac-sha256-demo",
    created: vc.validFrom,
    verificationMethod: `${ISSUER}#demo-key`,
    proofPurpose: "assertionMethod",
    proofValue: await hmacHex(canonical(vc)),
  };
  return vc;
}

export async function verify(vc, now = new Date()) {
  if (!vc || typeof vc !== "object" || !vc.proof) return { valid: false, reason: "No proof attached" };
  const { proof, ...body } = vc;
  if ((await hmacHex(canonical(body))) !== String(proof.proofValue)) {
    return { valid: false, reason: "Signature does not match: the credential was altered or issued by someone else" };
  }
  if (body.validUntil && new Date(body.validUntil) < now) {
    return { valid: false, reason: `Credential expired on ${body.validUntil}` };
  }
  return { valid: true, reason: "Signature valid and credential in date" };
}
