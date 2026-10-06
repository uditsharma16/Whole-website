/* TSO Central Archives — client
 * Content comes from /api/site (the Worker's live read of the Order's Google Site) and is
 * re-checked on a timer, so a page published on Google Sites appears here without a reload.
 * Every Google Doc the site links to or embeds opens here as a page of its own (/api/doc);
 * Sheets become tables, and Slides, Forms and Drive files open in a framed viewer. */

const P = window.ArchiveParse;
const POLL_MS = 90_000;
const SITE_URL = "https://sites.google.com/view/tso-central-archives/home";

const fallback = {
  ok: true,
  preview: true,
  name: "TSO Central Archives",
  source: SITE_URL,
  pages: [{ path: "", title: "Home", source: SITE_URL, html: `<p>The archive gate is sealed for the moment: the Order's Google Site could not be reached. Its records are still available at the source.</p><p><a href="${SITE_URL}">Open the Google Site</a></p>`, files: [] }],
  files: []
};

const KIND = {
  document: { label: "Document", plural: "Documents", app: "Google Docs" },
  spreadsheets: { label: "Spreadsheet", plural: "Spreadsheets", app: "Google Sheets" },
  presentation: { label: "Slides", plural: "Slide decks", app: "Google Slides" },
  forms: { label: "Form", plural: "Forms", app: "Google Forms" },
  drawings: { label: "Drawing", plural: "Drawings", app: "Google Drawings" },
  file: { label: "File", plural: "Files", app: "Google Drive" },
  folder: { label: "Folder", plural: "Folders", app: "Google Drive" }
};
const GENERIC_LABEL = /^(open|view|link|here|click here|click|document|doc|file|read|read more|more|go|visit|download|preview|open document|view document|\d+)$/i;

const state = { site: null, signature: "", lastSync: 0, live: false, searchIndex: 0, searchMatches: [], renderToken: 0 };
const docCache = new Map();
const app = document.getElementById("app");
const byId = (id) => document.getElementById(id);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const esc = P.esc;

/* ───────── Data + live sync ───────── */
async function loadSite() {
  const response = await fetch("/api/site", { cache: "no-store" });
  if (!response.ok) throw new Error("Archive unavailable");
  const site = await response.json();
  if (!site.ok || !Array.isArray(site.pages) || !site.pages.length) throw new Error("Archive unavailable");
  return prepareSite(site);
}
const signatureOf = (site) => JSON.stringify([site.name, site.pages.map((page) => [page.path, page.title, page.html]), site.files.map((file) => [file.key, file.label, file.title])]);

function prepareSite(raw) {
  const files = new Map();
  for (const file of raw.files || []) {
    files.set(file.key, { ...file, docTitle: docCache.get(file.key)?.value?.title || "", order: files.size });
  }
  const pages = raw.pages.map((page, index) => {
    const parsed = P.sitePage(page.html || "", { title: page.title, siteName: raw.name });
    // Embedded files with no name of their own borrow the label they were given on the page.
    for (const block of parsed.blocks) {
      if (block.type !== "file") continue;
      if (!files.has(block.key)) files.set(block.key, { key: block.key, kind: block.ref.kind, id: block.ref.id, pub: block.ref.pub, gid: block.ref.gid || "", label: block.label, title: "", pages: [page.path], docTitle: "", order: files.size });
      const file = files.get(block.key);
      if (!file.label && block.label) file.label = block.label;
      if (!file.pages.includes(page.path)) file.pages.push(page.path);
    }
    return { ...page, index, ...parsed, fileKeys: [...new Set([...parsed.blocks.filter((block) => block.type === "file").map((block) => block.key), ...(page.files || [])])] };
  });
  const site = { ...raw, name: (raw.name || "TSO Central Archives").trim(), pages, files: [...files.values()] };
  site.signature = signatureOf(raw);
  return site;
}

async function start() {
  try {
    state.site = await loadSite();
    state.live = true;
  } catch {
    state.site = prepareSite(fallback);
    state.live = false;
  }
  state.signature = state.site.signature;
  state.lastSync = Date.now();
  renderMenus();
  route();
  updateSyncLabel();
  nameUnnamedFiles();
  setTimeout(watchFrameRate, 800);
  setInterval(refresh, POLL_MS);
  setInterval(updateSyncLabel, 10_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - state.lastSync > 30_000) refresh(); });
}

async function refresh() {
  if (document.hidden) return;
  try {
    const next = await loadSite();
    state.lastSync = Date.now();
    const changed = next.signature !== state.signature;
    const wasOffline = !state.live;
    state.live = true;
    if (changed) {
      state.site = next;
      state.signature = next.signature;
      renderMenus();
      if (!isFilePath(currentPath())) route({ preserveScroll: true, instant: true });
      if (!byId("searchPanel").hidden) renderSearch(byId("globalSearch").value);
      nameUnnamedFiles();
      toast(wasOffline ? "Connection restored — archives synced" : "Archives updated from Google Sites");
    }
  } catch {
    state.live = false;
  }
  updateSyncLabel();
}

function updateSyncLabel() {
  const pill = byId("syncPill");
  if (!state.site) return;
  if (state.site.preview && !state.live) {
    pill.dataset.state = "offline";
    byId("droid").dataset.state = "offline";
    byId("syncStatus").textContent = "Offline";
    byId("footerSync").textContent = "Google Site unreachable";
    return;
  }
  pill.dataset.state = state.live ? "live" : "offline";
  byId("droid").dataset.state = pill.dataset.state;
  const seconds = Math.round((Date.now() - state.lastSync) / 1000);
  const ago = seconds < 45 ? "just now" : seconds < 3600 ? `${Math.round(seconds / 60)} min ago` : `${Math.round(seconds / 3600)} h ago`;
  byId("syncStatus").textContent = state.live ? "Live" : "Reconnecting";
  byId("footerSync").textContent = state.live ? `Synced · ${ago}` : `Unreachable · last synced ${ago}`;
}

/* Files the site never named (a bare embed, or a link that just says "here") get their real
 * title from Google, a few at a time, and every card showing them is updated in place. */
async function nameUnnamedFiles() {
  const unnamed = state.site.files.filter((file) => !fileTitle(file, true));
  for (let i = 0; i < unnamed.length; i += 4) {
    await Promise.all(unnamed.slice(i, i + 4).map(async (file) => {
      try {
        const response = await fetch(`/api/title?kind=${file.kind}&id=${encodeURIComponent(file.id)}${file.pub ? "&pub=1" : ""}`);
        const body = await response.json();
        if (body.title) { file.title = body.title; refreshFileNames(file); }
      } catch {}
    }));
  }
}
function refreshFileNames(file) {
  document.querySelectorAll(`[data-file-name="${CSS.escape(file.key)}"]`).forEach((node) => { node.textContent = fileTitle(file); if (node.hasAttribute("aria-label")) node.setAttribute("aria-label", fileTitle(file)); });
}

