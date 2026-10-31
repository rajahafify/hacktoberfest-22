import "./style.css";
import { analyze, verify, mockBackend, gemmaBackend, mockExtract } from "./passport/index.js";

// ---- Synthetic samples, bundled at build time ------------------------------
const RAW = import.meta.glob("./samples/*.txt", { query: "?raw", import: "default", eager: true });
const SAMPLES = Object.entries(RAW)
  .map(([path, text]) => ({ name: path.split("/").pop(), text }))
  .sort((a, b) => a.name.localeCompare(b.name));
// Left out of the first run so the demo can show the score move once the offshore UBO is disclosed.
const HELD_BACK = ["09_bvi_lumen_ventures_ubo_declaration.txt"];

// ---- Constants --------------------------------------------------------------
const STAGES = ["AI Matched", "Meeting Scheduled", "Proposal Submitted", "Negotiation", "POC / Pilot Project", "Deal Closed"];
const SECTORS = ["Fintech", "Logistics", "Healthtech", "Edtech", "Climate", "Retail", "Enterprise SaaS"];
const MARKETS = { SG: "Singapore", MY: "Malaysia", ID: "Indonesia", TH: "Thailand", VN: "Vietnam" };
const FLAGS = { SG: "🇸🇬", MY: "🇲🇾", ID: "🇮🇩", TH: "🇹🇭", VN: "🇻🇳", PH: "🇵🇭", VG: "🇻🇬", KY: "🇰🇾" };
const LANGS = { en: "English", ms: "Bahasa Melayu", id: "Bahasa Indonesia", th: "ไทย Thai", vi: "Tiếng Việt" };
const DOC_TYPES = { registry_profile: "Registry", financial_statement: "Financials", tax_filing: "Tax filing",
  compliance_declaration: "Compliance", other: "Other" };
const APPROVAL_SCORE = 650;
const KEY = "asp.state.v1";
const SETTINGS_KEY = "asp.settings.v1";
// Buyers are fictional and marked as demo.
const CHALLENGES = [
  { id: "ch-1", title: "Cross-border invoice reconciliation", buyer: "Regional Bank A (demo)", buyerType: "Bank",
    sectors: ["Fintech", "Enterprise SaaS"], markets: ["SG", "MY", "ID"], minScore: 600,
    budget: "SGD 150,000", deadline: "31 Dec 2026", reward: "Pilot across two markets",
    summary: "Match multi-currency supplier invoices across three ASEAN subsidiaries." },
  { id: "ch-2", title: "Last-mile delivery visibility", buyer: "Mekong Logistics Group (demo)", buyerType: "Corporate",
    sectors: ["Logistics"], markets: ["VN", "TH", "ID"], minScore: 500,
    budget: "USD 60,000", deadline: "30 Nov 2026", reward: "Paid pilot, 3 cities",
    summary: "Real-time proof of delivery across courier partners in Vietnam, Thailand and Indonesia." },
  { id: "ch-3", title: "Staff training in Bahasa and Thai", buyer: "Harbour Retail Co (demo)", buyerType: "Corporate",
    sectors: ["Edtech"], markets: ["ID", "TH"], minScore: 450,
    budget: "USD 40,000", deadline: "15 Dec 2026", reward: "Rollout to 1,200 staff",
    summary: "Localised micro-learning for store teams, with completion reporting." },
  { id: "ch-4", title: "Supplier KYC for SME vendors", buyer: "Pacific Venture Fund (demo)", buyerType: "Investor",
    sectors: ["Fintech", "Enterprise SaaS"], markets: ["SG", "MY", "VN"], minScore: 650,
    budget: "USD 250,000", deadline: "31 Jan 2027", reward: "Portfolio-wide diligence tool",
    summary: "Reuse verified company data to onboard portfolio suppliers faster." },
  { id: "ch-5", title: "Clinic booking for rural Thailand", buyer: "Siam Health Network (demo)", buyerType: "Corporate",
    sectors: ["Healthtech"], markets: ["TH"], minScore: 500,
    budget: "THB 800,000", deadline: "28 Feb 2027", reward: "Pilot in 10 clinics",
    summary: "Appointment booking that works on low-bandwidth phones in Thai and English." },
];

// ---- Helpers ----------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const flag = (c) => FLAGS[c] || "🏳️";
const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString();
const initials = (name) => name.replace(/\(demo\)/, "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const blank = () => ({ user: null, sectors: [], kyb: null, deals: [], solutions: [], notifications: [] });

function load(key, fallback) {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key) || "{}") };
  } catch {
    return fallback;
  }
}
let state = load(KEY, blank());
const save = () => localStorage.setItem(KEY, JSON.stringify(state));
const notify = (text) => state.notifications.unshift({ id: uid(), text, read: false, at: now() });
const commit = () => { save(); route(); };
const kybMarkets = () => (state.kyb && state.kyb.markets) || [];

