// Used by the Pages workflow at deploy time; the repo's index.html is never changed.
// Prints index.html with the initial "All achievements" view pre-rendered into <main id="app">,
// so search engines that don't run JavaScript can read it. index.js replaces it on load as usual.
"use strict";

const fs = require("fs");
const path = require("path");
const { kindOf, normalizeTiers, tierLabel, emojiUrls, GAME } = require("../index.js");

const root = path.join(__dirname, "..");
const TIER_ORDER = ["common", "uncommon", "rare", "epic", "unknown"]; // same as index.js

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const data = JSON.parse(fs.readFileSync(path.join(root, "saved_achievements.json"), "utf8"));
normalizeTiers(Object.values(data));
const known = Object.values(data).filter(e => kindOf(e) !== "unconfirmed");
known.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.name.localeCompare(b.name));

function icon(e) {
  const url = emojiUrls(e.icon).find(u => fs.existsSync(path.join(root, u)));
  if (!url) return esc(e.icon || "·");
  return `<img class="emoji" alt="${esc(e.icon)}" loading="lazy" width="24" height="24" src="${esc(url)}">`;
}

const counts = {};
for (const e of known) counts[e.tier] = (counts[e.tier] || 0) + 1;
const chips = TIER_ORDER.filter(t => counts[t]).map(t =>
  `<span class="t-${t}" style="color:var(--tier)">${esc(tierLabel(t))} ${counts[t]}${GAME.tiers[t] ? `/${GAME.tiers[t]}` : ""}</span>`).join("");
const stat = (n, label) => `<div class="stat"><b>${n}</b>${label}</div>`;

const rows = known.map(e => `<tr class="t-${esc(e.tier)}">` +
  `<td class="col-icon">${icon(e)}</td>` +
  `<td class="col-name">${esc(e.name || "(no name)")}${e.key[0] === "z" ? '<span class="partial">partial data</span>' : ""}</td>` +
  `<td class="col-tier"><span class="tag">${esc(tierLabel(e.tier))}</span></td>` +
  `<td class="col-desc">${esc(e.desc || "")}</td>` +
  `<td class="col-key key">${esc(e.key)}</td></tr>`).join("");

const html =
  `<section class="statrow"><h3>Dataset</h3><div class="summary">` +
  stat(GAME.total, "total") + stat(known.length, "known") + stat(Math.max(0, GAME.total - known.length), "unknown") +
  `</div><div class="tiers">${chips}</div></section>` +
  `<div class="controls"><input type="search" placeholder="Search name, description or key" value=""><select>` +
  `<option value="all">All tiers</option>${TIER_ORDER.map(t => `<option value="${t}">${esc(tierLabel(t))}</option>`).join("")}</select></div>` +
  `<section><h2>All achievements (${known.length})</h2><div class="table-wrap"><table><thead><tr>` +
  `<th class="col-icon"></th>` +
  `<th class="sortable" tabindex="0" aria-sort="none">Name</th>` +
  `<th class="sortable active" tabindex="0" aria-sort="ascending">Rarity ▲</th>` +
  `<th class="sortable" tabindex="0" aria-sort="none">Description</th>` +
  `<th class="sortable" tabindex="0" aria-sort="none">Key</th>` +
  `</tr></thead><tbody>${rows}</tbody></table></div></section>`;

const page = fs.readFileSync(path.join(root, "index.html"), "utf8");
const slot = /(<main id="app">)[\s\S]*?(<\/main>)/;
if (!slot.test(page)) throw new Error('<main id="app"> not found in index.html');
process.stdout.write(page.replace(slot, (_, open, close) => open + html + close));