/* ───────── Helpers ───────── */
const slug = P.slug;
function currentPath() { return location.pathname; }
const homePage = () => state.site.pages.find((page) => page.path === "") || state.site.pages[0];
const vaults = () => state.site.pages.filter((page) => page !== homePage());
const pageHref = (page) => (page.path ? `/p/${page.path}` : "/");
const fileHref = (file) => P.fileRoute(file);
const fileByKey = (key) => state.site.files.find((file) => file.key === key);
const meaningful = (label = "") => label && label.length > 1 && label.length < 160 && !GENERIC_LABEL.test(label.trim()) && !/^https?:\/\//i.test(label);
function fileTitle(file, strict = false) {
  const name = (meaningful(file.label) ? file.label : "") || file.docTitle || file.title;
  return strict ? name : name || `Untitled ${KIND[file.kind]?.label.toLowerCase() || "file"}`;
}
function filePages(file) { return file.pages.map((path) => state.site.pages.find((page) => page.path === path)).filter(Boolean); }
function fileVault(file) { return filePages(file).find((page) => page.path) || filePages(file)[0] || null; }
const canThumb = (file) => !file.pub && ["document", "spreadsheets", "presentation", "drawings", "file"].includes(file.kind);
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const pad = (number) => String(number).padStart(2, "0");
function roman(number) {
  const map = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = ""; for (const [value, numeral] of map) while (number >= value) { out += numeral; number -= value; }
  return out;
}
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function hash(seed = "") {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h;
}
function seededRandom(seed = "") {
  let h = hash(seed) | 0; h = (h + 0x6d2b79f5) | 0;
  let t = Math.imul(h ^ (h >>> 15), 1 | h);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/* "Record of the day": the same file for every visitor, all day (UTC), with no storage —
 * each file is scored by hashing today's date with its key and the highest score wins. */
function recordOfTheDay(files) {
  const day = new Date().toISOString().slice(0, 10);
  let best = null, bestScore = -1;
  for (const file of files) { const score = seededRandom(`${day}:${file.key}`); if (score > bestScore) { bestScore = score; best = file; } }
  return best;
}

/* A deterministic seal per vault/file, so entries without artwork still have a face. */
function glyph(seed = "") {
  let h = hash(seed);
  const rand = () => { h |= 0; h = (h + 0x6d2b79f5) | 0; let t = Math.imul(h ^ (h >>> 15), 1 | h); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const point = (radius, angle) => `${(Math.cos(angle) * radius).toFixed(2)},${(Math.sin(angle) * radius).toFixed(2)}`;
  const polygon = (sides, radius, rotation) => Array.from({ length: sides }, (_, i) => point(radius, rotation + (i / sides) * Math.PI * 2)).join(" ");
  const sides = [3, 4, 6, 8][Math.floor(rand() * 4)];
  const inner = 3 + Math.floor(rand() * 4);
  const rotation = -Math.PI / 2;
  const ticks = [16, 24, 32, 48][Math.floor(rand() * 4)];
  const tickMarks = Array.from({ length: ticks }, (_, i) => { const angle = (i / ticks) * Math.PI * 2; const long = i % 4 === 0; return `<path d="M${point(long ? 40 : 43, angle)} L${point(46, angle)}"/>`; }).join("");
  const blades = rand() > .45 ? Array.from({ length: sides }, (_, i) => `<path d="M${point(9, rotation + (i / sides) * Math.PI * 2)} L${point(33, rotation + (i / sides) * Math.PI * 2)}"/>`).join("") : "";
  return `<svg class="glyph" viewBox="-50 -50 100 100" aria-hidden="true"><g class="glyph-ring"><circle r="48"/>${tickMarks}<circle r="37" stroke-dasharray="${(1 + rand() * 6).toFixed(1)} ${(2 + rand() * 5).toFixed(1)}"/></g><g class="glyph-core"><polygon points="${polygon(sides, 33, rotation)}"/><polygon points="${polygon(inner, 17, rotation + Math.PI / inner)}"/>${blades}<circle class="glyph-dot" r="3"/></g></svg>`;
}
const KIND_ICON = {
  document: `<path d="M6 2h9l5 5v15H6Z"/><path d="M14 2v6h6M9 13h8M9 17h6"/>`,
  spreadsheets: `<path d="M4 3h16v18H4Z"/><path d="M4 9h16M4 15h16M10 3v18"/>`,
  presentation: `<path d="M3 4h18v12H3Z"/><path d="M12 16v4M8 20h8M10 8l4 2-4 2Z"/>`,
  forms: `<path d="M5 2h14v20H5Z"/><path d="M9 7h7M9 12h7M9 17h7"/><circle cx="7" cy="7" r=".6"/><circle cx="7" cy="12" r=".6"/><circle cx="7" cy="17" r=".6"/>`,
  drawings: `<path d="M4 20 15 9l3 3L7 23H4Z"/><path d="m14 4 6 6"/>`,
  file: `<path d="M6 2h9l5 5v15H6Z"/><path d="M14 2v6h6"/>`,
  folder: `<path d="M3 6h7l2 2h9v12H3Z"/>`
};
const kindIcon = (kind) => `<svg class="kind-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">${KIND_ICON[kind] || KIND_ICON.file}</svg>`;
const SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>`;
const RANDOM_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>`;
const SABER_RULE = (label) => `<div class="rule" role="presentation"><span class="rule-blade"></span><b>${esc(label)}</b><span class="rule-blade"></span></div>`;

/* ───────── Routing ───────── */
function parseRoute(path = currentPath()) {
  const parts = path.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (!parts.length) return { view: "home" };
  if (parts[0] === "p") return { view: "page", path: parts.slice(1).join("/") };
  if (parts[0] === "codex") return { view: "codex" };
  const kind = P.ROUTE_KIND[parts[0]];
  if (kind) {
    const pub = parts[1] === "e";
    const id = pub ? parts[2] : parts[1];
    if (id && /^[A-Za-z0-9_-]{20,140}$/.test(id)) return { view: "file", kind, id, pub, gid: new URLSearchParams(location.search).get("gid") || "" };
  }
  return { view: "missing" };
}
const isFilePath = (path) => parseRoute(path.split("?")[0]).view === "file";

function route(options = {}) {
  const render = () => {
    state.renderToken += 1;
    const target = parseRoute();
    if (target.view === "home") return renderHome(options);
    if (target.view === "codex") return renderCodex(options);
    if (target.view === "page") {
      const page = state.site.pages.find((item) => item.path === target.path);
      return page ? renderVault(page, options) : renderNotFound();
    }
    if (target.view === "file") {
      const key = P.fileKey(target);
      const file = fileByKey(key) || { key, kind: target.kind, id: target.id, pub: target.pub, gid: target.gid, label: "", title: "", pages: [], docTitle: "", order: Infinity, external: true };
      if (target.gid && !file.gid) file.gid = target.gid;
      return renderFile(file, options);
    }
    renderNotFound();
  };
  if (document.startViewTransition && !reducedMotion.matches && !options.instant && !document.hidden) {
    const transition = document.startViewTransition(render);
    transition.ready.catch(() => {}); transition.finished.catch(() => {});
  } else render();
}
function navigate(href) {
  const target = new URL(href, location.origin);
  const path = target.pathname + target.search;
  closeSearch(); closeMenus();
  if (path === currentPath() + location.search) {
    if (target.hash) byId(decodeURIComponent(target.hash.slice(1)))?.scrollIntoView({ behavior: "smooth" });
    else scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  const perform = () => {
    history.pushState({}, "", path + target.hash);
    route({ instant: true, hash: target.hash });
  };
  if (isFilePath(path) && !reducedMotion.matches && !doorsBusy) blastDoors(perform);
  else perform();
}

/* ───────── Blast doors ─────────
 * Opening a record seals the archive for a heartbeat: two armoured doors slam together,
 * a crimson seam ignites along the join like a blade, the record is swapped in behind
 * them, and they draw apart again. Hand-timed in beats rather than one cross-fade. */
let doorsBusy = false;
/* Resolves when the doors finish moving, or after `limit` ms if a transition never reports. */
function doorsSettled(doors, limit) {
  const door = doors.querySelector(".door-top");
  return new Promise((resolve) => {
    const done = () => { door.removeEventListener("transitionend", done); clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, limit);
    door.addEventListener("transitionend", done);
  });
}
async function blastDoors(swap) {
  const doors = byId("blastDoors");
  doorsBusy = true;
  doors.classList.add("active");
  void doors.offsetWidth;
  doors.classList.add("shut");
  await doorsSettled(doors, 900);
  doors.classList.add("seam");
  swap(); // hidden behind the sealed doors
  await new Promise((resolve) => setTimeout(resolve, perf.lite ? 160 : 280));
  doors.classList.remove("shut");
  app.classList.remove("doors-arrive"); void app.offsetWidth; app.classList.add("doors-arrive");
  await doorsSettled(doors, 1200);
  doors.classList.remove("active", "seam");
  app.classList.remove("doors-arrive");
  doorsBusy = false;
}

function afterRender(options = {}) {
  bindImageFallbacks(app); bindMotion(app); observeReveals(app); decryptTitles(app);
  if (options.hash) {
    const target = byId(decodeURIComponent(options.hash.slice(1)));
    if (target) { setTimeout(() => target.scrollIntoView({ behavior: "auto", block: "start" }), 30); updateProgress(); return; }
  }
  if (!options.preserveScroll) { scrollTo({ top: 0, behavior: "auto" }); app.focus({ preventScroll: true }); }
  updateProgress();
}

/* ───────── Menus ───────── */
function renderMenus() {
  const list = vaults();
  byId("sectionsPopover").innerHTML = list.length
    ? list.map((page, index) => `<a href="${pageHref(page)}" data-link style="--depth:${page.path.split("/").length - 1}"><em>${roman(index + 1)}</em><span>${esc(page.title)}</span><small>${page.fileKeys.length || ""}</small></a>`).join("")
    : `<p class="popover-empty">No vaults have been opened yet.</p>`;
  byId("footerSource").href = state.site.source || SITE_URL;
}

/* ───────── Shared pieces ───────── */
function fileThumb(file, size = "") {
  return `<span class="file-thumb${size ? ` ${size}` : ""}" data-seed="${esc(file.key)}">${canThumb(file) ? `<img src="/api/img?thumb=${encodeURIComponent(file.id)}" alt="" loading="lazy" />` : glyph(file.key)}<span class="file-kind">${kindIcon(file.kind)}${esc(KIND[file.kind]?.label || "File")}</span></span>`;
}
function fileCard(file, index = 0, context = {}) {
  const vault = context.hideVault ? null : fileVault(file);
  return `<a class="file-card" href="${fileHref(file)}" data-link data-prefetch="${esc(file.key)}" data-reveal style="--d:${Math.min(index * 60, 420)}ms">
    ${fileThumb(file)}
    <span class="file-body">
      ${vault ? `<small>${esc(vault.title)}</small>` : `<small>${esc(KIND[file.kind]?.app || "Google Drive")}</small>`}
      <strong data-file-name="${esc(file.key)}">${esc(fileTitle(file))}</strong>
      <em>${file.kind === "document" ? "Read in the archive" : file.kind === "spreadsheets" ? "Open the ledger" : "Open the viewer"} <span aria-hidden="true">→</span></em>
    </span>
  </a>`;
}
function blocksHtml(blocks) {
  const out = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const run = (type) => { const items = [block]; while (blocks[i + 1]?.type === type) items.push(blocks[++i]); return items; };
    if (block.type === "h") out.push(`<h${block.level} id="${esc(block.id)}">${block.html}</h${block.level}>`);
    else if (block.type === "p") out.push(`<p${block.align ? ` class="${block.align}"` : ""}>${block.html}</p>`);
    else if (block.type === "quote") out.push(`<blockquote><p>${block.html}</p></blockquote>`);
    else if (block.type === "list" || block.type === "table") out.push(block.html);
    else if (block.type === "rule") out.push("<hr>");
    else if (block.type === "video") out.push(`<div class="video-frame"><iframe src="https://www.youtube-nocookie.com/embed/${esc(block.id)}" title="Video" loading="lazy" allow="accelerometer; encrypted-media; picture-in-picture; fullscreen"></iframe></div>`);
    else if (block.type === "img") {
      const items = run("img");
      out.push(`<div class="gallery${items.length === 1 ? " single" : ""}">${items.map((item) => `<figure><button data-zoom="${esc(item.src)}" data-caption="${esc(item.alt)}" aria-label="Enlarge image"><img src="${esc(item.src)}" alt="${esc(item.alt)}" loading="lazy" /></button></figure>`).join("")}</div>`);
    } else if (block.type === "button") {
      const items = run("button");
      out.push(`<div class="button-row">${items.map((item) => item.html).join("")}</div>`);
    } else if (block.type === "file") {
      const items = run("file");
      out.push(`<div class="file-grid in-prose">${items.map((item, index) => { const file = fileByKey(item.key); return file ? fileCard(file, index, { hideVault: true }) : ""; }).join("")}</div>`);
    }
  }
  return out.join("");
}
function readingMinutes(words) { return Math.max(1, Math.round(words / 220)); }
function contentsAside(headings, label) {
  return `<aside class="article-aside" aria-label="${esc(label)}"><strong>${esc(label)}</strong>${headings.map((heading) => `<a href="#${esc(heading.id)}" data-scroll class="${heading.level === 3 ? "sub" : ""}">${esc(heading.text)}</a>`).join("")}</aside>`;
}

/* ───────── Home ───────── */
const HERO_CORE = (() => {
  const ticks = Array.from({ length: 90 }, (_, i) => { const a = (i / 90) * Math.PI * 2, r = i % 5 === 0 ? 87 : 92; return `<path d="M${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)} L${(Math.cos(a) * 97).toFixed(1)},${(Math.sin(a) * 97).toFixed(1)}"/>`; }).join("");
  return `<svg viewBox="-100 -100 200 200" aria-hidden="true">
  <defs>
    <path id="coreTextPath" d="M0,-76 a76,76 0 1,1 -0.01,0"/>
    <linearGradient id="kyber" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd2c8"/><stop offset=".35" stop-color="#ff3b44"/><stop offset="1" stop-color="#5c0610"/></linearGradient>
  </defs>
  <g class="ring r1" stroke-width=".6"><circle r="97"/>${ticks}</g>
  <g class="ring r2"><text class="core-text"><textPath href="#coreTextPath">KNOWLEDGE IS POWER · THE ARCHIVES REMEMBER · PEACE IS A LIE · THERE IS ONLY PASSION ·</textPath></text></g>
  <g class="ring r3" stroke-width=".8"><circle r="62" stroke-dasharray="1 4"/><circle r="56" stroke-dasharray="30 10 4 10"/><circle class="orb" cx="62" cy="0" r="2.6"/><circle class="orb" cx="-62" cy="0" r="1.6"/></g>
  <g class="core">
    <path class="hex" pathLength="100" d="M0,-46 39.8,-23 39.8,23 0,46 -39.8,23 -39.8,-23Z"/>
    <path class="hex inner" pathLength="100" d="M0,-46 0,0 39.8,23 M0,0 -39.8,23"/>
    <g class="crystal"><polygon class="facet" points="0,-30 13,0 0,30 -13,0" fill="url(#kyber)"/><polygon class="facet-shine" points="0,-30 13,0 0,-4"/><polygon class="facet-dark" points="0,30 -13,0 0,4"/></g>
  </g>
</svg>`;
})();

function renderHome(options) {
  const home = homePage();
  const files = state.site.files;
  document.title = /central archives/i.test(state.site.name) ? state.site.name : `${state.site.name} — Central Archives`;
  const leadBlock = home.blocks.find((block) => block.type === "p" && block.text.length > 30 && block.text.length < 420);
  const lead = leadBlock ? leadBlock.text : "The central archive of the Sith Order: every vault, every handbook, every record — unsealed for those with the will to read them.";
  const rest = home.blocks.filter((block) => block !== leadBlock);
  const spotlight = files.length ? recordOfTheDay(files.filter((file) => file.kind === "document").length ? files.filter((file) => file.kind === "document") : files) : null;
  const list = vaults();
  const ticker = files.map((file) => `<a href="${fileHref(file)}" data-link tabindex="-1" data-file-name="${esc(file.key)}">${esc(fileTitle(file))}</a>`).join("");
  app.innerHTML = `<div class="page home-page">
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">The Sith Order</div>
        <h1 class="hero-title" aria-label="Central Archives"><span>Central</span><span>Archives</span></h1>
        <div class="saber" aria-hidden="true"><span class="saber-hilt"></span><span class="saber-blade"></span></div>
        <p class="hero-lead">${esc(lead)}</p>
        <div class="hero-search-row">
          <form class="hero-search" role="search" id="heroSearch">
            ${SEARCH_ICON}
            <input type="search" placeholder="Search vaults, handbooks, records…" autocomplete="off" aria-label="Search the archives" />
            <kbd aria-hidden="true">/</kbd>
          </form>
          <button type="button" class="hero-random" id="heroRandomButton" title="Open a random document">${RANDOM_ICON}<span>Random record</span></button>
        </div>
        <dl class="hero-stats">
          <div><dt>Vaults</dt><dd data-count="${list.length}">0</dd></div>
          <div><dt>Records</dt><dd data-count="${files.length}">0</dd></div>
          <div><dt>Status</dt><dd class="stat-live">${state.live ? "Unsealed" : "Sealed"}</dd></div>
        </dl>
      </div>
      <button type="button" class="hero-core" id="heroCore" aria-label="Touch the archive core">${HERO_CORE}</button>
    </section>
    ${files.length > 3 ? `<div class="ticker" aria-hidden="true"><div class="ticker-track" style="--ticker-time:${Math.max(36, files.length * 5)}s">${ticker}${ticker}</div></div>` : ""}
    ${spotlight ? `${SABER_RULE("Record of the day")}
    <a class="spotlight" href="${fileHref(spotlight)}" data-link data-prefetch="${esc(spotlight.key)}" data-reveal>
      ${fileThumb(spotlight, "spotlight-art")}
      <div class="spotlight-body">
        <div class="spotlight-top"><span class="eyebrow">${esc(fileVault(spotlight)?.title || KIND[spotlight.kind].label)}</span><span class="spotlight-date">${esc(formatDate(new Date()))}</span></div>
        <h2 data-file-name="${esc(spotlight.key)}">${esc(fileTitle(spotlight))}</h2>
        <p>Drawn from the archive for today. Every acolyte reads the same record until midnight.</p>
        <span class="spotlight-cta">Unseal this record <span aria-hidden="true">→</span></span>
      </div>
    </a>` : ""}
    ${list.length ? `<div id="vaults">${SABER_RULE("The vaults")}</div>
    <section class="vault-index" aria-label="Vaults of the archive">
      ${list.map((page, index) => {
        const previews = page.headings.slice(0, 3).map((heading) => heading.text);
        const fileNames = page.fileKeys.map(fileByKey).filter(Boolean).slice(0, 3 - previews.length).map((file) => fileTitle(file));
        const items = [...previews, ...fileNames].slice(0, 3);
        return `<a class="holo" href="${pageHref(page)}" data-link data-reveal style="--d:${Math.min(index * 70, 420)}ms">
          ${glyph(page.path)}
          <div class="holo-top"><span>Vault ${roman(index + 1)}</span><span>${plural(page.fileKeys.length, "record")}</span></div>
          <h2>${esc(page.title)}</h2>
          <ul>${items.length ? items.map((item) => `<li>${esc(item)}</li>`).join("") : `<li>${esc(page.text.slice(0, 80) || "Awaiting records")}</li>`}</ul>
          <span class="holo-arrow" aria-hidden="true">→</span>
        </a>`;
      }).join("")}
    </section>` : ""}
    ${files.length ? `${SABER_RULE("The codex")}
    <section class="file-grid" aria-label="Records in the archive">${files.slice(0, 6).map((file, index) => fileCard(file, index)).join("")}</section>
    ${files.length > 6 ? `<div class="more-row"><a class="btn" href="/codex" data-link>Open the full codex · ${files.length} records <span aria-hidden="true">→</span></a></div>` : ""}` : ""}
    ${rest.length ? `${SABER_RULE("Inscribed at the gate")}<section class="prose home-prose" data-reveal>${blocksHtml(rest)}</section>` : ""}
  </div>`;
  const search = byId("heroSearch");
  search.addEventListener("submit", (event) => { event.preventDefault(); openSearch(search.querySelector("input").value); });
  search.querySelector("input").addEventListener("focus", () => openSearch(search.querySelector("input").value));
  byId("heroRandomButton").addEventListener("click", jumpToRandomRecord);
  byId("heroCore").addEventListener("click", (event) => coreBurst(event.currentTarget));
  countUp(app);
  afterRender(options);
}
function countUp(root) {
  root.querySelectorAll("[data-count]").forEach((node) => {
    const target = Number(node.dataset.count) || 0;
    if (reducedMotion.matches || !target) { node.textContent = pad(target); return; }
    const begin = performance.now();
    const tick = (now) => { const t = Math.min(1, (now - begin) / 1100); node.textContent = pad(Math.round(target * (1 - Math.pow(1 - t, 3)))); if (t < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}
function jumpToRandomRecord() {
  const files = state.site.files;
  if (!files.length) { droidReact("The codex is empty. For now."); return; }
  let pick = files[Math.floor(Math.random() * files.length)];
  for (let guard = 0; guard < 8 && files.length > 1 && fileHref(pick) === currentPath() + location.search; guard += 1) pick = files[Math.floor(Math.random() * files.length)];
  droidReact("Retrieving a record at random.");
  navigate(fileHref(pick));
}

/* ───────── Vault (a page of the Google Site) ───────── */
function renderVault(page, options) {
  document.title = `${page.title} — TSO Central Archives`;
  const list = vaults();
  const index = list.indexOf(page);
  const shown = new Set(page.blocks.filter((block) => block.type === "file").map((block) => block.key));
  const extra = page.fileKeys.filter((key) => !shown.has(key)).map(fileByKey).filter(Boolean);
  const headings = page.headings.filter((heading) => heading.level <= 3);
  const contents = headings.length > 2;
  const words = page.text.split(/\s+/).filter(Boolean).length;
  const parentPath = page.path.split("/").slice(0, -1).join("/");
  const parent = parentPath ? state.site.pages.find((item) => item.path === parentPath) : null;
  const children = state.site.pages.filter((item) => item.path.startsWith(`${page.path}/`) && item.path.split("/").length === page.path.split("/").length + 1);
  const previous = index > 0 ? list[index - 1] : null;
  const next = index >= 0 && index < list.length - 1 ? list[index + 1] : null;
  app.innerHTML = `<article class="page vault-page">
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/" data-link>Archives</a><span aria-hidden="true">◆</span>${parent ? `<a href="${pageHref(parent)}" data-link>${esc(parent.title)}</a><span aria-hidden="true">◆</span>` : ""}<span>${esc(page.title)}</span></nav>
    <header class="vault-header${page.banner ? " has-banner" : ""}">
      ${page.banner ? `<img class="vault-banner" src="${esc(page.banner)}" alt="" />` : glyph(page.path)}
      <div class="eyebrow">${index >= 0 ? `Vault ${roman(index + 1)}` : "The gate"}</div>
      <h1 data-decrypt>${esc(page.title)}</h1>
      <div class="vault-meta"><span>${plural(page.fileKeys.length, "record")} filed</span>${words > 40 ? `<span>${readingMinutes(words)} min read</span>` : ""}<a href="${esc(page.source)}" target="_blank" rel="noopener">View on Google Sites ↗</a></div>
    </header>
    ${children.length ? `<nav class="subvaults" aria-label="Inner vaults">${children.map((child) => `<a href="${pageHref(child)}" data-link>${esc(child.title)} <span aria-hidden="true">→</span></a>`).join("")}</nav>` : ""}
    <div class="article-layout${contents ? " has-contents" : ""}">
      <div class="prose">${page.blocks.length ? blocksHtml(page.blocks) : `<p class="notice">This vault holds no inscriptions of its own${extra.length ? " — only the records below" : " yet"}.</p>`}</div>
      ${contents ? contentsAside(headings, "In this vault") : ""}
    </div>
    ${extra.length ? `${SABER_RULE(shown.size ? "Also filed here" : "Records in this vault")}<section class="file-grid">${extra.map((file, i) => fileCard(file, i, { hideVault: true })).join("")}</section>` : ""}
    ${(previous || next) ? `<nav class="next-record" aria-label="Adjacent vaults">${previous ? `<a href="${pageHref(previous)}" data-link><small>← Previous vault</small><span>${esc(previous.title)}</span></a>` : "<span></span>"}${next ? `<a class="next" href="${pageHref(next)}" data-link><small>Next vault →</small><span>${esc(next.title)}</span></a>` : ""}</nav>` : ""}
  </article>`;
  afterRender(options);
  if (contents) spyHeadings();
}

/* ───────── Codex: every linked file ───────── */
let codexFilter = { kind: "all", text: "" };
function renderCodex(options) {
  document.title = "Codex — TSO Central Archives";
  const files = state.site.files;
  const kinds = [...new Set(files.map((file) => file.kind))];
  app.innerHTML = `<div class="page codex-page">
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/" data-link>Archives</a><span aria-hidden="true">◆</span><span>Codex</span></nav>
    <header class="vault-header">
      ${glyph("codex")}
      <div class="eyebrow">Every record on file</div>
      <h1 data-decrypt>The Codex</h1>
      <div class="codex-tools">
        <div class="kind-filter" role="group" aria-label="Filter by kind">
          <button type="button" data-kind="all" aria-pressed="true">All <small>${files.length}</small></button>
          ${kinds.length > 1 ? kinds.map((kind) => `<button type="button" data-kind="${kind}" aria-pressed="false">${kindIcon(kind)}${esc(KIND[kind]?.plural || kind)} <small>${files.filter((file) => file.kind === kind).length}</small></button>`).join("") : ""}
        </div>
        ${files.length > 4 ? `<label class="filter">${SEARCH_ICON}<input id="codexFilter" type="search" placeholder="Filter the codex…" autocomplete="off" aria-label="Filter records" /></label>` : ""}
      </div>
    </header>
    <section class="file-grid codex-grid" id="codexGrid">${files.length ? files.map((file, index) => fileCard(file, index)).join("") : `<p class="no-match">No records have been filed in the archive yet.</p>`}</section>
    <p class="no-match" id="codexEmpty" hidden>No records match that filter.</p>
  </div>`;
  const apply = () => {
    let shown = 0;
    app.querySelectorAll("#codexGrid .file-card").forEach((card) => {
      const file = fileByKey(card.dataset.prefetch);
      const vault = fileVault(file)?.title || "";
      const hit = (codexFilter.kind === "all" || file.kind === codexFilter.kind) && (!codexFilter.text || `${fileTitle(file)} ${vault} ${KIND[file.kind]?.label}`.toLowerCase().includes(codexFilter.text));
      card.hidden = !hit; if (hit) shown += 1;
    });
    byId("codexEmpty").hidden = shown > 0 || !files.length;
  };
  app.querySelectorAll(".kind-filter button").forEach((button) => button.addEventListener("click", () => {
    codexFilter.kind = button.dataset.kind;
    app.querySelectorAll(".kind-filter button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    apply();
  }));
  byId("codexFilter")?.addEventListener("input", (event) => { codexFilter.text = event.target.value.trim().toLowerCase(); apply(); });
  codexFilter = { kind: "all", text: "" };
  afterRender(options);
}

/* ───────── Files ───────── */
function fileHeader(file, extra = "") {
  const vault = fileVault(file);
  return `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/" data-link>Archives</a><span aria-hidden="true">◆</span>${vault ? `<a href="${pageHref(vault)}" data-link>${esc(vault.title)}</a>` : `<a href="/codex" data-link>Codex</a>`}<span aria-hidden="true">◆</span><span data-file-name="${esc(file.key)}">${esc(fileTitle(file))}</span></nav>
    <header class="article-header">
      <div class="eyebrow">${kindIcon(file.kind)}${esc(KIND[file.kind]?.label || "File")}${vault ? ` · ${esc(vault.title)}` : ""}</div>
      <h1 data-decrypt data-file-name="${esc(file.key)}">${esc(fileTitle(file))}</h1>
      <div class="article-meta" id="fileMeta">${extra}</div>
    </header>`;
}
function originalUrl(file) {
  const id = encodeURIComponent(file.id);
  const pub = file.pub ? "e/" : "";
  return {
    document: file.pub ? `https://docs.google.com/document/d/e/${id}/pub` : `https://docs.google.com/document/d/${id}/edit`,
    spreadsheets: file.pub ? `https://docs.google.com/spreadsheets/d/e/${id}/pubhtml` : `https://docs.google.com/spreadsheets/d/${id}/edit${file.gid ? `#gid=${file.gid}` : ""}`,
    presentation: `https://docs.google.com/presentation/d/${pub}${id}/${file.pub ? "pub" : "edit"}`,
    forms: `https://docs.google.com/forms/d/${pub}${id}/viewform`,
    drawings: `https://docs.google.com/drawings/d/${id}/edit`,
    file: `https://drive.google.com/file/d/${id}/view`,
    folder: `https://drive.google.com/drive/folders/${id}`
  }[file.kind];
}
const originalLink = (file) => `<a class="meta-action" href="${esc(originalUrl(file))}" target="_blank" rel="noopener">Open in ${esc(KIND[file.kind]?.app || "Google Drive")} ↗</a>`;
function siblingsNav(file) {
  const files = state.site.files;
  const index = files.findIndex((item) => item.key === file.key);
  if (index < 0 || files.length < 2) return "";
  const previous = index > 0 ? files[index - 1] : null;
  const next = index < files.length - 1 ? files[index + 1] : null;
  return `<nav class="next-record" aria-label="Adjacent records">${previous ? `<a href="${fileHref(previous)}" data-link data-prefetch="${esc(previous.key)}"><small>← Previous record</small><span data-file-name="${esc(previous.key)}">${esc(fileTitle(previous))}</span></a>` : "<span></span>"}${next ? `<a class="next" href="${fileHref(next)}" data-link data-prefetch="${esc(next.key)}"><small>Next record →</small><span data-file-name="${esc(next.key)}">${esc(fileTitle(next))}</span></a>` : ""}</nav>`;
}
function renderFile(file, options) {
  document.title = `${fileTitle(file)} — TSO Central Archives`;
  if (file.kind === "document") return renderDoc(file, options);
  if (file.kind === "spreadsheets") return renderSheet(file, options);
  return renderViewer(file, options);
}
const LOADING = (label) => `<div class="decrypting" role="status"><div class="decrypt-core">${glyph("loading")}</div><p>${esc(label)}</p><div class="decrypt-bar"><i></i></div></div>`;
function sealedNotice(file, status) {
  const sealed = status !== "missing";
  return `<div class="sealed">
    <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 5 55 18v28L32 59 9 46V18Z"/><rect x="21" y="29" width="22" height="16" rx="2"/><path d="M25 29v-5a7 7 0 0 1 14 0v5"/></svg>
    <h2>${sealed ? "This record is sealed" : "This record has been struck from the archive"}</h2>
    <p>${sealed ? `Its keeper has not opened it to the archive. Ask them to share it as <em>Anyone with the link can view</em>, or open it in ${esc(KIND[file.kind]?.app || "Google Drive")} if you have clearance.` : "Google no longer holds a file at this reference. It may have been moved or deleted."}</p>
    <a class="btn" href="${esc(originalUrl(file))}" target="_blank" rel="noopener">Try the original ↗</a>
  </div>`;
}

function loadDoc(file) {
  if (docCache.has(file.key)) return docCache.get(file.key).promise;
  const entry = {};
  entry.promise = fetch(`/api/doc?id=${encodeURIComponent(file.id)}${file.pub ? "&pub=1" : ""}`)
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!body.ok) return { error: body.status || (response.status === 404 ? "missing" : response.status === 403 ? "restricted" : "error") };
      const parsed = P.googleDoc(body.html);
      parsed.title = parsed.title || body.title;
      return parsed;
    })
    .catch(() => ({ error: "error" }))
    .then((value) => {
      entry.value = value;
      if (value.error === "error") docCache.delete(file.key); // a network blip is worth retrying
      const known = fileByKey(file.key);
      if (known && value.title && !known.docTitle) { known.docTitle = value.title; refreshFileNames(known); }
      return value;
    });
  docCache.set(file.key, entry);
  return entry.promise;
}

let docScale = 1;
try { docScale = Math.min(1.3, Math.max(.85, Number(localStorage.getItem("tso-archives-scale")) || 1)); } catch {}
async function renderDoc(file, options) {
  const token = state.renderToken;
  app.innerHTML = `<article class="page article-page doc-page">${fileHeader(file, `<span>Decrypting…</span>${originalLink(file)}`)}<div id="docBody">${LOADING("Decrypting the record")}</div></article>`;
  afterRender(options);
  const doc = await loadDoc(file);
  if (token !== state.renderToken) return;
  if (doc.error) {
    byId("fileMeta").innerHTML = originalLink(file);
    byId("docBody").innerHTML = doc.error === "error" ? `<div class="sealed"><h2>The archive could not reach this record</h2><p>Google did not answer in time. Try again in a moment.</p><button class="btn" type="button" id="retryDoc">Try again</button></div>` : sealedNotice(file, doc.error);
    byId("retryDoc")?.addEventListener("click", () => route({ instant: true }));
    return;
  }
  document.title = `${doc.title || fileTitle(file)} — TSO Central Archives`;
  const titleNode = app.querySelector(".article-header h1");
  if (doc.title && titleNode.textContent !== doc.title && !meaningful(file.label)) { titleNode.textContent = doc.title; titleNode.setAttribute("aria-label", doc.title); }
  const contents = doc.headings.length > 2;
  const vault = fileVault(file);
  const related = vault ? vault.fileKeys.map(fileByKey).filter((item) => item && item.key !== file.key).slice(0, 3) : [];
  byId("fileMeta").innerHTML = `<span>${readingMinutes(doc.words)} min read</span><span>${doc.words.toLocaleString("en-GB")} words</span>
    <span class="scale-control" role="group" aria-label="Text size"><button type="button" data-scale="-1" aria-label="Smaller text">A−</button><button type="button" data-scale="1" aria-label="Larger text">A+</button></span>
    <button type="button" class="meta-action" id="copyLink">Copy link</button>${originalLink(file)}`;
  byId("docBody").innerHTML = `<div class="article-layout${contents ? " has-contents" : ""}">
      <div class="prose doc-prose" style="--doc-scale:${docScale}">${doc.html || `<p class="notice">This record is blank.</p>`}</div>
      ${contents ? contentsAside(doc.headings, "In this record") : ""}
    </div>
    ${related.length ? `${SABER_RULE(`More from ${vault.title}`)}<section class="file-grid">${related.map((item, i) => fileCard(item, i, { hideVault: true })).join("")}</section>` : ""}
    ${siblingsNav(file)}`;
  app.querySelectorAll("[data-scale]").forEach((button) => button.addEventListener("click", () => {
    docScale = Math.min(1.3, Math.max(.85, docScale + Number(button.dataset.scale) * .075));
    app.querySelector(".doc-prose").style.setProperty("--doc-scale", docScale);
    try { localStorage.setItem("tso-archives-scale", String(docScale)); } catch {}
  }));
  byId("copyLink").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Link copied to your datapad"); } catch { toast("Copy failed — use the address bar"); }
  });
  const body = byId("docBody");
  bindImageFallbacks(body); observeReveals(body); bindMotion(body);
  if (contents) spyHeadings();
  if (options.hash) byId(decodeURIComponent(options.hash.slice(1)))?.scrollIntoView({ block: "start" });
  updateProgress();
}

async function renderSheet(file, options) {
  const token = state.renderToken;
  app.innerHTML = `<article class="page article-page sheet-page">${fileHeader(file, originalLink(file))}<div id="sheetBody">${LOADING("Opening the ledger")}</div></article>`;
  afterRender(options);
  const base = `/api/sheet?id=${encodeURIComponent(file.id)}${file.pub ? "&pub=1" : ""}`;
  let tabs = [], status = "";
  try {
    const body = await (await fetch(base)).json();
    if (body.ok) tabs = P.sheet(body.html).tabs; else status = body.status || "error";
    if (!tabs.length && status !== "restricted" && status !== "missing") {
      const csvBody = await (await fetch(`${base}&format=csv${file.gid ? `&gid=${file.gid}` : ""}`)).json();
      if (csvBody.ok) { const rows = P.csv(csvBody.csv); if (rows.length) tabs = [{ gid: file.gid || "0", name: "Sheet", rows }]; status = ""; }
      else status = csvBody.status || status;
    }
  } catch { status = "error"; }
  if (token !== state.renderToken) return;
  if (!tabs.length) { byId("sheetBody").innerHTML = sealedNotice(file, status === "missing" ? "missing" : "restricted"); return; }
  let active = Math.max(0, tabs.findIndex((tab) => tab.gid === file.gid));
  let filter = "";
  const paint = () => {
    const tab = tabs[active];
    const [head, ...rows] = tab.rows;
    const matches = filter ? rows.filter((row) => row.some((cell) => cell.text.toLowerCase().includes(filter))) : rows;
    const cell = (item, tag) => `<${tag}>${item.href ? (() => { const link = P.resolveLink(item.href); return link ? `<a href="${esc(link.href)}"${link.internal ? " data-link" : ' target="_blank" rel="noopener"'}>${esc(item.text)}</a>` : esc(item.text); })() : esc(item.text)}</${tag}>`;
    byId("sheetTable").innerHTML = `<table><thead><tr>${head.map((item) => cell(item, "th")).join("")}</tr></thead><tbody>${matches.slice(0, 800).map((row) => `<tr>${row.map((item) => cell(item, "td")).join("")}</tr>`).join("")}</tbody></table>`;
    byId("sheetCount").textContent = `${filter ? `${matches.length} of ` : ""}${plural(rows.length, "row")}${matches.length > 800 ? " · first 800 shown" : ""}`;
    app.querySelectorAll(".sheet-tabs button").forEach((button, index) => button.setAttribute("aria-pressed", String(index === active)));
  };
  byId("sheetBody").innerHTML = `<div class="sheet-tools">
      ${tabs.length > 1 ? `<div class="sheet-tabs kind-filter" role="group" aria-label="Sheets">${tabs.map((tab, index) => `<button type="button" data-tab="${index}" aria-pressed="false">${esc(tab.name)}</button>`).join("")}</div>` : "<span></span>"}
      <label class="filter">${SEARCH_ICON}<input id="sheetFilter" type="search" placeholder="Filter rows…" autocomplete="off" aria-label="Filter rows" /></label>
    </div>
    <p class="sheet-count" id="sheetCount"></p>
    <div class="table-wrap ledger-table" id="sheetTable"></div>
    ${siblingsNav(file)}`;
  app.querySelectorAll(".sheet-tabs button").forEach((button) => button.addEventListener("click", () => { active = Number(button.dataset.tab); paint(); }));
  byId("sheetFilter").addEventListener("input", (event) => { filter = event.target.value.trim().toLowerCase(); paint(); });
  paint();
  updateProgress();
}

function renderViewer(file, options) {
  const id = encodeURIComponent(file.id);
  const pub = file.pub ? "e/" : "";
  const frames = {
    presentation: { src: `https://docs.google.com/presentation/d/${pub}${id}/embed?start=false&loop=false&delayms=6000`, shape: "slides" },
    forms: { src: `https://docs.google.com/forms/d/${pub}${id}/viewform?embedded=true`, shape: "tall" },
    file: { src: `https://drive.google.com/file/d/${id}/preview`, shape: "tall" },
    folder: { src: `https://drive.google.com/embeddedfolderview?id=${id}#grid`, shape: "folder" }
  };
  const frame = frames[file.kind];
  const body = file.kind === "drawings"
    ? `<div class="viewer viewer-image"><button data-zoom="/api/img?u=${encodeURIComponent(`https://docs.google.com/drawings/d/${file.id}/export/png`)}" aria-label="Enlarge drawing"><img src="/api/img?u=${encodeURIComponent(`https://docs.google.com/drawings/d/${file.id}/export/png`)}" alt="${esc(fileTitle(file))}" /></button></div>`
    : `<div class="viewer viewer-${frame.shape}"><span class="viewer-corner" aria-hidden="true"></span><iframe src="${esc(frame.src)}" title="${esc(fileTitle(file))}" loading="lazy" allow="fullscreen" referrerpolicy="no-referrer-when-downgrade"></iframe></div>`;
  app.innerHTML = `<article class="page article-page viewer-page">${fileHeader(file, `<span>Projected from ${esc(KIND[file.kind]?.app || "Google Drive")}</span>${originalLink(file)}`)}
    ${body}
    <p class="viewer-note">If the projection stays dark, the record has not been shared publicly — open it in ${esc(KIND[file.kind]?.app || "Google Drive")} instead.</p>
    ${siblingsNav(file)}
  </article>`;
  afterRender(options);
}

function renderNotFound() {
  document.title = "Record not found — TSO Central Archives";
  app.innerHTML = `<div class="empty-page">${glyph("void")}<h1>Nothing is filed here</h1><p>This reference does not exist in the archive, or it has been struck from the record.</p><a class="btn" href="/" data-link>Return to the archives</a></div>`;
  afterRender();
}

/* ───────── Search ─────────
 * Vault pages are searchable straight away. Document text is pulled in the background the
 * first time search opens (and reused when a document is opened), so full-text matches
 * appear as the index fills. */
let indexing = false;
async function indexDocuments() {
  if (indexing) return;
  const pending = state.site.files.filter((file) => file.kind === "document" && !docCache.get(file.key)?.value);
  if (!pending.length) return;
  indexing = true;
  let done = 0;
  const label = byId("searchIndexing");
  const update = () => { label.textContent = done < pending.length ? `Indexing records ${done}/${pending.length}` : ""; };
  update();
  for (let i = 0; i < pending.length; i += 3) {
    await Promise.all(pending.slice(i, i + 3).map((file) => loadDoc(file).then(() => { done += 1; update(); })));
    if (!byId("searchPanel").hidden && byId("globalSearch").value.trim()) renderSearch(byId("globalSearch").value);
  }
  indexing = false;
  update();
}
function searchItems() {
  const pages = state.site.pages.map((page) => ({ type: "vault", key: `page:${page.path}`, title: page.path ? page.title : `${state.site.name} — gate`, text: page.text, href: pageHref(page), eyebrow: page.path ? "Vault" : "The gate", seed: page.path || "home" }));
  const files = state.site.files.map((file) => ({ type: "file", key: file.key, file, title: fileTitle(file), text: docCache.get(file.key)?.value?.text || "", href: fileHref(file), eyebrow: `${KIND[file.kind]?.label || "File"}${fileVault(file) ? ` · ${fileVault(file).title}` : ""}`, seed: file.key }));
  return [...files, ...pages];
}
function openSearch(prefill) {
  closeMenus();
  const input = byId("globalSearch");
  if (typeof prefill === "string") input.value = prefill;
  byId("searchPanel").hidden = false; document.body.style.overflow = "hidden";
  input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  renderSearch(input.value);
  indexDocuments();
}
function closeSearch() {
  if (byId("searchPanel").hidden) return;
  byId("searchPanel").hidden = true; document.body.style.overflow = ""; byId("globalSearch").value = "";
  const hero = byId("heroSearch")?.querySelector("input");
  if (hero) { hero.value = ""; hero.blur(); }
}
function highlight(text, query) {
  if (!query) return esc(text);
  const at = text.toLowerCase().indexOf(query);
  if (at < 0) return esc(text);
  return `${esc(text.slice(0, at))}<mark>${esc(text.slice(at, at + query.length))}</mark>${esc(text.slice(at + query.length))}`;
}
function snippet(text, query) {
  if (!text) return "";
  const at = query ? text.toLowerCase().indexOf(query) : -1;
  const from = at > 50 ? text.lastIndexOf(" ", at - 50) + 1 : 0;
  return `${from ? "…" : ""}${text.slice(from, from + 150)}`;
}
function renderSearch(query) {
  const value = query.trim().toLowerCase();
  const items = searchItems();
  const rank = (item) => (item.title.toLowerCase().startsWith(value) ? 0 : item.title.toLowerCase().includes(value) ? 1 : item.eyebrow.toLowerCase().includes(value) ? 2 : 3);
  const matches = items.filter((item) => !value || `${item.title} ${item.eyebrow} ${item.text}`.toLowerCase().includes(value)).sort((a, b) => (value ? rank(a) - rank(b) : 0)).slice(0, 40);
  state.searchMatches = matches; state.searchIndex = 0;
  byId("searchCount").textContent = value ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}` : `${plural(items.length, "entry")}`.replace("entrys", "entries");
  byId("searchResults").innerHTML = matches.length ? matches.map((item, index) => `<a class="search-result${index === 0 ? " active" : ""}" href="${item.href}" data-link data-index="${index}">
      <span class="search-thumb">${item.file && canThumb(item.file) ? `<img src="/api/img?thumb=${encodeURIComponent(item.file.id)}" alt="" loading="lazy" />` : glyph(item.seed)}</span>
      <span><small>${item.file ? kindIcon(item.file.kind) : ""}${esc(item.eyebrow)}</small><strong>${highlight(item.title, value)}</strong><p>${highlight(snippet(item.text, value), value)}</p></span>
      <b aria-hidden="true">→</b></a>`).join("") : `<div class="search-empty">Nothing in the archive matches “${esc(query)}”.${indexing ? " Still indexing records…" : ""}</div>`;
  bindImageFallbacks(byId("searchResults"));
}
function moveSearch(step) {
  const items = byId("searchResults").querySelectorAll(".search-result");
  if (!items.length) return;
  state.searchIndex = (state.searchIndex + step + items.length) % items.length;
  items.forEach((item, index) => item.classList.toggle("active", index === state.searchIndex));
  items[state.searchIndex].scrollIntoView({ block: "nearest" });
}

/* ───────── Interaction ───────── */
function closeMenus() {
  byId("mainNav").classList.remove("open"); byId("menuToggle").setAttribute("aria-expanded", "false");
  byId("sectionsPopover").classList.remove("open"); byId("sectionsButton").setAttribute("aria-expanded", "false");
}
function bindImageFallbacks(root) {
  root.querySelectorAll("img").forEach((image) => {
    if (image.dataset.fallbackBound) return;
    image.dataset.fallbackBound = "1";
    image.addEventListener("error", () => {
      const thumb = image.closest(".file-thumb, .search-thumb");
      if (thumb) { thumb.classList.add("is-glyph"); image.replaceWith(document.createRange().createContextualFragment(glyph(thumb.dataset.seed || image.alt || "record"))); return; }
      if (image.classList.contains("vault-banner")) { image.remove(); return; }
      (image.closest("figure") || image).remove();
    }, { once: true });
  });
}
function toast(message) {
  const node = byId("toast");
  node.textContent = message; node.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 4200);
}
function openLightbox(src, caption) { byId("lightboxImage").src = src; byId("lightboxImage").alt = caption; byId("lightboxCaption").textContent = caption; byId("lightboxCaption").hidden = !caption; byId("lightbox").hidden = false; }
function closeLightbox() { byId("lightbox").hidden = true; byId("lightboxImage").removeAttribute("src"); }

document.addEventListener("click", (event) => {
  const anchor = event.target.closest("a[data-link]");
  if (anchor) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault(); navigate(anchor.getAttribute("href")); return;
  }
  const scroller = event.target.closest("a[data-scroll]");
  if (scroller) {
    event.preventDefault();
    const target = byId(decodeURIComponent(scroller.getAttribute("href").slice(1)));
    target?.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" });
    if (target) history.replaceState({}, "", `${location.pathname}${location.search}${scroller.getAttribute("href")}`);
    return;
  }
  const zoom = event.target.closest("[data-zoom]");
  if (zoom) { openLightbox(zoom.dataset.zoom, zoom.dataset.caption || ""); return; }
  if (event.target.closest("#lightbox")) { closeLightbox(); return; }
  if (event.target === byId("searchPanel")) { closeSearch(); return; }
  if (!event.target.closest(".sections-menu")) { byId("sectionsPopover").classList.remove("open"); byId("sectionsButton").setAttribute("aria-expanded", "false"); }
});
/* Hovering a record starts fetching it, so it is usually ready by the time the doors open. */
document.addEventListener("pointerover", (event) => {
  const card = event.target.closest("[data-prefetch]");
  if (!card || card.dataset.prefetched) return;
  card.dataset.prefetched = "1";
  const file = fileByKey(card.dataset.prefetch);
  if (file?.kind === "document") loadDoc(file);
});

let revealObserver = null;
function observeReveals(root) {
  const items = root.querySelectorAll("[data-reveal]");
  if (!("IntersectionObserver" in window) || reducedMotion.matches) { items.forEach((item) => item.classList.add("in")); return; }
  document.documentElement.classList.add("reveal-ready");
  revealObserver ||= new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add("in"); revealObserver.unobserve(entry.target); } }), { rootMargin: "0px 0px -6% 0px" });
  items.forEach((item) => revealObserver.observe(item));
  setTimeout(() => items.forEach((item) => item.classList.add("in")), 1500); // never leave content hidden
}

let headingObserver = null;
function spyHeadings() {
  headingObserver?.disconnect();
  const links = [...app.querySelectorAll(".article-aside a[data-scroll]")];
  if (!links.length || !("IntersectionObserver" in window)) return;
  const activate = (id) => links.forEach((item) => item.classList.toggle("active", item.getAttribute("href") === `#${id}`));
  links[0].classList.add("active");
  headingObserver = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) activate(entry.target.id); }), { rootMargin: "-15% 0px -70% 0px" });
  links.forEach((link) => { const target = byId(decodeURIComponent(link.getAttribute("href").slice(1))); if (target) headingObserver.observe(target); });
}