// ---- KYB state (documents, last report) -----------------------------------
let documents = SAMPLES.map((s) => ({ ...s, selected: !HELD_BACK.includes(s.name), ...quickMeta(s.name, s.text) }));
let credential = null;

// Cheap metadata for the document list, read with the label extractor before any analysis runs.
function quickMeta(name, text) {
  const ex = mockExtract(name, text);
  return {
    company: ex.company.name || name,
    doc_type: ex.doc_type,
    language: ex.language,
    country: ex.country,
  };
}

const settings = load(SETTINGS_KEY, { backend: "mock", url: "http://localhost:8000/v1", model: "google/gemma-3-12b-it" });

function activeBackend() {
  if (settings.backend === "gemma" && settings.url) {
    return gemmaBackend({ url: settings.url, model: settings.model });
  }
  return mockBackend;
}

function renderBackendSettings() {
  $("#backend").value = settings.backend;
  $("#gemma-fields").hidden = settings.backend !== "gemma";
  $("#gemma-url").value = settings.url;
  $("#gemma-model").value = settings.model;
  $("#backend-desc").textContent = activeBackend().description;
}

// ---- Matching --------------------------------------------------------------
function matchFor(ch) {
  const reasons = [];
  const sector = ch.sectors.some((s) => state.sectors.includes(s)) ? 1 : 0;
  if (sector) reasons.push("Sector fit");
  const shared = ch.markets.filter((m) => kybMarkets().includes(m));
  if (shared.length) reasons.push(`${shared.length} of ${ch.markets.length} markets overlap`);
  const ready = state.kyb && state.kyb.score >= ch.minScore ? 1 : 0;
  if (ready) reasons.push(`Readiness ${state.kyb.score} meets ${ch.minScore}`);
  const pct = Math.round(100 * (0.5 * sector + 0.3 * (shared.length / ch.markets.length) + 0.2 * ready));
  return { pct, reasons };
}

// ---- Routing ----------------------------------------------------------------
const VIEWS = ["login", "dashboard", "profile", "challenges", "deals", "notifications", "kyb"];
let filter = "All";
let runningKyb = false;

function route() {
  const named = location.hash.replace(/^#\/?/, "").split("/")[0];
  let view = VIEWS.includes(named) ? named : "dashboard";
  if (!state.user) view = "login";
  else if (view === "login") view = "dashboard";
  if (location.hash !== `#/${view}`) {
    location.hash = `#/${view}`;
    return;
  }
  document.querySelectorAll(".view").forEach((s) => (s.hidden = s.id !== `view-${view}`));
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === view));
  $("#nav").hidden = !state.user;
  $("#user-chip").hidden = !state.user;
  $("#user-name").textContent = state.user ? `${state.user.name}${state.user.company ? " · " + state.user.company : ""}` : "";
  const unread = state.notifications.filter((n) => !n.read).length;
  $("#nav-badge").hidden = !unread;
  $("#nav-badge").textContent = unread;
  ({ login: () => {}, dashboard: renderDashboard, profile: renderProfile, challenges: renderChallenges,
    deals: renderDeals, notifications: renderNotifications, kyb: renderKyb })[view]();
}

// ---- Views ------------------------------------------------------------------
function renderDashboard() {
  const u = state.user || {};
  $("#welcome").textContent = `Welcome back, ${(u.name || "founder").split(" ")[0]} 👋`;
  const checks = [u.name, u.company, u.email, state.sectors.length, state.kyb];
  const pct = Math.round((100 * checks.filter(Boolean).length) / checks.length);
  $("#profile-pct").textContent = `${pct}%`;
  $("#profile-ring").style.setProperty("--pct", pct);
  $("#profile-hint").textContent = pct === 100 ? "Your profile is complete." : "Add sectors and run KYB to get better matches.";
  const recs = CHALLENGES.map((c) => ({ c, m: matchFor(c) })).sort((a, b) => b.m.pct - a.m.pct).slice(0, 2);
  $("#dash-recs").innerHTML = recs.map(({ c, m }) => `
    <div class="item rec">
      <span class="avatar">${initials(c.buyer)}</span>
      <div><b>${esc(c.title)}</b><p class="hint">${esc(c.buyer)} · Budget ${esc(c.budget)}</p></div>
      <span class="match">${m.pct}%</span>
      <a class="btn light" href="#/challenges">View</a>
    </div>`).join("");
  const d = state.deals[0];
  $("#dash-deal").innerHTML = d
    ? `<p><b>${esc(d.title)}</b></p>
       <ol class="stepper">${STAGES.map((s, i) => `<li class="${i < d.stage ? "done" : i === d.stage ? "current" : ""}">${esc(s)}</li>`).join("")}</ol>
       <a class="btn light" href="#/deals">Open Deals Tracker</a>`
    : `<p class="hint">No deals yet. Pick a challenge to start your first match.</p>`;
}

