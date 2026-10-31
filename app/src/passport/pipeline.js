// Documents in, passport report out. Port of passport/pipeline.py.
import { mockBackend, normalizeExtraction } from "./backends.js";
import { buildGraph } from "./graph.js";
import { runChecks, score } from "./checks.js";
import { issue, sha256Hex } from "./credential.js";

export async function analyze(documents, backend = mockBackend, today = new Date()) {
  const docs = [];
  const warnings = [];
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    let raw;
    let used = backend.name;
    try {
      raw = await backend.extract(doc.name, doc.text);
    } catch (err) {
      warnings.push(`${doc.name}: ${err.message}. Fell back to the mock extractor.`);
      raw = await mockBackend.extract(doc.name, doc.text);
      used = "mock (fallback)";
    }
    docs.push({
      id: `doc${i + 1}`, name: doc.name, text: doc.text, backend: used,
      sha256: await sha256Hex(doc.text), extraction: normalizeExtraction(raw),
    });
  }

  const registry = docs.filter((d) => d.extraction.doc_type === "registry_profile")
    .map((d) => ({ id: d.id, extraction: d.extraction }));
  const graph = buildGraph(registry);
  const findings = runChecks(docs, graph, today);
  for (const d of docs) {
    for (const note of d.extraction.risk_notes) {
      findings.push({ severity: "low", pillar: "regulatory", title: `Model note on ${d.name}`, detail: note, docs: [d.id] });
    }
  }
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const report = {
    backend: backend.description,
    warnings,
    documents: docs.map(({ text, ...rest }) => rest),
    graph,
    findings,
    score: score(docs, graph, findings),
  };
  report.credential = await issue(report, docs);
  return report;
}