function bindMotion(root) {
  if (reducedMotion.matches || !matchMedia("(hover: hover)").matches) return;
  root.querySelectorAll(".holo, .file-card").forEach((tile) => {
    tile.addEventListener("pointermove", (event) => {
      const box = tile.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width; const y = (event.clientY - box.top) / box.height;
      tile.style.setProperty("--card-x", `${x * 100}%`); tile.style.setProperty("--card-y", `${y * 100}%`);
      tile.style.setProperty("--tilt-x", `${(x - .5) * 6}deg`); tile.style.setProperty("--tilt-y", `${(.5 - y) * 6}deg`);
    });
    tile.addEventListener("pointerleave", () => { tile.style.setProperty("--tilt-x", "0deg"); tile.style.setProperty("--tilt-y", "0deg"); });
  });
}

/* Titles arrive "encrypted" and resolve left to right, as if being decoded by the archive.
 * The real title is set as aria-label first, so assistive tech never hears the noise. */
const CIPHER = "ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ⟁⟒⌖⏃⏚⎅⟟⊑⋏⍀⎍⏁⌇";
function decryptTitles(root) {
  if (reducedMotion.matches) return;
  root.querySelectorAll("[data-decrypt]").forEach((node) => {
    const text = node.textContent;
    if (!text || text.length > 90) return;
    node.setAttribute("aria-label", text);
    const begin = performance.now();
    const duration = Math.min(1100, 380 + text.length * 22);
    const tick = (now) => {
      if (node.getAttribute("aria-label") !== text) return; // renamed meanwhile (a document's real title arrived)
      const t = Math.min(1, (now - begin) / duration);
      const settled = Math.floor(text.length * t);
      node.textContent = text.slice(0, settled) + [...text.slice(settled)].map((char) => (char === " " ? " " : CIPHER[Math.floor(Math.random() * CIPHER.length)])).join("");
      if (t < 1) requestAnimationFrame(tick); else node.textContent = text;
    };
    requestAnimationFrame(tick);
  });
}