function renderProfile() {
  const f = $("#profile-form");
  const u = state.user || {};
  ["name", "company", "email"].forEach((k) => (f.elements.namedItem(k).value = u[k] || ""));
  $("#sector-checks").innerHTML = SECTORS.map((s) =>
    `<label class="check"><input type="checkbox" value="${s}" ${state.sectors.includes(s) ? "checked" : ""}> ${s}</label>`).join("");
  const k = state.kyb;
  $("#profile-kyb").innerHTML = k
    ? `<p><span class="${k.approved ? "ok" : "bad"}">${k.approved ? "✓ KYB approved" : "✗ KYB needs remediation"}</span></p>
       <p>Readiness <b>${k.score}</b> / 1000 · Grade ${esc(k.grade)} · ${k.high} open high-severity finding(s)</p>
       <p class="hint">Checked ${new Date(k.at).toLocaleString()}. Approval needs readiness of ${APPROVAL_SCORE} or more.</p>
       <a class="btn light" href="#/kyb">Re-run KYB</a>`
    : `<p>KYB not started. Posting a solution needs an approved KYB.</p>
       <a class="btn" href="#/kyb">Start KYB</a>`;
}

function renderChallenges() {
  $("#filter-chips").innerHTML = ["All", ...SECTORS].map((s) =>
    `<button class="chip ${s === filter ? "on" : ""}" data-f="${s}">${s}</button>`).join("");
  const shown = CHALLENGES.filter((c) => filter === "All" || c.sectors.includes(filter));
  $("#challenge-list").innerHTML = shown.map((ch) => {
    const m = matchFor(ch);
    const existing = state.deals.find((d) => d.challengeId === ch.id);
    const hot = m.pct >= 60;
    return `<article class="item challenge">
      <div class="row-between"><span class="avatar">${initials(ch.buyer)}</span><span class="tag ${hot ? "hot" : ""}">${hot ? "High priority" : "Open"}</span></div>
      <h3>${esc(ch.title)}</h3>
      <p class="hint">${esc(ch.buyer)} · ${esc(ch.buyerType)}</p>
      <p>${esc(ch.summary)}</p>
      <p>${ch.sectors.map((s) => `<span class="tag">${esc(s)}</span>`).join("")}${ch.markets.map((c) => `<span class="tag">${c}</span>`).join("")}</p>
      <div class="facts">
        <span>Budget<b>${esc(ch.budget)}</b></span>
        <span>Deadline<b>${esc(ch.deadline)}</b></span>
        <span>Match<b class="match">${m.pct}%</b></span>
      </div>
      <p class="hint">${m.reasons.length ? esc(m.reasons.join(" · ")) : "No match signals yet. Set sectors in MyProfile and run KYB."}</p>
      ${existing
        ? `<a class="btn light" href="#/deals">In DealTracker · ${esc(STAGES[existing.stage])}</a>`
        : `<button class="pick" data-id="${ch.id}">Pick this challenge</button>`}
    </article>`;
  }).join("") || `<p class="hint">No challenges in this sector yet.</p>`;
  $("#solution-list").innerHTML = state.solutions.length ? state.solutions.map((s) => `
    <div class="item">
      <div class="row-between"><b>${esc(s.title)}</b><span class="tag">${s.status === "posted" ? "Posted" : "Draft"}</span></div>
      <p class="hint">${esc(s.sector)} · ${s.markets.map((m) => MARKETS[m] || m).join(", ") || "No markets"}</p>
      <p>${esc(s.pitch)}</p>
      ${s.status === "draft" ? `<button class="post" data-id="${s.id}">Post solution</button>` : ""}
    </div>`).join("") : `<p class="hint">No solutions yet.</p>`;
}

