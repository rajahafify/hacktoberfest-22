// App flow on top of the KYB analyzer: login, challenges, solutions, DealTracker, notifications.
// State lives in localStorage so the prototype runs without a backend.
(() => {
  const STAGES = ["AI Matched", "Meeting Scheduled", "Proposal Submitted", "Negotiation", "POC / Pilot Project", "Deal Closed"];
  const SECTORS = ["Fintech", "Logistics", "Healthtech", "Edtech", "Climate", "Retail", "Enterprise SaaS"];
  const MARKETS = { SG: "Singapore", MY: "Malaysia", ID: "Indonesia", TH: "Thailand", VN: "Vietnam" };
  const APPROVAL_SCORE = 650;
  const KEY = "asp.state.v1";
  // Buyers are fictional and marked as demo.
  const CHALLENGES = [
    { id: "ch-1", title: "Cross-border invoice reconciliation", buyer: "Regional Bank A (demo)", buyerType: "Bank",
      sectors: ["Fintech", "Enterprise SaaS"], markets: ["SG", "MY", "ID"], minScore: 600,
      reward: "Pilot across two markets, SGD 150k", budget: "SGD 150,000", deadline: "31 Dec 2026", summary: "Match multi-currency supplier invoices across three ASEAN subsidiaries." },
    { id: "ch-2", title: "Last-mile delivery visibility", buyer: "Mekong Logistics Group (demo)", buyerType: "Corporate",
      sectors: ["Logistics"], markets: ["VN", "TH", "ID"], minScore: 500,
      reward: "Paid pilot, 3 cities", budget: "USD 60,000", deadline: "30 Nov 2026", summary: "Real-time proof of delivery across courier partners in Vietnam, Thailand and Indonesia." },
    { id: "ch-3", title: "Staff training in Bahasa and Thai", buyer: "Harbour Retail Co (demo)", buyerType: "Corporate",
      sectors: ["Edtech"], markets: ["ID", "TH"], minScore: 450,
      reward: "Rollout to 1,200 staff", budget: "USD 40,000", deadline: "15 Dec 2026", summary: "Localised micro-learning for store teams, with completion reporting." },
    { id: "ch-4", title: "Supplier KYC for SME vendors", buyer: "Pacific Venture Fund (demo)", buyerType: "Investor",
      sectors: ["Fintech", "Enterprise SaaS"], markets: ["SG", "MY", "VN"], minScore: 650,
      reward: "Portfolio-wide diligence tool", budget: "USD 250,000", deadline: "31 Jan 2027", summary: "Reuse verified company data to onboard portfolio suppliers faster." },
    { id: "ch-5", title: "Clinic booking for rural Thailand", buyer: "Siam Health Network (demo)", buyerType: "Corporate",
      sectors: ["Healthtech"], markets: ["TH"], minScore: 500,
      reward: "Pilot in 10 clinics", budget: "THB 800,000", deadline: "28 Feb 2027", summary: "Appointment booking that works on low-bandwidth phones in Thai and English." },
  ];

  const q = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const initials = (name) => name.replace(/\(demo\)/, "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  let filter = "All";
  const now = () => new Date().toISOString();
  const blank = () => ({ user: null, sectors: [], kyb: null, deals: [], solutions: [], notifications: [] });

  function load() {
    try {
      return { ...blank(), ...JSON.parse(localStorage.getItem(KEY) || "{}") };
    } catch {
      return blank();
    }
  }
  let state = load();
  const save = () => localStorage.setItem(KEY, JSON.stringify(state));
  const notify = (text) => state.notifications.unshift({ id: uid(), text, read: false, at: now() });
  const commit = () => { save(); route(); };

  const kybMarkets = () => (state.kyb && state.kyb.markets) || [];

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

  const VIEWS = ["login", "dashboard", "profile", "challenges", "deals", "notifications", "kyb"];
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
    q("#nav").hidden = !state.user;
    q("#user-chip").hidden = !state.user;
    q("#user-name").textContent = state.user ? `${state.user.name}${state.user.company ? " · " + state.user.company : ""}` : "";
    const unread = state.notifications.filter((n) => !n.read).length;
    q("#nav-badge").hidden = !unread;
    q("#nav-badge").textContent = unread;
    ({ login: () => {}, dashboard: renderDashboard, profile: renderProfile, challenges: renderChallenges, deals: renderDeals,
       notifications: renderNotifications, kyb: renderKyb })[view]();
  }

  function renderProfile() {
    const f = q("#profile-form");
    const u = state.user || {};
    ["name", "company", "email"].forEach((k) => (f.elements.namedItem(k).value = u[k] || ""));
    q("#sector-checks").innerHTML = SECTORS.map((s) =>
      `<label class="check"><input type="checkbox" value="${s}" ${state.sectors.includes(s) ? "checked" : ""}> ${s}</label>`).join("");
    const k = state.kyb;
    q("#profile-kyb").innerHTML = k
      ? `<p><span class="${k.approved ? "ok" : "bad"}">${k.approved ? "✓ KYB approved" : "✗ KYB needs remediation"}</span></p>
         <p>Readiness <b>${k.score}</b> / 1000 · Grade ${esc(k.grade)} · ${k.high} open high-severity finding(s)</p>
         <p class="hint">Checked ${new Date(k.at).toLocaleString()}. Approval needs readiness of ${APPROVAL_SCORE} or more.</p>
         <a class="btn light" href="#/kyb">Re-run KYB</a>`
      : `<p>KYB not started. Posting a solution needs an approved KYB.</p>
         <a class="btn" href="#/kyb">Start KYB</a>`;
  }

  function renderChallenges() {
    q("#filter-chips").innerHTML = ["All", ...SECTORS].map((s) =>
      `<button class="chip ${s === filter ? "on" : ""}" data-f="${s}">${s}</button>`).join("");
    const shown = CHALLENGES.filter((c) => filter === "All" || c.sectors.includes(filter));
    q("#challenge-list").innerHTML = shown.map((ch) => {
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
    q("#solution-list").innerHTML = state.solutions.length ? state.solutions.map((s) => `
      <div class="item">
        <div class="row-between"><b>${esc(s.title)}</b><span class="tag">${s.status === "posted" ? "Posted" : "Draft"}</span></div>
        <p class="hint">${esc(s.sector)} · ${s.markets.map((m) => MARKETS[m] || m).join(", ") || "No markets"}</p>
        <p>${esc(s.pitch)}</p>
        ${s.status === "draft" ? `<button class="post" data-id="${s.id}">Post solution</button>` : ""}
      </div>`).join("") : `<p class="hint">No solutions yet.</p>`;
  }

  function renderDashboard() {
    const u = state.user || {};
    q("#welcome").textContent = `Welcome back, ${(u.name || "founder").split(" ")[0]} 👋`;
    const checks = [u.name, u.company, u.email, state.sectors.length, state.kyb];
    const pct = Math.round((100 * checks.filter(Boolean).length) / checks.length);
    q("#profile-pct").textContent = `${pct}%`;
    q("#profile-ring").style.setProperty("--pct", pct);
    q("#profile-hint").textContent = pct === 100 ? "Your profile is complete." : "Add sectors and run KYB to get better matches.";
    const recs = CHALLENGES.map((c) => ({ c, m: matchFor(c) })).sort((a, b) => b.m.pct - a.m.pct).slice(0, 2);
    q("#dash-recs").innerHTML = recs.map(({ c, m }) => `
      <div class="item rec">
        <span class="avatar">${initials(c.buyer)}</span>
        <div><b>${esc(c.title)}</b><p class="hint">${esc(c.buyer)} · Budget ${esc(c.budget)}</p></div>
        <span class="match">${m.pct}%</span>
        <a class="btn light" href="#/challenges">View</a>
      </div>`).join("");
    const d = state.deals[0];
    q("#dash-deal").innerHTML = d
      ? `<p><b>${esc(d.title)}</b></p>
         <ol class="stepper">${STAGES.map((s, i) => `<li class="${i < d.stage ? "done" : i === d.stage ? "current" : ""}">${esc(s)}</li>`).join("")}</ol>
         <a class="btn light" href="#/deals">Open Deals Tracker</a>`
      : `<p class="hint">No deals yet. Pick a challenge to start your first match.</p>`;
  }

  function renderDeals() {
    q("#deal-list").innerHTML = state.deals.length ? state.deals.map((d) => {
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
    q("#notif-list").innerHTML = state.notifications.length ? state.notifications.slice(0, 50).map((n) => `
      <div class="notif ${n.read ? "" : "unread"}"><div>${esc(n.text)}</div>
      <div class="hint">${new Date(n.at).toLocaleString()}</div></div>`).join("") : `<p class="hint">Nothing yet.</p>`;
  }

  function renderKyb() {
    const k = state.kyb;
    q("#kyb-banner").innerHTML = k
      ? `KYB: <span class="${k.approved ? "ok" : "bad"}">${k.approved ? "approved" : "not approved"}</span> · readiness ${k.score} · ${k.high} open high finding(s)`
      : `KYB not run yet. Run due diligence below. An approved result unlocks posting solutions.`;
  }

  // Login
  q("#login-form").addEventListener("submit", (e) => {
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
  q("#logout").addEventListener("click", () => { state.user = null; commit(); });

  // MyProfile
  q("#profile-form").addEventListener("input", (e) => {
    if (!state.user) return;
    state.user[e.target.name] = e.target.value;
    save();
  });
  q("#sector-checks").addEventListener("change", (e) => {
    const v = e.target.value;
    state.sectors = e.target.checked ? [...state.sectors, v] : state.sectors.filter((s) => s !== v);
    save();
  });

  // Challenge: pick an AI match, or post a solution
  q("#challenge-list").addEventListener("click", (e) => {
    const id = e.target.dataset.id;
    const ch = CHALLENGES.find((c) => c.id === id);
    if (!ch) return;
    state.deals.unshift({ id: uid(), challengeId: ch.id, title: ch.title, counterpart: ch.buyer, stage: 0, meetingDate: null, updatedAt: now() });
    notify(`AI matched you to "${ch.title}". Next: arrange a meeting with ${ch.buyer}.`);
    commit();
    location.hash = "#/deals";
  });

  q("#solution-form").addEventListener("submit", (e) => {
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

  q("#solution-list").addEventListener("click", (e) => {
    const id = e.target.dataset.id;
    const sol = state.solutions.find((s) => s.id === id);
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

  // DealTracker
  q("#deal-list").addEventListener("click", (e) => {
    if (!e.target.classList.contains("advance")) return;
    const d = state.deals.find((x) => x.id === e.target.dataset.id);
    if (!d) return;
    d.stage += 1;
    d.updatedAt = now();
    notify(`${d.title}: now at "${STAGES[d.stage]}".`);
    commit();
  });
  q("#deal-list").addEventListener("change", (e) => {
    if (!e.target.classList.contains("meeting")) return;
    const d = state.deals.find((x) => x.id === e.target.dataset.id);
    if (!d) return;
    d.meetingDate = e.target.value;
    d.updatedAt = now();
    notify(`Meeting with ${d.counterpart} set for ${d.meetingDate}.`);
    commit();
  });

  q("#mark-read").addEventListener("click", () => {
    state.notifications.forEach((n) => (n.read = true));
    commit();
  });

  // KYB: app.js runs the analysis and dispatches the result; only a manual run counts.
  let runningKyb = false;
  q("#run").addEventListener("click", () => { runningKyb = true; });
  document.addEventListener("passport:analyzed", (e) => {
    if (!runningKyb || !state.user) return;
    runningKyb = false;
    const r = e.detail;
    const high = r.findings.filter((f) => f.severity === "high").length;
    const score = r.score.total;
    const approved = score >= APPROVAL_SCORE;
    state.kyb = { score, grade: r.score.grade, approved, high, markets: r.score.markets, at: now() };
    notify(approved
      ? `KYB approved: readiness ${score}/1000 (grade ${r.score.grade}). ${high} high finding(s) carried as conditions.`
      : `KYB needs remediation: readiness ${score}/1000 is below ${APPROVAL_SCORE}. Address the findings and run again.`);
    commit();
  });

  function init() {
    q("#solution-sector").innerHTML = SECTORS.map((s) => `<option>${s}</option>`).join("");
    q("#solution-markets").innerHTML = Object.entries(MARKETS).map(([c, n]) =>
      `<label class="check"><input type="checkbox" value="${c}"> ${n}</label>`).join("");
    q("#filter-chips").addEventListener("click", (e) => {
      if (!e.target.dataset.f) return;
      filter = e.target.dataset.f;
      renderChallenges();
    });
    window.addEventListener("hashchange", route);
    route();
  }
  init();
})();