/* ───────── Force lightning ─────────
 * Press and hold on any empty stretch of the archive (not on text or controls) to channel
 * lightning from the pointer; the archive core on the home page discharges on touch; and
 * typing the word "power" anywhere outside a text field calls down a full storm. Bolts are
 * jagged polylines made by midpoint displacement, redrawn every frame with a fading life. */
const lightningCanvas = byId("lightning");
const lctx = lightningCanvas.getContext("2d");
const bolts = [];
let lightningLoop = false;
const channel = { active: false, x: 0, y: 0, timer: 0, holdTimer: 0, pointerId: null, startX: 0, startY: 0 };
function resizeLightning() {
  const ratio = Math.min(devicePixelRatio || 1, 2);
  lightningCanvas.width = innerWidth * ratio; lightningCanvas.height = innerHeight * ratio;
  lctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}
resizeLightning();
window.addEventListener("resize", resizeLightning, { passive: true });
function boltPath(x1, y1, x2, y2, spread, depth = 0) {
  if (depth > 6 || Math.hypot(x2 - x1, y2 - y1) < 10) return [[x1, y1], [x2, y2]];
  const mx = (x1 + x2) / 2 + (Math.random() - .5) * spread;
  const my = (y1 + y2) / 2 + (Math.random() - .5) * spread;
  return [...boltPath(x1, y1, mx, my, spread / 2, depth + 1).slice(0, -1), ...boltPath(mx, my, x2, y2, spread / 2, depth + 1)];
}
function strike(x1, y1, x2, y2, options = {}) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const main = { points: boltPath(x1, y1, x2, y2, Math.min(160, length * .38)), life: 1, decay: options.decay || (.07 + Math.random() * .05), width: options.width || 1.8 };
  bolts.push(main);
  const branches = perf.lite ? 0 : 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < branches; i += 1) {
    const from = main.points[Math.floor(main.points.length * (.25 + Math.random() * .5))];
    const angle = Math.atan2(y2 - y1, x2 - x1) + (Math.random() - .5) * 1.6;
    const reach = length * (.2 + Math.random() * .3);
    bolts.push({ points: boltPath(from[0], from[1], from[0] + Math.cos(angle) * reach, from[1] + Math.sin(angle) * reach, reach * .4), life: .9, decay: main.decay * 1.3, width: main.width * .55 });
  }
  if (!lightningLoop) { lightningLoop = true; requestAnimationFrame(drawLightning); }
}
function drawLightning() {
  lctx.clearRect(0, 0, innerWidth, innerHeight);
  lctx.lineJoin = "round"; lctx.lineCap = "round";
  for (let i = bolts.length - 1; i >= 0; i -= 1) {
    const bolt = bolts[i];
    bolt.life -= bolt.decay;
    if (bolt.life <= 0) { bolts.splice(i, 1); continue; }
    const flicker = bolt.life * (.65 + Math.random() * .35);
    const trace = () => { lctx.beginPath(); bolt.points.forEach(([x, y], index) => (index ? lctx.lineTo(x, y) : lctx.moveTo(x, y))); lctx.stroke(); };
    if (!perf.lite) { lctx.shadowColor = "rgba(150,130,255,.9)"; lctx.shadowBlur = 18; }
    lctx.strokeStyle = `rgba(140,120,255,${(flicker * .55).toFixed(3)})`; lctx.lineWidth = bolt.width * 3.2; trace();
    lctx.shadowBlur = 0;
    lctx.strokeStyle = `rgba(235,232,255,${flicker.toFixed(3)})`; lctx.lineWidth = bolt.width; trace();
  }
  if (bolts.length || channel.active) requestAnimationFrame(drawLightning);
  else { lightningLoop = false; lctx.clearRect(0, 0, innerWidth, innerHeight); }
}
function channelTargets(x, y) {
  const near = [...document.querySelectorAll(".holo, .file-card, .hero-core, .spotlight, .brand, .droid")]
    .map((el) => el.getBoundingClientRect())
    .filter((box) => box.width && box.bottom > 0 && box.top < innerHeight)
    .map((box) => [box.left + box.width * (.2 + Math.random() * .6), box.top + box.height * (.2 + Math.random() * .6)])
    .filter(([tx, ty]) => Math.hypot(tx - x, ty - y) < 460);
  return near;
}
function channelTick() {
  if (!channel.active) return;
  const targets = channelTargets(channel.x, channel.y);
  const count = perf.lite ? 1 : 2;
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2, reach = 140 + Math.random() * 260;
    const [tx, ty] = targets.length && Math.random() > .35 ? targets[Math.floor(Math.random() * targets.length)] : [channel.x + Math.cos(angle) * reach, channel.y + Math.sin(angle) * reach];
    strike(channel.x, channel.y, tx, ty);
  }
  channel.timer = setTimeout(channelTick, perf.lite ? 140 : 70);
}
const NOT_A_CHANNEL = "a, button, input, textarea, select, label, iframe, .prose, p, h1, h2, h3, h4, li, td, th, dd, .search-panel, .lightbox, .droid, .sections-popover, .ticker";
document.addEventListener("pointerdown", (event) => {
  if (reducedMotion.matches || event.button !== 0 || event.target.closest(NOT_A_CHANNEL)) return;
  channel.pointerId = event.pointerId; channel.startX = channel.x = event.clientX; channel.startY = channel.y = event.clientY;
  clearTimeout(channel.holdTimer);
  channel.holdTimer = setTimeout(() => {
    channel.active = true;
    document.documentElement.classList.add("channeling");
    droidReact(Math.random() > .5 ? "Unlimited power!" : "Let the hate flow through you.");
    if (!lightningLoop) { lightningLoop = true; requestAnimationFrame(drawLightning); }
    channelTick();
  }, 320);
});
document.addEventListener("pointermove", (event) => {
  if (event.pointerId !== channel.pointerId) return;
  channel.x = event.clientX; channel.y = event.clientY;
  if (!channel.active && Math.hypot(channel.x - channel.startX, channel.y - channel.startY) > 10) clearTimeout(channel.holdTimer);
}, { passive: true });
const endChannel = () => { clearTimeout(channel.holdTimer); clearTimeout(channel.timer); channel.active = false; channel.pointerId = null; document.documentElement.classList.remove("channeling"); };
document.addEventListener("pointerup", endChannel);
document.addEventListener("pointercancel", endChannel);
window.addEventListener("blur", endChannel);