function renderDeals() {
  $("#deal-list").innerHTML = state.deals.length ? state.deals.map((d) => {
    const steps = STAGES.map((s, i) => `<li class="${i < d.stage ? "done" : i === d.stage ? "current" : ""}">${esc(s)}</li>`).join("");
    const meeting = d.stage === 1
      ? `<label class="inline">Meeting date <input type="date" class="meeting" data-id="${d.id}" value="${d.meetingDate || ""}"></label>` : "";
    const action = d.stage < STAGES.length - 1
      ? `<button class="advance" data-id="${d.id}">Move to: ${esc(STAGES[d.stage + 1])}</button>`
      : `<p class="ok">Deal closed. Congratulations, you have your new client!</p>`;
    return `<article class="item deal">
      <div class="row-between"><div><b>${esc(d.title)}</b><div class="hint">${esc(d.counterpart)}</div></div>
      <span class="tag">Updated ${new Date(d.updatedAt).toLocaleDateString()}</span></div>
      <ol class="stepper">${steps}</ol>${meeting}${action}
    </article>`;
  }).join("") : `<p class="hint">No deals yet. Pick a challenge or post a solution to start.</p>`;
}

function renderNotifications() {
  $("#notif-list").innerHTML = state.notifications.length ? state.notifications.slice(0, 50).map((n) => `
    <div class="notif ${n.read ? "" : "unread"}"><div>${esc(n.text)}</div>
    <div class="hint">${new Date(n.at).toLocaleString()}</div></div>`).join("") : `<p class="hint">Nothing yet.</p>`;
}

function renderKyb() {
  renderBackendSettings();
  const k = state.kyb;
  $("#kyb-banner").innerHTML = k
    ? `KYB: <span class="${k.approved ? "ok" : "bad"}">${k.approved ? "approved" : "not approved"}</span> · readiness ${k.score} · ${k.high} open high finding(s)`
    : `KYB not run yet. Run due diligence below. An approved result unlocks posting solutions.`;
  renderDocList();
}

function renderDocList() {
  $("#doc-list").innerHTML = documents.map((d, i) => `
    <li><label>
      <input type="checkbox" data-i="${i}" ${d.selected ? "checked" : ""}>
      <span>${flag(d.country)} ${esc(d.company || d.name)}
        <span class="meta"><span class="tag">${esc(DOC_TYPES[d.doc_type] || "Document")}</span><span class="tag">${esc(LANGS[d.language] || d.language || "?")}</span>${esc(d.name)}</span>
      </span>
    </label></li>`).join("");
}

// ---- KYB run ----------------------------------------------------------------
async function runKyb() {
  const chosen = documents.filter((d) => d.selected).map(({ name, text }) => ({ name, text }));
  $("#run").disabled = true;
  $("#status").textContent = `Extracting ${chosen.length} document(s)…`;
  runningKyb = true;
  try {
    const report = await analyze(chosen, activeBackend());
    renderReport(report);
    $("#status").innerHTML = report.warnings.length
      ? `<div class="warning">${report.warnings.map(esc).join("<br>")}</div>` : `Done with ${esc(report.backend)}.`;
    if (runningKyb && state.user) recordKyb(report);
  } catch (e) {
    $("#status").innerHTML = `<span class="bad">${esc(e.message)}</span>`;
  } finally {
    runningKyb = false;
    $("#run").disabled = false;
  }
}

function recordKyb(r) {
  const high = r.findings.filter((f) => f.severity === "high").length;
  const score = r.score.total;
  const approved = score >= APPROVAL_SCORE;
  state.kyb = { score, grade: r.score.grade, approved, high, markets: r.score.markets, at: now() };
  notify(approved
    ? `KYB approved: readiness ${score}/1000 (grade ${r.score.grade}). ${high} high finding(s) carried as conditions.`
    : `KYB needs remediation: readiness ${score}/1000 is below ${APPROVAL_SCORE}. Address the findings and run again.`);
  commit();
}

function renderReport(r) {
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
}

function showCredential() {
  $("#vc").textContent = JSON.stringify(credential, null, 2);
  $("#verify-result").textContent = "";
}

