const FLAGS = { SG: "🇸🇬", MY: "🇲🇾", ID: "🇮🇩", TH: "🇹🇭", VN: "🇻🇳", PH: "🇵🇭", VG: "🇻🇬", KY: "🇰🇾" };
const LANGS = { en: "English", ms: "Bahasa Melayu", id: "Bahasa Indonesia", th: "ไทย Thai", vi: "Tiếng Việt" };
const DOC_TYPES = { registry_profile: "Registry", financial_statement: "Financials", tax_filing: "Tax filing",
                    compliance_declaration: "Compliance", other: "Other" };
// Left out of the first run so the demo can show the score jump once the offshore UBO is disclosed.
const HELD_BACK = ["09_bvi_lumen_ventures_ubo_declaration.txt"];

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const flag = (c) => FLAGS[c] || "🏳️";

let documents = [];
let credential = null;

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function renderDocList() {
  $("#doc-list").innerHTML = documents.map((d, i) => `
    <li><label>
      <input type="checkbox" data-i="${i}" ${d.selected ? "checked" : ""}>
      <span>${flag(d.country)} ${esc(d.company || d.name)}
        <span class="meta"><span class="tag">${esc(DOC_TYPES[d.doc_type] || "Document")}</span><span class="tag">${esc(LANGS[d.language] || d.language || "?")}</span>${esc(d.name)}</span>
      </span>
    </label></li>`).join("");
  $("#doc-list").querySelectorAll("input").forEach((el) =>
    el.addEventListener("change", () => { documents[el.dataset.i].selected = el.checked; }));
}

function addDocument(name, text) {
  documents.push({ name, text, selected: true, company: name, doc_type: "other", language: "" });
  renderDocList();
}

async function run() {
  const chosen = documents.filter((d) => d.selected).map(({ name, text }) => ({ name, text }));
  $("#run").disabled = true;
  $("#status").textContent = `Extracting ${chosen.length} document(s)…`;
  try {
    const report = await api("/api/analyze", { documents: chosen, backend: $("#backend").value });
    render(report);
    $("#status").innerHTML = report.warnings.length
      ? `<div class="warning">${report.warnings.map(esc).join("<br>")}</div>` : `Done with ${esc(report.backend)}.`;
  } catch (e) {
    $("#status").innerHTML = `<span class="bad">${esc(e.message)}</span>`;
  } finally {
    $("#run").disabled = false;
  }
}

function render(r) {
  $("#results").hidden = false;
  const s = r.score;
  $("#score-total").textContent = s.total;
  $(".dial").style.setProperty("--pct", s.total / 10);
  $("#grade").textContent = `Grade ${s.grade}`;
  $("#band").textContent = s.band;
  const subject = r.graph.nodes.find((n) => n.id === r.graph.subject);
  $("#subject").textContent = subject ? `${subject.label} · ${s.entities} entities · ${s.markets.join(", ")}` : "";
  $("#pillars").innerHTML = s.pillars.map((p) => `
    <div class="pillar"><div class="lbl"><span>${esc(p.label)}</span><b>${p.score} / ${p.max}</b></div>
    <div class="bar"><i style="width:${(100 * p.score) / p.max}%"></i></div></div>`).join("");
  $("#checks").innerHTML = s.checks.map((c) => `
    <tr><td>${esc(c.label)}<br><span class="hint">${esc(c.note)}</span></td><td class="num">${c.score} / ${c.max}</td></tr>`).join("");

  renderGraph(r.graph);
  const ubos = r.graph.ubo[r.graph.subject] || [];
  const gaps = r.graph.undisclosed[r.graph.subject] || [];
  $("#ubo-table").innerHTML = `<table><tr><th>Effective owner of ${esc(subject?.label)}</th><th class="num">Stake</th></tr>
    ${ubos.map((u) => `<tr><td>${esc(u.name)} ${u.is_ubo ? "<b>· UBO</b>" : ""}</td><td class="num">${u.percent}%</td></tr>`).join("")}
    ${gaps.map((g) => `<tr><td class="bad">Unresolved via ${esc(g.name)} (${esc(g.jurisdiction)})</td><td class="num">${g.percent}%</td></tr>`).join("")}</table>`;

  const docName = Object.fromEntries(r.documents.map((d) => [d.id, d.name]));
  $("#findings").innerHTML = r.findings.length ? r.findings.map((f) => `
    <li class="${f.severity}"><span class="sev">${esc(f.severity)}</span><b>${esc(f.title)}</b>
    <p>${esc(f.detail)}${f.docs.length ? ` <span class="hint">· ${f.docs.map((d) => esc(docName[d])).join(", ")}</span>` : ""}</p></li>`).join("")
    : "<li>No issues found.</li>";

  const sources = Object.fromEntries(documents.map((d) => [d.name, d.text]));
  $("#extractions").innerHTML = r.documents.map((d) => {
    const ex = d.extraction;
    return `<details class="extraction"><summary>${flag(ex.country)} <b>${esc(ex.company.name || d.name)}</b>
      <span class="tag">${esc(DOC_TYPES[ex.doc_type])}</span><span class="tag">${esc(LANGS[ex.language] || ex.language)}</span>
      <span class="tag">${esc(d.backend)}</span><br><span class="hint">${esc(ex.summary_en)}</span></summary>
      <div class="body"><div><h3 class="hint">Original</h3><pre class="source">${esc(sources[d.name])}</pre></div>
      <div><h3 class="hint">Structured JSON</h3><pre>${esc(JSON.stringify(ex, null, 2))}</pre></div></div></details>`;
  }).join("");

  credential = r.credential;
  showCredential();
  document.dispatchEvent(new CustomEvent("passport:analyzed", { detail: r }));
}