function coreBurst(core) {
  if (reducedMotion.matches) { droidReact("The core hums. Quietly."); return; }
  const box = core.getBoundingClientRect();
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  core.classList.remove("discharge"); void core.offsetWidth; core.classList.add("discharge");
  for (let i = 0; i < (perf.lite ? 3 : 7); i += 1) {
    const angle = (i / 7) * Math.PI * 2 + Math.random() * .6;
    const reach = box.width * (.55 + Math.random() * .5);
    setTimeout(() => strike(cx, cy, cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach, { width: 2.2 }), i * 45);
  }
  coreBurst.count = (coreBurst.count || 0) + 1;
  droidReact(coreBurst.count % 3 === 0 ? "Careful. The core remembers every touch." : "The archive core stirs.");
  skyFlash(.5);
}
function forceStorm() {
  if (reducedMotion.matches) return;
  document.body.classList.remove("quake"); void document.body.offsetWidth; document.body.classList.add("quake");
  droidReact("UNLIMITED POWER!");
  skyFlash(1);
  const total = perf.lite ? 6 : 16;
  for (let i = 0; i < total; i += 1) {
    setTimeout(() => {
      const x = Math.random() * innerWidth;
      strike(x + (Math.random() - .5) * 200, -10, x + (Math.random() - .5) * 300, innerHeight * (.45 + Math.random() * .55), { width: 2.6, decay: .045 });
    }, i * 85 + Math.random() * 60);
  }
  setTimeout(() => document.body.classList.remove("quake"), 1600);
}
let typed = "";
document.addEventListener("keydown", (event) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") || event.key.length !== 1) return;
  typed = (typed + event.key.toLowerCase()).slice(-5);
  if (typed === "power") { typed = ""; forceStorm(); }
});
function skyFlash(strength = .6) {
  if (reducedMotion.matches || perf.lite) return;
  const flash = byId("sceneFlash");
  flash.style.setProperty("--flash", strength);
  flash.classList.remove("on"); void flash.offsetWidth; flash.classList.add("on");
}
/* Distant lightning behind the clouds, every so often. */
function scheduleSkyFlash() {
  setTimeout(() => { if (!document.hidden) skyFlash(.25 + Math.random() * .35); scheduleSkyFlash(); }, 9000 + Math.random() * 16000);
}

