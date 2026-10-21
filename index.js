"use strict";

const GAME = { total: 497, tiers: { common: 71, uncommon: 150, rare: 198, epic: 78 } };
const TIER_ORDER = ["common", "uncommon", "rare", "epic", "unknown"];
const NAME_THRESHOLD = 0.8;
const DESC_THRESHOLD = 0.7;
const MAX_CANDIDATES = 3;

// ---------- pure logic ----------

// x = "I don't know" placeholder (never counted), z = confirmed but partial data, k = real
function kindOf(entry) {
  const c = entry.key[0];
  return c === "x" ? "unconfirmed" : c === "z" ? "partial" : "real";
}

function normText(s) {
  return (s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

function normIcon(s) {
  return (s || "").replace(/️/g, "").trim();
}

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function nameSimilarity(a, b) {
  a = normText(a); b = normText(b);
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function descSimilarity(a, b) {
  const ta = new Set(normText(a).split(" ").filter(Boolean));
  const tb = new Set(normText(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

// advisory signals between a dump entry and a dataset entry
function matchSignals(unknown, known) {
  const signals = [];
  const name = nameSimilarity(unknown.name, known.name);
  if (name >= NAME_THRESHOLD) signals.push({ type: "name", score: name });
  const desc = descSimilarity(unknown.desc, known.desc);
  if (desc >= DESC_THRESHOLD) signals.push({ type: "desc", score: desc });
  const icon = normIcon(unknown.icon);
  if (icon && icon === normIcon(known.icon)) signals.push({ type: "icon", score: 1 });
  return signals;
}

// a blank tier in the dataset means "rarity not known yet"
function normalizeTiers(entries) {
  for (const e of entries) if (!e.tier) e.tier = "unknown";
}

function tierLabel(t) {
  return t === "unknown" ? "rarity unknown" : t;
}

const EMOJI_DIR = "emoji/"; // self-hosted twemoji SVGs, so we never hit anyone else's CDN

// twemoji file names: code points joined by "-", fe0f dropped unless the emoji is a ZWJ sequence.
// A second candidate with every fe0f dropped covers sequences like the Lurker eye.
function emojiUrls(icon) {
  if (!icon) return [];
  const pts = Array.from(icon, c => c.codePointAt(0));
  const name = list => list.map(p => p.toString(16)).join("-");
  const primary = pts.includes(0x200d) ? pts : pts.filter(p => p !== 0xfe0f);
  const stripped = pts.filter(p => p !== 0xfe0f);
  const urls = [EMOJI_DIR + name(primary) + ".svg"];
  if (name(stripped) !== name(primary)) urls.push(EMOJI_DIR + name(stripped) + ".svg");
  return urls;
}

function bySortKey(a, b) {
  return TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.name.localeCompare(b.name);
}

function validateDump(json) {
  return json && Array.isArray(json.unlocked) &&
    json.unlocked.every(u => u && typeof u.key === "string");
}

function compare(dataset, dump) {
  const all = Object.values(dataset);
  const known = all.filter(e => kindOf(e) !== "unconfirmed");
  const owned = new Set(dump.unlocked.map(u => u.key));
  const unlocked = known.filter(e => owned.has(e.key));
  const locked = known.filter(e => !owned.has(e.key));
  const unknown = dump.unlocked.filter(u => !Object.hasOwn(dataset, u.key));

  // fuzzy flagging, against z entries only
  const zEntries = known.filter(e => kindOf(e) === "partial");
  const candidates = new Map(); // unknown key -> [{entry, signals}]
  const possiblyUnlocked = new Map(); // z key -> [unknown entries]
  for (const u of unknown) {
    const found = [];
    for (const z of zEntries) {
      const signals = matchSignals(u, z);
      if (!signals.length) continue;
      found.push({ entry: z, signals });
      if (!possiblyUnlocked.has(z.key)) possiblyUnlocked.set(z.key, []);
      possiblyUnlocked.get(z.key).push(u);
    }
    found.sort((a, b) => b.signals.length - a.signals.length ||
      Math.max(...b.signals.map(s => s.score)) - Math.max(...a.signals.map(s => s.score)));
    if (found.length) candidates.set(u.key, found.slice(0, MAX_CANDIDATES));
  }
  return { known, unlocked, locked, unknown, candidates, possiblyUnlocked };
}

// output in saved_achievements.json shape, no flags
function exportUnknown(unknown) {
  const out = {};
  for (const u of [...unknown].sort((a, b) => a.key.localeCompare(b.key))) {
    out[u.key] = { key: u.key, name: u.name, icon: u.icon, tier: u.tier, desc: u.desc, notes: "" };
  }
  return JSON.stringify(out, null, 2);
}

if (typeof module !== "undefined") {
  module.exports = { emojiUrls, normalizeTiers, tierLabel, kindOf, normText, nameSimilarity, descSimilarity, matchSignals, compare, exportUnknown, validateDump, GAME };
}

// ---------- UI ----------

if (typeof document !== "undefined") {
  const app = document.getElementById("app");
  const errorEl = document.getElementById("error");
  const clearBtn = document.getElementById("clear");
  const fileInput = document.getElementById("file");
  const dropEl = document.getElementById("drop");

  const state = { dataset: null, dump: null, result: null, search: "", tier: "all", sort: { col: "tier", dir: 1 } };

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function showError(msg) {
    errorEl.hidden = !msg;
    errorEl.textContent = msg || "";
  }

  function visible(e) {
    if (state.tier !== "all" && e.tier !== state.tier) return false;
    const q = state.search.trim().toLowerCase();
    return !q || `${e.name} ${e.desc} ${e.key}`.toLowerCase().includes(q);
  }

  const COLUMNS = [
    { id: "icon", label: "", sortable: false },
    { id: "name", label: "Name" },
    { id: "tier", label: "Rarity" },
    { id: "desc", label: "Description" },
    { id: "key", label: "Key" },
  ];

  function sortValue(e, col) {
    return col === "tier" ? TIER_ORDER.indexOf(e.tier) : (e[col] || "").toLowerCase();
  }

  function sortEntries(entries) {
    const { col, dir } = state.sort;
    return entries.slice().sort((a, b) => {
      const x = sortValue(a, col), y = sortValue(b, col);
      const c = typeof x === "number" ? x - y : x.localeCompare(y);
      return dir * c || bySortKey(a, b);
    });
  }

  function headerCell(c) {
    if (c.sortable === false) return el("th", { class: "col-icon" });
    const active = state.sort.col === c.id;
    const arrow = active ? (state.sort.dir === 1 ? " \u25B2" : " \u25BC") : "";
    return el("th", {
      class: `sortable${active ? " active" : ""}`, tabindex: "0", "aria-sort": active ? (state.sort.dir === 1 ? "ascending" : "descending") : "none",
      onclick: () => setSort(c.id), onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSort(c.id); } },
    }, c.label + arrow);
  }

  function setSort(col) {
    state.sort = state.sort.col === col ? { col, dir: -state.sort.dir } : { col, dir: 1 };
    render(false);
  }

  // twemoji image served from this site, falling back to the native emoji text if it can't be loaded
  function iconNode(icon) {
    const text = () => document.createTextNode(icon || "\u00B7");
    const urls = emojiUrls(icon);
    if (!urls.length) return text();
    const img = el("img", { class: "emoji", alt: icon, loading: "lazy", width: "24", height: "24" });
    let next = 0;
    img.addEventListener("error", () => {
      if (next < urls.length) img.src = urls[next++];
      else img.replaceWith(text());
    });
    img.src = urls[next++];
    return img;
  }

  function row(e, extra) {
    return el("tr", { class: `t-${e.tier}` },
      el("td", { class: "col-icon" }, iconNode(e.icon)),
      el("td", { class: "col-name" }, e.name || "(no name)",
        e.key[0] === "z" ? el("span", { class: "partial", text: "partial data" }) : null),
      el("td", { class: "col-tier" }, el("span", { class: "tag", text: tierLabel(e.tier) })),
      el("td", { class: "col-desc" }, e.desc || "", ...(extra ? [extra] : [])),
      el("td", { class: "col-key key", text: e.key }));
  }

  function listSection(title, entries, extraFor, open) {
    const shown = sortEntries(entries.filter(visible));
    const table = el("table", {},
      el("thead", {}, el("tr", {}, ...COLUMNS.map(headerCell))),
      el("tbody", {}, ...shown.map(e => row(e, extraFor && extraFor(e)))));
    const wrap = el("div", { class: "table-wrap" }, table);
    const label = `${title} (${shown.length}${shown.length !== entries.length ? ` of ${entries.length}` : ""})`;
    if (open === false) return el("details", {}, el("summary", { text: label }), wrap);
    return el("section", {}, el("h2", { text: label }), wrap);
  }

  function flagLine(text) {
    return el("div", { class: "flag", text });
  }

  function describeSignals(signals) {
    return signals.map(s => s.type === "icon" ? "same icon" : `${s.type} ${Math.round(s.score * 100)}%`).join(", ");
  }

  function tierCounts(entries) {
    const counts = {};
    for (const e of entries) counts[e.tier] = (counts[e.tier] || 0) + 1;
    return counts;
  }

  // chips show count/total per tier; totals is a tier -> number map
  function renderTierChips(entries, totals) {
    const counts = tierCounts(entries);
    return el("div", { class: "tiers" }, ...TIER_ORDER.filter(t => counts[t]).map(t =>
      el("span", { class: `t-${t}`, style: "color:var(--tier)", text: `${tierLabel(t)} ${counts[t]}${totals[t] ? `/${totals[t]}` : ""}` })));
  }

  function statRow(label, stats, chips) {
    return el("section", { class: "statrow" },
      el("h3", { text: label }),
      el("div", { class: "summary" }, ...stats),
      chips);
  }

  function renderControls() {
    const search = el("input", { type: "search", placeholder: "Search name, description or key", value: state.search });
    search.addEventListener("input", () => { state.search = search.value; render(false); });
    const select = el("select", {},
      el("option", { value: "all", text: "All tiers" }),
      ...TIER_ORDER.map(t => el("option", { value: t, text: tierLabel(t) })));
    select.value = state.tier;
    select.addEventListener("change", () => { state.tier = select.value; render(false); });
    return el("div", { class: "controls" }, search, select);
  }

  function stat(n, label) {
    return el("div", { class: "stat" }, el("b", { text: String(n) }), label);
  }

  function renderUnknown(r) {
    const dlBtn = el("button", { class: "btn", text: "Download" });
    dlBtn.addEventListener("click", () => {
      const blob = new Blob([exportUnknown(r.unknown)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = el("a", { href: url, download: `new_achievements_${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const extraFor = u => {
      const c = r.candidates.get(u.key);
      if (!c) return null;
      const wrap = el("div");
      for (const m of c) wrap.append(flagLine(`might be ${m.entry.key} "${m.entry.name}": ${describeSignals(m.signals)}`));
      return wrap;
    };
    const section = listSection("Not in dataset", r.unknown, extraFor);
    section.querySelector("h2").append(dlBtn);
    section.querySelector("h2").after(el("p", { class: "muted", text: "These unlocked achievements are missing from the dataset. Please download the file and send it to @toxin_x in #not-solitare in the Puzzmo Discord." }));
    return section;
  }

  function render(rebuildAll = true) {
    if (!state.dataset) return;
    const known = Object.values(state.dataset).filter(e => kindOf(e) !== "unconfirmed");
    const nodes = [];

    const total = state.dump?.total ?? GAME.total;
    nodes.push(statRow("Dataset", [
      stat(total, "total"),
      stat(known.length, "known"),
      stat(Math.max(0, total - known.length), "unknown")],
      renderTierChips(known, GAME.tiers)));

    if (!state.result) {
      nodes.push(renderControls(), listSection("All achievements", known));
    } else {
      const r = state.result;
      nodes.push(
        statRow("Your dump", [
          stat(r.unlocked.length, "unlocked"),
          stat(r.locked.length, "locked"),
          stat(r.unknown.length, "not in dataset")],
          renderTierChips(r.unlocked, tierCounts(known))),
        renderControls());
      if (r.unknown.length) nodes.push(renderUnknown(r));
      nodes.push(
        listSection("Locked", r.locked, e => {
          const m = r.possiblyUnlocked.get(e.key);
          return m ? flagLine(`possibly unlocked as ${m.map(u => `${u.key} "${u.name}"`).join(", ")}`) : null;
        }),
        listSection("Unlocked", r.unlocked, null, false));
    }

    // keep the search box focused while typing
    const hadFocus = document.activeElement && document.activeElement.type === "search";
    app.replaceChildren(...nodes);
    if (hadFocus) {
      const s = app.querySelector("input[type=search]");
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    }
    clearBtn.hidden = !state.dump;
  }

  async function loadFile(file) {
    try {
      const json = JSON.parse(await file.text());
      if (!validateDump(json)) throw new Error("no unlocked array");
      normalizeTiers(json.unlocked);
      state.dump = json;
      state.result = compare(state.dataset, json);
      showError("");
      render();
    } catch (err) {
      showError(`That file isn't a valid achievements dump (${err.message}).`);
    }
  }

  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = "";
  });
  clearBtn.addEventListener("click", () => {
    state.dump = state.result = null;
    showError("");
    render();
  });

  let dragDepth = 0;
  window.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; dropEl.hidden = false; });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; dropEl.hidden = true; } });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => {
    e.preventDefault();
    dragDepth = 0;
    dropEl.hidden = true;
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });

  fetch("saved_achievements.json")
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(data => { normalizeTiers(Object.values(data)); state.dataset = data; render(); })
    .catch(err => {
      app.replaceChildren(el("p", { class: "error", text: `Couldn't load saved_achievements.json (${err.message}). If you opened this file directly, serve the folder over http instead.` }));
    });
}