function showCredential() {
  $("#vc").textContent = JSON.stringify(credential, null, 2);
  $("#verify-result").textContent = "";
}

function renderGraph(g) {
  const W = 900, rowH = 120, boxW = 170, boxH = 46;
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  const children = {};
  g.edges.forEach((e) => (children[e.from] ||= []).push(e.to));
  // Height above the bottom row: operating subsidiaries sit at 0, their owners above.
  const height = {};
  const h = (id, seen = new Set()) => {
    if (id in height) return height[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    return (height[id] = 1 + Math.max(-1, ...(children[id] || []).map((c) => h(c, seen))));
  };
  g.nodes.forEach((n) => h(n.id));
  const maxH = Math.max(0, ...Object.values(height));
  const rows = Array.from({ length: maxH + 1 }, () => []);
  g.nodes.forEach((n) => rows[maxH - height[n.id]].push(n.id));

  const pos = {};
  const place = (row, y) => row.forEach((id, i) => { pos[id] = { x: ((i + 0.5) * W) / row.length, y }; });
  rows[maxH].sort();
  place(rows[maxH], maxH * rowH + 30);
  for (let r = maxH - 1; r >= 0; r--) {
    const centre = (id) => { const cs = (children[id] || []).filter((c) => pos[c]); return cs.length ? cs.reduce((a, c) => a + pos[c].x, 0) / cs.length : W / 2; };
    rows[r].sort((a, b) => centre(a) - centre(b));
    place(rows[r], r * rowH + 30);
  }

  const ubos = new Set((g.ubo[g.subject] || []).filter((u) => u.is_ubo).map((u) => u.id));
  const H = (maxH + 1) * rowH + 10;
  const edges = g.edges.map((e) => {
    const a = pos[e.from], b = pos[e.to];
    const x1 = a.x, y1 = a.y + boxH, x2 = b.x, y2 = b.y - 4;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    return `<path d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}" fill="none" stroke="#98a2b3" stroke-width="1.5" marker-end="url(#arrow)"/>
      <rect x="${mx - 22}" y="${my - 10}" width="44" height="18" rx="4" fill="#fff" stroke="#e3e7ee"/>
      <text x="${mx}" y="${my + 3}" text-anchor="middle" font-size="11" fill="#344054">${e.percent ?? "?"}%</text>`;
  }).join("");
  const nodes = g.nodes.map((n) => {
    const p = pos[n.id];
    const opaque = n.kind === "entity" && n.offshore && n.undisclosed;
    const fill = n.kind === "person" ? "var(--person)" : opaque ? "var(--opaque)" : "var(--entity)";
    const stroke = ubos.has(n.id) ? "#f2b705" : n.id === g.subject ? "#0b1f44" : "none";
    const label = n.label.length > 24 ? n.label.slice(0, 23) + "…" : n.label;
    const sub = [flag(n.jurisdiction), n.kind === "person" ? "person" : n.registry || (opaque ? "no disclosure" : "entity")].join(" ");
    return `<g><title>${esc(n.label)}${n.native_name ? " · " + esc(n.native_name) : ""}</title>
      <rect x="${p.x - boxW / 2}" y="${p.y}" width="${boxW}" height="${boxH}" rx="${n.kind === "person" ? 23 : 8}"
        fill="${fill}" stroke="${stroke}" stroke-width="${stroke === "none" ? 0 : 4}" ${opaque ? 'stroke-dasharray="6 4"' : ""}/>
      <text x="${p.x}" y="${p.y + 19}" text-anchor="middle" font-size="11.5" font-weight="600" fill="#fff">${esc(label)}</text>
      <text x="${p.x}" y="${p.y + 35}" text-anchor="middle" font-size="10.5" fill="#e6edf9">${esc(sub)}</text></g>`;
  }).join("");
  $("#graph").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ownership graph">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="#98a2b3"/></marker></defs>${edges}${nodes}</svg>`;
}

async function init() {
  const [config, samples] = await Promise.all([api("/api/config"), api("/api/samples")]);
  $("#backend").innerHTML = config.available.map((b) => `<option ${b === config.backend ? "selected" : ""}>${b}</option>`).join("");
  $("#backend-desc").textContent = config.description;
  documents = samples.map((s) => ({ ...s, selected: !HELD_BACK.includes(s.name) }));
  renderDocList();

  $("#run").addEventListener("click", run);
  $("#file-input").addEventListener("change", async (e) => {
    for (const f of e.target.files) addDocument(f.name, await f.text());
    e.target.value = "";
  });
  $("#add-paste").addEventListener("click", () => {
    const text = $("#paste").value.trim();
    if (text) { addDocument(`pasted-${documents.length + 1}.txt`, text); $("#paste").value = ""; }
  });
  $("#verify").addEventListener("click", async () => {
    const res = await api("/api/verify", { credential });
    $("#verify-result").innerHTML = `<span class="${res.valid ? "ok" : "bad"}">${res.valid ? "✓" : "✗"} ${esc(res.reason)}</span>`;
  });
  $("#tamper").addEventListener("click", () => {
    credential = structuredClone(credential);
    credential.credentialSubject.readinessScore.value = 990;
    showCredential();
    $("#verify-result").textContent = "Score changed to 990 without re-signing. Now press Verify.";
  });
  $("#download").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(credential, null, 2)], { type: "application/json" }));
    a.download = "asean-startup-passport.vc.json";
    a.click();
  });
  run();
}

init();