/* ───────── Interrogator droid ─────────
 * A small mascot wired once here rather than per page. Its lens colour follows the sync
 * state (see updateSyncLabel). On larger screens it patrols the viewport perimeter; pointer
 * events make it draggable with mouse or touch. */
const DROID_QUIPS = [
  "The archives remember everything.",
  "Knowledge is power. Power is victory.",
  "I have interrogated worse documents than these.",
  "Your reading habits have been logged.",
  "Peace is a lie. There is only reading.",
  "Do not dog-ear the holocrons.",
  "Every record here was earned in blood. And formatting.",
  "Hold still on an empty spot. Feel the power.",
  "Type “power”. I dare you.",
];
let droidBubbleTimer;
const droidMotion = { x: 0, y: 0, pointerId: null, offsetX: 0, offsetY: 0, startX: 0, startY: 0, dragged: false, suppressClick: false, patrolIndex: 0, patrolTimer: 0, resumeTimer: 0 };
function showDroidBubble(text) {
  const bubble = byId("droidBubble");
  bubble.textContent = text;
  bubble.classList.add("show");
  clearTimeout(droidBubbleTimer);
  droidBubbleTimer = setTimeout(() => bubble.classList.remove("show"), 2800);
}
function droidReact(line) {
  const droid = byId("droid");
  droid.classList.remove("startled"); void droid.offsetWidth; droid.classList.add("startled");
  showDroidBubble(line || DROID_QUIPS[Math.floor(Math.random() * DROID_QUIPS.length)]);
}
function droidLimits() {
  const droid = byId("droid");
  const margin = innerWidth <= 760 ? 10 : 18;
  const headerBottom = byId("siteHeader")?.getBoundingClientRect().bottom || 0;
  return { minX: margin, maxX: Math.max(margin, innerWidth - droid.offsetWidth - margin), minY: Math.max(margin, headerBottom + 12), maxY: Math.max(margin, innerHeight - droid.offsetHeight - margin) };
}
function placeDroid(x, y, duration = 0) {
  const droid = byId("droid");
  const limits = droidLimits();
  const next = { x: Math.min(limits.maxX, Math.max(limits.minX, x)), y: Math.min(limits.maxY, Math.max(Math.min(limits.minY, limits.maxY), y)) };
  droidMotion.x = next.x; droidMotion.y = next.y;
  droid.style.setProperty("--droid-travel", `${duration}s`);
  droid.style.setProperty("--droid-x", `${next.x}px`);
  droid.style.setProperty("--droid-y", `${next.y}px`);
  droid.dataset.side = next.x + droid.offsetWidth / 2 < innerWidth / 2 ? "left" : "right";
  droid.dataset.vertical = next.y + droid.offsetHeight / 2 < innerHeight / 2 ? "top" : "bottom";
}
function droidWaypoints() {
  const { minX, maxX, minY, maxY } = droidLimits();
  const span = Math.max(0, maxY - minY);
  return [{ x: maxX, y: maxY }, { x: maxX, y: minY + span * .5 }, { x: maxX, y: minY }, { x: minX, y: minY }, { x: minX, y: minY + span * .5 }, { x: minX, y: maxY }];
}
function stopDroidPatrol() { clearTimeout(droidMotion.patrolTimer); clearTimeout(droidMotion.resumeTimer); }
function scheduleDroidPatrol(delay = 4200) {
  clearTimeout(droidMotion.patrolTimer);
  if (reducedMotion.matches || innerWidth <= 760 || droidMotion.pointerId !== null || document.hidden) return;
  droidMotion.patrolTimer = setTimeout(() => {
    const points = droidWaypoints();
    droidMotion.patrolIndex = (droidMotion.patrolIndex + 1) % points.length;
    const next = points[droidMotion.patrolIndex];
    const duration = Math.min(10, Math.max(5, Math.hypot(next.x - droidMotion.x, next.y - droidMotion.y) / 82));
    placeDroid(next.x, next.y, duration);
    scheduleDroidPatrol(duration * 1000 + 2600 + Math.random() * 2200);
  }, delay);
}
function resumeDroidPatrol(delay = 14000) { clearTimeout(droidMotion.resumeTimer); droidMotion.resumeTimer = setTimeout(() => scheduleDroidPatrol(0), delay); }
function persistDroidPosition() {
  const limits = droidLimits();
  const width = Math.max(1, limits.maxX - limits.minX); const height = Math.max(1, limits.maxY - limits.minY);
  try { localStorage.setItem("tso-archives-droid-v1", JSON.stringify({ x: (droidMotion.x - limits.minX) / width, y: (droidMotion.y - limits.minY) / height })); } catch {}
}
function initDroid() {
  const droid = byId("droid");
  const limits = droidLimits();
  let initial = { x: limits.maxX, y: limits.maxY };
  try {
    const saved = JSON.parse(localStorage.getItem("tso-archives-droid-v1") || "null");
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) initial = { x: limits.minX + (limits.maxX - limits.minX) * saved.x, y: limits.minY + (limits.maxY - limits.minY) * saved.y };
  } catch {}
  placeDroid(initial.x, initial.y);
  droid.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const box = droid.getBoundingClientRect();
    stopDroidPatrol();
    droidMotion.pointerId = event.pointerId; droidMotion.dragged = false;
    droidMotion.startX = event.clientX; droidMotion.startY = event.clientY;
    droidMotion.offsetX = event.clientX - box.left; droidMotion.offsetY = event.clientY - box.top;
    droid.classList.add("is-dragging");
    droid.setPointerCapture(event.pointerId);
    placeDroid(box.left, box.top);
  });
  droid.addEventListener("pointermove", (event) => {
    if (event.pointerId !== droidMotion.pointerId) return;
    if (Math.hypot(event.clientX - droidMotion.startX, event.clientY - droidMotion.startY) > 5) droidMotion.dragged = true;
    placeDroid(event.clientX - droidMotion.offsetX, event.clientY - droidMotion.offsetY);
  });
  const release = (event) => {
    if (event.pointerId !== droidMotion.pointerId) return;
    if (droid.hasPointerCapture(event.pointerId)) droid.releasePointerCapture(event.pointerId);
    droid.classList.remove("is-dragging");
    droidMotion.pointerId = null;
    if (droidMotion.dragged) {
      droidMotion.suppressClick = true;
      persistDroidPosition();
      showDroidBubble("New post acknowledged. Resuming watch shortly.");
      setTimeout(() => { droidMotion.suppressClick = false; }, 500);
    }
    resumeDroidPatrol();
  };
  droid.addEventListener("pointerup", release);
  droid.addEventListener("pointercancel", release);
  droid.addEventListener("click", () => { if (!droidMotion.suppressClick) droidReact(); });
  window.addEventListener("resize", () => { placeDroid(droidMotion.x, droidMotion.y); scheduleDroidPatrol(2400); }, { passive: true });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopDroidPatrol(); else scheduleDroidPatrol(2200); });
  scheduleDroidPatrol();
}