function renderGraph(g) {
  const W = 900, rowH = 120, boxW = 170, boxH = 46;
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
    const centre = (id) => {
      const cs = (children[id] || []).filter((c) => pos[c]);
      return cs.length ? cs.reduce((a, c) => a + pos[c].x, 0) / cs.length : W / 2;
    };
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

// ---- Event wiring -----------------------------------------------------------
function wire() {
  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    state.user = {
      name: (f.get("name") || "").trim() || "Demo founder",
      company: (f.get("company") || "").trim(),
      email: (f.get("email") || "").trim(),
    };
    notify(`Welcome, ${state.user.name}. Pick a challenge or post a solution to start.`);
    commit();
  });
  $("#logout").addEventListener("click", () => { state.user = null; commit(); });

  $("#profile-form").addEventListener("input", (e) => {
    if (!state.user) return;
    state.user[e.target.name] = e.target.value;
    save();
  });
  $("#sector-checks").addEventListener("change", (e) => {
    const v = e.target.value;
    state.sectors = e.target.checked ? [...state.sectors, v] : state.sectors.filter((s) => s !== v);
    save();
  });

  $("#filter-chips").addEventListener("click", (e) => {
    if (!e.target.dataset.f) return;
    filter = e.target.dataset.f;
    renderChallenges();
  });
  $("#challenge-list").addEventListener("click", (e) => {
    const ch = CHALLENGES.find((c) => c.id === e.target.dataset.id);
    if (!ch) return;
    state.deals.unshift({ id: uid(), challengeId: ch.id, title: ch.title, counterpart: ch.buyer, stage: 0, meetingDate: null, updatedAt: now() });
    notify(`AI matched you to "${ch.title}". Next: arrange a meeting with ${ch.buyer}.`);
    commit();
    location.hash = "#/deals";
  });

  $("#solution-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    const markets = [...f.querySelectorAll("#solution-markets input:checked")].map((i) => i.value);
    state.solutions.unshift({
      id: uid(),
      title: f.elements.namedItem("title").value.trim(),
      pitch: f.elements.namedItem("pitch").value.trim(),
      sector: f.elements.namedItem("sector").value,
      markets,
      status: "draft",
    });
    notify("Solution saved as a draft. Complete KYB, then post it.");
    f.reset();
    commit();
  });
  $("#solution-list").addEventListener("click", (e) => {
    const sol = state.solutions.find((s) => s.id === e.target.dataset.id);
    if (!sol) return;
    if (!state.kyb || !state.kyb.approved) {
      notify(`"${sol.title}" needs an approved KYB before it can be posted.`);
      commit();
      location.hash = "#/kyb";
      return;
    }
    sol.status = "posted";
    state.deals.unshift({ id: uid(), challengeId: null, title: sol.title, counterpart: "Open listing (buyers can reach out)",
      stage: 2, meetingDate: null, updatedAt: now() });
    notify(`Posted "${sol.title}". It is live for buyers and sits at Proposal Submitted in DealTracker.`);
    commit();
    location.hash = "#/deals";
  });

  $("#deal-list").addEventListener("click", (e) => {
    if (!e.target.classList.contains("advance")) return;
    const d = state.deals.find((x) => x.id === e.target.dataset.id);
    if (!d) return;
    d.stage += 1;
    d.updatedAt = now();
    notify(`${d.title}: now at "${STAGES[d.stage]}".`);
    commit();
  });
  $("#deal-list").addEventListener("change", (e) => {
    if (!e.target.classList.contains("meeting")) return;
    const d = state.deals.find((x) => x.id === e.target.dataset.id);
    if (!d) return;
    d.meetingDate = e.target.value;
    d.updatedAt = now();
    notify(`Meeting with ${d.counterpart} set for ${d.meetingDate}.`);
    commit();
  });
  $("#mark-read").addEventListener("click", () => {
    state.notifications.forEach((n) => (n.read = true));
    commit();
  });

  // KYB
  $("#backend").addEventListener("change", (e) => {
    settings.backend = e.target.value;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    renderBackendSettings();
  });
  for (const [sel, key] of [["#gemma-url", "url"], ["#gemma-model", "model"]]) {
    $(sel).addEventListener("change", (e) => {
      settings[key] = e.target.value.trim();
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      renderBackendSettings();
    });
  }
  $("#doc-list").addEventListener("change", (e) => {
    documents[e.target.dataset.i].selected = e.target.checked;
  });
  $("#run").addEventListener("click", runKyb);
  $("#file-input").addEventListener("change", async (e) => {
    for (const f of e.target.files) addDocument(f.name, await f.text());
    e.target.value = "";
  });
  $("#add-paste").addEventListener("click", () => {
    const text = $("#paste").value.trim();
    if (text) { addDocument(`pasted-${documents.length + 1}.txt`, text); $("#paste").value = ""; }
  });
  $("#verify").addEventListener("click", async () => {
    const res = await verify(credential);
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

  renderBackendSettings();
  // Solutions form needs sector and market options
  $("#solution-sector").innerHTML = SECTORS.map((s) => `<option>${s}</option>`).join("");
  $("#solution-markets").innerHTML = Object.entries(MARKETS).map(([c, n]) =>
    `<label class="check"><input type="checkbox" value="${c}"> ${n}</label>`).join("");

  window.addEventListener("hashchange", route);
}

function addDocument(name, text) {
  documents.push({ name, text, selected: true, ...quickMeta(name, text) });
  renderDocList();
}

wire();
route();