/* ───────── Performance guard ─────────
 * Everyone starts on the full version. Shortly after the first page renders we sample real
 * frame timing for ~1.5s of visible time, and only if the page is consistently choppy does it
 * switch to a lighter mode for the rest of the tab session: the blurred drifting glows become
 * static gradients, the embers and grain stop, and lightning loses its glow. The footer switch
 * lets anyone pick either mode; that choice is remembered and always beats the automatic check.
 * ?fx=lite / ?fx=full force either mode for the current tab. */
const perf = { lite: false, decided: false, resumeAtmosphere: null };
const FX_SESSION = "tso-fx";
const FX_PREF = "tso-fx-pref";
function setFxMode(lite) {
  perf.lite = lite;
  document.documentElement.classList.toggle("fx-lite", lite);
  byId("fxToggle").setAttribute("aria-checked", String(lite));
  byId("fxToggleState").textContent = lite ? "Lite" : "Full";
  if (!lite) perf.resumeAtmosphere?.();
}
function autoSwitchToLite() {
  perf.decided = true;
  setFxMode(true);
  try { sessionStorage.setItem(FX_SESSION, "lite"); } catch {}
  toast("Lighter effects on for smoother performance — switch back in the footer");
}
function applyChosenFxMode() {
  let mode = new URLSearchParams(location.search).get("fx");
  try {
    if (mode === "lite" || mode === "full") sessionStorage.setItem(FX_SESSION, mode);
    else mode = localStorage.getItem(FX_PREF) || sessionStorage.getItem(FX_SESSION);
  } catch {}
  if (mode !== "lite" && mode !== "full") return;
  perf.decided = true;
  setFxMode(mode === "lite");
}
function toggleFxMode() {
  const lite = !perf.lite;
  perf.decided = true;
  setFxMode(lite);
  try { localStorage.setItem(FX_PREF, lite ? "lite" : "full"); } catch {}
}
function framesAreChoppy(samples) {
  if (samples.length < 3) return false;
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const slowShare = samples.filter((ms) => ms > 50).length / samples.length;
  return median > 40 || slowShare >= .25;
}
function watchFrameRate() {
  if (perf.decided) return;
  const samples = [];
  let last = 0, measured = 0;
  const forgetGap = () => { last = 0; };
  document.addEventListener("visibilitychange", forgetGap);
  const tick = (now) => {
    if (last) { samples.push(now - last); measured += now - last; }
    last = now;
    if (measured < 1500) { requestAnimationFrame(tick); return; }
    document.removeEventListener("visibilitychange", forgetGap);
    if (!perf.decided && framesAreChoppy(samples)) autoSwitchToLite();
  };
  requestAnimationFrame(tick);
}

/* ───────── Atmosphere ─────────
 * Embers rise from the bottom of the archive, sway, flicker, and scatter away from the
 * pointer; the crimson aura follows the cursor and the hero core tilts toward it. */
function createAtmosphere() {
  if (reducedMotion.matches) return;
  let frame = 0;
  const pointer = { x: -999, y: -999 };
  window.addEventListener("pointermove", (event) => {
    pointer.x = event.clientX; pointer.y = event.clientY;
    if (frame || perf.lite) return;
    frame = requestAnimationFrame(() => {
      const root = document.documentElement.style;
      root.setProperty("--pointer-x", `${pointer.x}px`); root.setProperty("--pointer-y", `${pointer.y}px`);
      const core = byId("heroCore");
      if (core) { core.style.setProperty("--sx", `${(pointer.x / innerWidth - .5) * 18}deg`); core.style.setProperty("--sy", `${(.5 - pointer.y / innerHeight) * 14}deg`); }
      frame = 0;
    });
  }, { passive: true });

  const canvas = byId("embers"); const context = canvas?.getContext("2d");
  if (!context) return;
  const colors = ["255,72,64", "255,138,61", "227,38,47", "255,196,150", "157,140,255"];
  let width = 0, height = 0, embers = [], running = true, looping = false;
  const spawn = (anywhere) => ({ x: Math.random() * width, y: anywhere ? Math.random() * height : height + 10, vx: 0, size: .6 + Math.random() * 1.8, speed: .25 + Math.random() * .7, sway: Math.random() * Math.PI * 2, swaySpeed: .004 + Math.random() * .014, alpha: .25 + Math.random() * .55, color: colors[Math.random() < .08 ? 4 : Math.floor(Math.random() * 4)] });
  const resize = () => {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    width = innerWidth; height = innerHeight;
    canvas.width = width * ratio; canvas.height = height * ratio; context.setTransform(ratio, 0, 0, ratio, 0, 0);
    embers = Array.from({ length: Math.round(Math.min(70, Math.max(24, width / 22))) }, () => spawn(true));
  };
  const draw = () => {
    context.clearRect(0, 0, width, height);
    if (!running || perf.lite) { looping = false; return; }
    looping = true;
    for (const ember of embers) {
      const dx = ember.x - pointer.x, dy = ember.y - pointer.y, distance = Math.hypot(dx, dy);
      if (distance < 120 && distance > 0) ember.vx += (dx / distance) * (120 - distance) * .004;
      ember.vx *= .94;
      ember.y -= ember.speed; ember.sway += ember.swaySpeed; ember.x += Math.sin(ember.sway) * .35 + ember.vx;
      if (ember.y < -12 || ember.x < -20 || ember.x > width + 20) Object.assign(ember, spawn(false));
      const fade = Math.min(1, ember.y / (height * .35)) * ember.alpha * (.6 + Math.sin(ember.sway * 4) * .4);
      const halo = context.createRadialGradient(ember.x, ember.y, 0, ember.x, ember.y, ember.size * 5);
      halo.addColorStop(0, `rgba(${ember.color},${(fade * .4).toFixed(3)})`); halo.addColorStop(1, `rgba(${ember.color},0)`);
      context.fillStyle = halo;
      context.beginPath(); context.arc(ember.x, ember.y, ember.size * 5, 0, Math.PI * 2); context.fill();
      context.fillStyle = `rgba(${ember.color},${fade.toFixed(3)})`;
      context.beginPath(); context.arc(ember.x, ember.y, ember.size, 0, Math.PI * 2); context.fill();
    }
    requestAnimationFrame(draw);
  };
  perf.resumeAtmosphere = () => { if (running && !looping) draw(); };
  resize(); draw();
  window.addEventListener("resize", resize, { passive: true });
  document.addEventListener("visibilitychange", () => { running = !document.hidden; perf.resumeAtmosphere(); });
  scheduleSkyFlash();
}

document.addEventListener("pointerdown", (event) => {
  if (reducedMotion.matches || event.button !== 0) return;
  const target = event.target.closest(".btn, .search-trigger, .holo, .file-card, .next-record a, .hero-random, .spotlight");
  if (!target) return;
  target.classList.add("ripple-host");
  const box = target.getBoundingClientRect();
  const ripple = document.createElement("span");
  ripple.className = "click-ripple";
  ripple.style.left = `${event.clientX - box.left}px`; ripple.style.top = `${event.clientY - box.top}px`;
  target.appendChild(ripple);
  ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
});

function updateProgress() {
  const max = document.documentElement.scrollHeight - innerHeight;
  byId("readingProgress").style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
  byId("siteHeader").classList.toggle("scrolled", scrollY > 12);
}
window.addEventListener("scroll", updateProgress, { passive: true });

/* ───────── Boot ───────── */
byId("menuToggle").addEventListener("click", () => { const open = byId("mainNav").classList.toggle("open"); byId("menuToggle").setAttribute("aria-expanded", String(open)); });
byId("sectionsButton").addEventListener("click", () => { const open = byId("sectionsPopover").classList.toggle("open"); byId("sectionsButton").setAttribute("aria-expanded", String(open)); });
byId("searchTrigger").addEventListener("click", () => openSearch());
byId("randomButton").addEventListener("click", jumpToRandomRecord);
byId("fxToggle").addEventListener("click", toggleFxMode);
byId("closeSearch").addEventListener("click", closeSearch);
byId("globalSearch").addEventListener("input", (event) => renderSearch(event.target.value));
byId("globalSearch").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") { event.preventDefault(); moveSearch(1); }
  if (event.key === "ArrowUp") { event.preventDefault(); moveSearch(-1); }
  if (event.key === "Enter") { const item = state.searchMatches[state.searchIndex]; if (item) { event.preventDefault(); navigate(item.href); } }
});
document.addEventListener("keydown", (event) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
  if ((event.key === "/" && !typing && !event.metaKey && !event.ctrlKey) || (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey))) { event.preventDefault(); openSearch(); }
  if (event.key === "Escape") { closeLightbox(); closeSearch(); closeMenus(); }
});
window.addEventListener("popstate", () => route({ hash: location.hash }));
applyChosenFxMode();
createAtmosphere();
initDroid();
start();
