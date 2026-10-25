/* TSO Central Archives — client
 * Content comes from /api/site (the Worker's live read of the Order's Google Site) and is
 * re-checked on a timer, so a page published on Google Sites appears here without a reload.
 * Every Google Doc the site links to or embeds opens here as a page of its own (/api/doc);
 * Sheets become tables, and Slides, Forms and Drive files open in a framed viewer.
 *
 * The archive is laid out like one: an index rail down the left, an orrery of vaults around
 * the archive core at the gate, records kept as holocrons in the vault, documents opened as
 * dossiers with a chapter scrubber, a card catalogue, and a terminal for queries. */

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
  document: { label: "Document", plural: "Documents", short: "Doc", app: "Google Docs" },
  spreadsheets: { label: "Spreadsheet", plural: "Spreadsheets", short: "Sheet", app: "Google Sheets" },
  presentation: { label: "Slides", plural: "Slide decks", short: "Deck", app: "Google Slides" },
  forms: { label: "Form", plural: "Forms", short: "Form", app: "Google Forms" },
  drawings: { label: "Drawing", plural: "Drawings", short: "Draw", app: "Google Drawings" },
  file: { label: "File", plural: "Files", short: "File", app: "Google Drive" },
  folder: { label: "Folder", plural: "Folders", short: "Folder", app: "Google Drive" }
};
const GENERIC_LABEL = /^(open|view|link|here|click here|click|document|doc|file|read|read more|more|go|visit|download|preview|open document|view document|\d+)$/i;

const state = { site: null, signature: "", lastSync: 0, live: false, searchIndex: 0, searchMatches: [], renderToken: 0 };
const docCache = new Map();
const app = document.getElementById("app");
const byId = (id) => document.getElementById(id);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const narrow = matchMedia("(max-width: 960px)");
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
  for (const file of raw.files || []) files.set(file.key, { ...file, docTitle: docCache.get(file.key)?.value?.title || "", order: files.size });
  const pages = raw.pages.map((page, index) => {
    const parsed = P.sitePage(page.html || "", { title: page.title, siteName: raw.name });
    // Embedded files with no name of their own borrow the label they were given on the page.
    for (const block of parsed.blocks) {
      if (block.type !== "file") continue;
      // The Worker may know this file under a more specific kind (an embed's Drive link vs its Docs preview).
      if (!files.has(block.key)) { const same = [...files.values()].find((file) => file.id === block.ref.id); if (same) { block.key = same.key; block.ref = { ...block.ref, kind: same.kind, pub: same.pub }; } }
      if (!files.has(block.key)) files.set(block.key, { key: block.key, kind: block.ref.kind, id: block.ref.id, pub: block.ref.pub, gid: block.ref.gid || "", label: block.label, title: "", pages: [page.path], docTitle: "", order: files.size });
      const file = files.get(block.key);
      if (!file.label && block.label) file.label = block.label;
      if (!file.pages.includes(page.path)) file.pages.push(page.path);
    }
    return { ...page, index, ...parsed, fileKeys: [...new Set([...parsed.blocks.filter((block) => block.type === "file").map((block) => block.key), ...(page.files || [])])] };
  });
  const site = { ...raw, name: (raw.name || "TSO Central Archives").trim(), pages, files: [...files.values()] };
  Object.assign(site, buildTree(raw.nav, pages));
  site.signature = signatureOf(raw);
  return site;
}

/* The archive mirrors the Google Site's own menu: its tabs become sections (I, II, III…) and
 * the pages in each tab's dropdown sit inside them (II.1, II.2…). A dropdown tab that isn't a
 * page of its own (Google draws it as a link with no address) becomes a section page here. Links in the menu that leave
 * the site keep their place. Pages that aren't in the menu hang under the page their address
 * sits beneath, or join the end. Without a menu (an older Worker) the addresses alone decide. */
function buildTree(nav, pages) {
  const byPath = new Map(pages.map((page) => [page.path, page]));
  const roots = [];
  const nodes = new Map();
  const groups = new Map();
  const stack = [];
  for (const item of Array.isArray(nav) ? nav : []) {
    if (item.path === "") continue; // the home page is the gate itself
    if (item.path !== undefined && !byPath.has(item.path)) continue;
    if (item.path === undefined && !item.group && !/^https?:\/\//i.test(item.href || "")) continue;
    if (item.path !== undefined && nodes.has(item.path)) continue;
    const node = { page: item.path !== undefined ? byPath.get(item.path) : null, group: Boolean(item.group), href: item.group ? "" : item.href || "", label: item.label || "", level: Math.max(1, Number(item.level) || 1), children: [], parent: null };
    if (node.group) { let base = P.slug(node.label), key = base, n = 2; while (groups.has(key)) key = `${base}-${n++}`; node.slug = key; groups.set(key, node); }
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    node.parent = stack[stack.length - 1] || null;
    if (node.parent) node.level = node.parent.level + 1;
    (node.parent ? node.parent.children : roots).push(node);
    stack.push(node);
    if (node.page) nodes.set(node.page.path, node);
  }
  const unlisted = pages.filter((page) => page.path && !nodes.has(page.path)).sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  for (const page of unlisted) {
    let parentPath = page.path.split("/").slice(0, -1).join("/");
    // A page's address can also sit under a dropdown tab's name (pathways/… under "Pathways").
    while (parentPath && !nodes.has(parentPath) && !groups.has(parentPath)) parentPath = parentPath.split("/").slice(0, -1).join("/");
    const parent = parentPath ? nodes.get(parentPath) || groups.get(parentPath) : null;
    const node = { page, href: "", label: page.title, level: parent ? parent.level + 1 : 1, children: [], parent };
    (parent ? parent.children : roots).push(node);
    nodes.set(page.path, node);
  }
  const prune0 = (list) => { for (let i = list.length - 1; i >= 0; i -= 1) { prune0(list[i].children); if (list[i].group && !list[i].children.length) { groups.delete(list[i].slug); list.splice(i, 1); } } return list; };
  const order = [];
  const number = (list, prefix) => {
    let count = 0;
    for (const node of list) {
      if (node.page || node.group) { count += 1; node.numeral = prefix ? `${prefix}.${count}` : roman(count); }
      if (node.page) { node.page.node = node; order.push(node.page); }
      number(node.children, node.numeral || prefix);
    }
  };
  number(prune0(roots), "");
  return { tree: roots, order, groups };
}

async function start() {
  try {
    state.site = await loadSite();
    state.live = true;
  } catch (error) {
    console.error("Central Archives: could not load the site", error);
    state.site = prepareSite(fallback);
    state.live = false;
  }
  state.signature = state.site.signature;
  state.lastSync = Date.now();
  renderRail();
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
      renderRail();
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

function syncAgo() {
  const seconds = Math.round((Date.now() - state.lastSync) / 1000);
  return seconds < 45 ? "just now" : seconds < 3600 ? `${Math.round(seconds / 60)} min ago` : `${Math.round(seconds / 3600)} h ago`;
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
  byId("syncStatus").textContent = state.live ? "Live" : "Reconnecting";
  byId("footerSync").textContent = state.live ? `Synced ${syncAgo()}` : `Unreachable · last synced ${syncAgo()}`;
}

/* Files the site never named (a bare embed, or a link that just says "here") get their real
 * title from Google, a few at a time, and every place showing them is updated in place. */
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
  document.querySelectorAll(`[data-file-name="${CSS.escape(file.key)}"]`).forEach((node) => {
    node.textContent = fileTitle(file);
    if (node.hasAttribute("aria-label")) node.setAttribute("aria-label", fileTitle(file));
  });
}

/* ───────── Helpers ───────── */
function currentPath() { return location.pathname; }
const homePage = () => state.site.pages.find((page) => page.path === "") || state.site.pages[0];
const vaults = () => state.site.order;
const pageHref = (page) => (page.path ? `/p/${page.path}` : "/");
const fileHref = (file) => P.fileRoute(file);
const fileByKey = (key) => state.site.files.find((file) => file.key === key);
const depthOf = (page) => Math.max(0, (page.node?.level || 1) - 1);
const nodeTitle = (node) => node.page?.title || node.label;
const nodeHref = (node) => (node.page ? pageHref(node.page) : node.group ? `/s/${node.slug}` : node.href);
const nodeKey = (node) => (node.page ? node.page.path : node.group ? `s:${node.slug}` : node.href);
const rootOf = (page) => { let node = page?.node; while (node?.parent) node = node.parent; return node || null; };
const ancestorNodes = (node) => { const chain = []; let item = node?.parent; while (item) { chain.unshift(item); item = item.parent; } return chain; };
const ancestors = (page) => ancestorNodes(page?.node);
const crumbTrail = (node) => [...ancestorNodes(node), node].map((item) => ({ href: nodeHref(item), label: nodeTitle(item) }));
const trail = (page) => (page?.node ? [...ancestors(page), page.node].map(nodeTitle).join(" › ") : page?.title || "");
function subtreeFiles(node) {
  const keys = new Set();
  const walk = (item) => { item.page?.fileKeys.forEach((key) => keys.add(key)); item.children.forEach(walk); };
  walk(node);
  return [...keys];
}
const meaningful = (label = "") => label && label.length > 1 && label.length < 160 && !GENERIC_LABEL.test(label.trim()) && !/^https?:\/\//i.test(label);
function fileTitle(file, strict = false) {
  const name = (meaningful(file.label) ? file.label : "") || file.docTitle || file.title;
  return strict ? name : name || `Untitled ${KIND[file.kind]?.label.toLowerCase() || "file"}`;
}
function filePages(file) { return file.pages.map((path) => state.site.pages.find((page) => page.path === path)).filter(Boolean); }
function fileVault(file) { return filePages(file).find((page) => page.path) || null; }
/* Every record has a catalogue reference, in the order the site first mentions it. */
const fileRefNo = (file) => (Number.isFinite(file.order) ? `TSO-CA/${String(file.order + 1).padStart(3, "0")}` : "TSO-CA/—");
const canThumb = (file) => !file.pub && ["document", "spreadsheets", "presentation", "drawings", "file"].includes(file.kind);
const thumbSrc = (file) => `/api/img?thumb=${encodeURIComponent(file.id)}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
function roman(number) {
  const map = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = ""; for (const [value, numeral] of map) while (number >= value) { out += numeral; number -= value; }
  return out;
}
const vaultNumeral = (page) => page?.node?.numeral || "";
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
const SABER_RULE = (label, id = "") => `<div class="rule"${id ? ` id="${id}"` : ""}><span class="rule-blade" aria-hidden="true"></span><b>${esc(label)}</b><span class="rule-blade" aria-hidden="true"></span></div>`;
const thumbHtml = (file) => (canThumb(file) ? `<img src="${thumbSrc(file)}" alt="" loading="lazy" />` : glyph(file.key));

/* ───────── Routing ───────── */
function parseRoute(path = currentPath()) {
  const parts = path.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (!parts.length) return { view: "home" };
  if (parts[0] === "p") return { view: "page", path: parts.slice(1).join("/") };
  if (parts[0] === "codex" || parts[0] === "catalogue") return { view: "codex" };
  if (parts[0] === "paths" || parts[0] === "path-picker") return { view: "paths" };
  if (parts[0] === "guide") return { view: "guide" };
  if (parts[0] === "s" && parts[1]) return { view: "section", slug: parts[1] };
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
    hideScrubber();
    const target = parseRoute();
    markActiveRail(target);
    if (target.view === "home") return renderGate(options);
    if (target.view === "codex") return renderCatalogue(options);
    if (target.view === "paths") return renderPicker(options);
    if (target.view === "guide") return renderGuide(options);
    if (target.view === "section") {
      const node = state.site.groups.get(target.slug);
      return node ? renderSection(node, options) : renderNotFound();
    }
    if (target.view === "page") {
      const page = state.site.pages.find((item) => item.path === target.path);
      return page ? renderChamber(page, options) : renderNotFound();
    }
    if (target.view === "file") {
      const key = P.fileKey(target);
      const file = fileByKey(key) || { key, kind: target.kind, id: target.id, pub: target.pub, gid: target.gid, label: "", title: "", pages: [], docTitle: "", order: NaN };
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
function navigate(href, source = null) {
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
  if (!isFilePath(path) || reducedMotion.matches || doorsBusy) return perform();
  const holocron = openingHolocron(source);
  if (holocron) holocronOpen(holocron, perform);
  else blastDoors(perform);
}

/* ───────── Blast doors ─────────
 * Opening a record seals the archive for a heartbeat: two armoured doors slam together,
 * a crimson seam ignites along the join like a blade, the record is swapped in behind
 * them, and they draw apart again. Each beat waits for the doors to actually arrive. */
let doorsBusy = false;
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

/* ───────── Opening a holocron ─────────
 * A record picked from the vault opens itself instead of going through the doors: the
 * holocron lifts to the middle of the screen and unlocks, its capstone rising away; a beam of
 * light projects from its core with the record's name flickering in it as a hologram; then
 * the projection splits the screen open from the middle, like a curtain of light, onto the
 * record, which resolves out of the scanlines. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function openingHolocron(source) {
  let holocron = source?.closest?.(".holocron");
  const plaque = source?.closest?.(".plaque");
  if (!holocron && plaque) holocron = plaque.closest(".shelf-wrap")?.querySelector(`.holocron[data-holocron="${CSS.escape(plaque.dataset.plaque || "")}"]`);
  const box = holocron?.querySelector(".holocron-art")?.getBoundingClientRect();
  return box && box.width && box.bottom > 0 && box.top < innerHeight ? holocron : null;
}
async function holocronOpen(holocron, swap) {
  doorsBusy = true;
  const stage = byId("holoOpen");
  const lite = perf.lite;
  let swapped = false;
  try {
    const art = holocron.querySelector(".holocron-art");
    const box = art.getBoundingClientRect();
    const look = getComputedStyle(holocron);
    for (const name of ["--seam", "--seam-soft", "--face-l", "--face-r", "--rune"]) stage.style.setProperty(name, look.getPropertyValue(name));
    const flyer = document.createElement("div");
    flyer.className = `holo-flyer ${[...holocron.classList].filter((name) => name.startsWith("tone-")).join(" ")}`;
    flyer.style.cssText = `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px`;
    flyer.append(art.cloneNode(true));
    // Where it comes to rest, and the beam it throws up from there.
    const size = Math.min(innerWidth * .3, innerHeight * .26, 200), scale = size / box.width;
    const restX = innerWidth / 2, restY = innerHeight * .7;
    const beam = document.createElement("div");
    beam.className = "holo-beam";
    beam.style.cssText = `left:${restX}px;top:${innerHeight * .08}px;height:${restY - innerHeight * .08 - size * .18}px`;
    const name = holocron.querySelector(".holocron-name")?.textContent.trim() || "";
    const ref = holocron.querySelector(".holocron-ref")?.textContent.trim() || "";
    beam.innerHTML = `<div class="holo-text"><small>Holocron ${esc(ref)}</small><strong>${esc(name)}</strong><small>Opening ${esc(holocron.dataset.kind || "record")}</small></div>`;
    const curtain = document.createElement("div");
    curtain.className = "holo-curtain";
    stage.replaceChildren(beam, flyer, curtain);
    stage.className = "holo-open active";
    holocron.classList.add("lifted");
    const dx = restX - (box.left + box.width / 2), dy = restY - (box.top + box.height / 2);
    const rise = flyer.animate([{ transform: "none" }, { transform: `translate(${dx}px, ${dy}px) scale(${scale})` }], { duration: lite ? 380 : 520, easing: "cubic-bezier(.2,.75,.25,1)", fill: "forwards" });
    await rise.finished.catch(() => {});
    stage.classList.add("unsealed"); // the capstone lifts away, the core ignites
    await wait(lite ? 150 : 260);
    stage.classList.add("projecting"); // the beam rises and the name resolves in it
    await wait(lite ? 900 : 1300);
    stage.classList.add("opening"); // the projection splits the screen open
    await wait(lite ? 300 : 420);
    swap(); swapped = true;
    app.classList.remove("holo-arrive"); void app.offsetWidth; app.classList.add("holo-arrive");
    stage.classList.add("fade");
    await wait(lite ? 420 : 650);
  } finally {
    if (!swapped) swap();
    stage.className = "holo-open"; stage.replaceChildren();
    app.classList.remove("holo-arrive");
    doorsBusy = false;
  }
}

function afterRender(options = {}) {
  bindImageFallbacks(app); observeReveals(app); decryptTitles(app);
  if (options.hash) {
    const target = byId(decodeURIComponent(options.hash.slice(1)));
    if (target) { setTimeout(() => target.scrollIntoView({ behavior: "auto", block: "start" }), 30); updateProgress(); return; }
  }
  if (!options.preserveScroll) { scrollTo({ top: 0, behavior: "auto" }); app.focus({ preventScroll: true }); }
  updateProgress();
}

/* ───────── Index rail ───────── */
const railOpen = new Set();
const CHEVRON = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function railNode(node) {
  if (!node.page && !node.group) return `<a class="rail-link rail-external${node.level > 1 ? " sub" : ""}" href="${esc(node.href)}" target="_blank" rel="noopener" style="--depth:${node.level - 1}"><em aria-hidden="true">↗</em><span>${esc(node.label)}</span></a>`;
  const count = subtreeFiles(node).length;
  const href = nodeHref(node);
  const link = `<a class="rail-link${node.level > 1 ? " sub" : ""}${node.group ? " rail-section" : ""}" href="${href}" data-link data-route="${href}" style="--depth:${node.level - 1}"><em>${node.numeral}</em><span>${esc(nodeTitle(node))}</span>${count ? `<small>${count}</small>` : ""}</a>`;
  if (!node.children.length) return link;
  const key = nodeKey(node);
  const open = railOpen.has(key);
  return `<div class="rail-group${open ? " open" : ""}" data-group="${esc(key)}">
    <div class="rail-row">${link}<button type="button" class="rail-expand" aria-expanded="${open}" aria-label="${open ? "Hide" : "Show"} the pages in ${esc(nodeTitle(node))}">${CHEVRON}</button></div>
    <div class="rail-children"${open ? "" : " inert"}><div>${node.children.map(railNode).join("")}</div></div>
  </div>`;
}
function setRailGroup(group, open) {
  const path = group.dataset.group;
  if (open) railOpen.add(path); else railOpen.delete(path);
  group.classList.toggle("open", open);
  const button = group.querySelector(":scope > .rail-row > .rail-expand");
  const title = group.querySelector(":scope > .rail-row > .rail-link span")?.textContent || "";
  button.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-label", `${open ? "Hide" : "Show"} the pages in ${title}`);
  group.querySelector(":scope > .rail-children").inert = !open;
}
function renderRail() {
  const tree = state.site.tree;
  byId("railNav").innerHTML = `
    <a class="rail-link" href="/" data-link data-route="/"><em aria-hidden="true">◆</em><span>The Gate</span></a>
    <a class="rail-link" href="/guide" data-link data-route="/guide"><em aria-hidden="true">✦</em><span>New Player Guide</span></a>
    ${tree.length ? `<p class="rail-label">Vaults</p>${tree.map(railNode).join("")}` : ""}
    <p class="rail-label">Records</p>
    <a class="rail-link" href="/codex" data-link data-route="/codex"><em aria-hidden="true">✦</em><span>The Catalogue</span><small>${state.site.files.length}</small></a>
    <a class="rail-link" href="/paths" data-link data-route="/paths"><em aria-hidden="true">✠</em><span>Path Picker</span></a>`;
  byId("footerSource").href = state.site.source || SITE_URL;
  markActiveRail(parseRoute());
}
byId("railNav").addEventListener("click", (event) => {
  const button = event.target.closest(".rail-expand");
  if (!button) return;
  const group = button.closest(".rail-group");
  setRailGroup(group, !group.classList.contains("open"));
});
function markActiveRail(target) {
  let active = currentPath();
  if (target.view === "file") { const file = fileByKey(P.fileKey(target)); const vault = file && fileVault(file); active = vault ? pageHref(vault) : "/codex"; }
  if (target.view === "section") active = `/s/${target.slug}`;
  if (target.view === "codex") active = "/codex";
  if (target.view === "paths") active = "/paths";
  if (target.view === "guide") active = "/guide";
  document.querySelectorAll(".rail-link[data-route]").forEach((link) => {
    if (link.dataset.route === active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  // Open every section on the way to the current page, so the rail always shows where you are.
  const page = active.startsWith("/p/") ? state.site?.pages.find((item) => pageHref(item) === active) : null;
  const here = page?.node || (active.startsWith("/s/") ? state.site?.groups.get(decodeURIComponent(active.slice(3))) : null);
  if (!here) return;
  [...ancestorNodes(here), here].forEach((item) => {
    const group = byId("railNav").querySelector(`.rail-group[data-group="${CSS.escape(nodeKey(item))}"]`);
    if (group && !group.classList.contains("open")) setRailGroup(group, true);
  });
}
function openRail() { document.body.classList.add("rail-open"); byId("railScrim").hidden = false; byId("menuToggle").setAttribute("aria-expanded", "true"); }
function closeMenus() { document.body.classList.remove("rail-open"); byId("railScrim").hidden = true; byId("menuToggle").setAttribute("aria-expanded", "false"); }

/* ───────── Shared pieces ───────── */
/* A record in the vault: a Sith holocron. Each is a pyramid of dark metal in three-quarter
 * view, its capstone a separate piece that lifts when the holocron is opened, light leaking
 * from the seams, runes cut into both faces. Size, runes and the colour of its light all
 * come from the record itself, so no two holocrons in the vault are alike. */
const HOLO = { A: [0, -58], L: [-48, 26], R: [48, 26], F: [8, 40] };
const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
const pts = (...points) => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
function holocronSvg(seed) {
  let h = hash(seed);
  const rand = () => { h |= 0; h = (h + 0x6d2b79f5) | 0; let t = Math.imul(h ^ (h >>> 15), 1 | h); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const { A, L, R, F } = HOLO;
  const cut = .36 + rand() * .08;
  const CL = lerp(A, L, cut), CF = lerp(A, F, cut), CR = lerp(A, R, cut);
  // Runes: short angular strokes placed inside a face (by mixing its corners) and drawn in its plane.
  const runes = (p, q, r, count) => Array.from({ length: count }, () => {
    let u = rand(), v = rand(); if (u + v > .92) { u = .92 - u; v = .92 - v; }
    const base = [p[0] + (q[0] - p[0]) * u + (r[0] - p[0]) * v, p[1] + (q[1] - p[1]) * u + (r[1] - p[1]) * v];
    const size = 3 + rand() * 3.5;
    const shape = Math.floor(rand() * 4);
    const d = [
      `M${base[0] - size},${base[1] + size} L${base[0]},${base[1] - size} L${base[0] + size},${base[1] + size}`,
      `M${base[0] - size},${base[1]} L${base[0] + size},${base[1]} M${base[0]},${base[1] - size} L${base[0]},${base[1] + size}`,
      `M${base[0] - size},${base[1] - size} L${base[0] + size},${base[1] - size} L${base[0] - size},${base[1] + size} L${base[0] + size},${base[1] + size}`,
      `M${base[0]},${base[1] - size} L${base[0] + size},${base[1]} L${base[0]},${base[1] + size} L${base[0] - size},${base[1]} Z`
    ][shape];
    return `<path d="${d}"/>`;
  }).join("");
  return `<svg class="holocron-art" viewBox="-62 -96 124 146" aria-hidden="true">
    <polygon class="beam" points="${pts([CL[0] * .55, CL[1]], [CR[0] * .55, CR[1]], [CR[0] * .2, -96], [CL[0] * .2, -96])}"/>
    <ellipse class="core" cx="4" cy="6" rx="34" ry="30"/>
    <g class="base">
      <polygon class="face face-left" points="${pts(CL, L, F, CF)}"/>
      <polygon class="face face-right" points="${pts(CF, F, R, CR)}"/>
      <polygon class="sheen" points="${pts(CF, F, R, CR)}"/>
      <g class="runes">${runes(CL, L, F, 4 + Math.floor(rand() * 3))}${runes(CF, F, R, 4 + Math.floor(rand() * 3))}</g>
      <path class="seam" d="M${CF[0]},${CF[1]} L${F[0]},${F[1]}"/>
      <path class="edge" d="M${CL[0]},${CL[1]} L${L[0]},${L[1]} L${F[0]},${F[1]} L${R[0]},${R[1]} L${CR[0]},${CR[1]}"/>
    </g>
    <g class="cap">
      <polygon class="face face-left" points="${pts(A, CL, CF)}"/>
      <polygon class="face face-right" points="${pts(A, CF, CR)}"/>
      <polygon class="sheen" points="${pts(A, CF, CR)}"/>
      <path class="edge" d="M${CL[0]},${CL[1]} L${A[0]},${A[1]} L${CR[0]},${CR[1]} M${A[0]},${A[1]} L${CF[0]},${CF[1]}"/>
      <circle class="apex" cx="${A[0]}" cy="${A[1]}" r="2.2"/>
    </g>
    <path class="seam cut" d="M${CL[0]},${CL[1]} L${CF[0]},${CF[1]} L${CR[0]},${CR[1]}"/>
  </svg>`;
}
function holocronHtml(file, index = 0) {
  const r = seededRandom(file.key), r2 = seededRandom(`${file.key}:w`);
  const tone = r2 < .5 ? 0 : r2 < .68 ? 1 : r2 < .84 ? 2 : 3; // crimson most of all, then ember, violet, gold
  return `<a class="holocron tone-${tone}" role="listitem" data-kind="${esc((KIND[file.kind]?.label || "record").toLowerCase())}" href="${fileHref(file)}" data-link data-prefetch="${esc(file.key)}" data-holocron="${esc(file.key)}" style="--scale:${(.86 + r * .26).toFixed(3)};--d:${Math.min(index * 70, 700)}ms;--bob:${(4.2 + r2 * 2.6).toFixed(2)}s">
    <span class="holocron-float">${holocronSvg(file.key)}</span>
    <span class="holocron-pool" aria-hidden="true"></span>
    <span class="holocron-name" data-file-name="${esc(file.key)}">${esc(fileTitle(file))}</span>
    <span class="holocron-ref">${kindIcon(file.kind)}${esc(KIND[file.kind]?.label || "File")} · ${esc(fileRefNo(file).slice(-3))}</span>
  </a>`;
}
function plaqueHtml(file) {
  const vault = fileVault(file);
  return `<span class="plaque-thumb" data-seed="${esc(file.key)}">${thumbHtml(file)}</span>
    <span class="plaque-text"><small>${esc(fileRefNo(file))} · ${esc(KIND[file.kind]?.label || "File")}${vault ? ` · ${esc(vault.title)}` : ""}</small><strong data-file-name="${esc(file.key)}">${esc(fileTitle(file))}</strong></span>
    <span class="plaque-open" aria-hidden="true">Open ${esc((KIND[file.kind]?.label || "File").toLowerCase())} →</span>`;
}
function shelfHtml(files) {
  if (!files.length) return "";
  return `<div class="shelf-wrap" data-reveal>
    <div class="shelf" role="list">${files.map(holocronHtml).join("")}</div>
    <a class="plaque" href="${fileHref(files[0])}" data-link data-plaque="${esc(files[0].key)}" tabindex="-1">${plaqueHtml(files[0])}</a>
  </div>`;
}
function setPlaque(holocron) {
  const plaque = holocron.closest(".shelf-wrap")?.querySelector(".plaque");
  const file = fileByKey(holocron.dataset.holocron);
  if (!plaque || !file || plaque.dataset.plaque === file.key) return;
  plaque.dataset.plaque = file.key;
  plaque.href = fileHref(file);
  plaque.innerHTML = plaqueHtml(file);
  plaque.classList.remove("flip"); void plaque.offsetWidth; plaque.classList.add("flip");
  bindImageFallbacks(plaque);
}
/* A record embedded in a page: a sealed archive document. Its first page (Google's own
 * thumbnail) lies in a dark sleeve with a turned corner and the Order's seal, so it reads
 * at once as a document to open. */
function artifactHtml(file) {
  const kind = KIND[file.kind] || KIND.file;
  return `<a class="artifact kind-${esc(file.kind)}" href="${fileHref(file)}" data-link data-prefetch="${esc(file.key)}">
    <span class="artifact-page" data-seed="${esc(file.key)}">${thumbHtml(file)}<i class="artifact-seal" aria-hidden="true"><svg viewBox="0 0 64 64"><path d="M32 5 55 18v28L32 59 9 46V18Z"/><path d="m32 17 8 15-8 15-8-15Z"/></svg></i></span>
    <span class="artifact-text">
      <small class="artifact-kind">${kindIcon(file.kind)}${esc(kind.label)} · ${esc(kind.app)}</small>
      <strong data-file-name="${esc(file.key)}">${esc(fileTitle(file))}</strong>
      <small class="artifact-ref">${esc(fileRefNo(file))}</small>
      <span class="artifact-open">Open ${esc(kind.label.toLowerCase())} <span aria-hidden="true">→</span></span>
    </span>
  </a>`;
}
/* A catalogue slip: one record as a line in the card index. */
function slipHtml(file, options = {}) {
  const vault = fileVault(file);
  const where = [options.hideVault ? "" : vault && trail(vault), KIND[file.kind]?.app].filter(Boolean).join(" · ");
  return `<a class="slip" href="${fileHref(file)}" data-link data-prefetch="${esc(file.key)}">
    <span class="slip-kind">${kindIcon(file.kind)}<span>${esc(KIND[file.kind]?.short || "File")}</span></span>
    <span class="slip-main"><strong data-file-name="${esc(file.key)}">${esc(fileTitle(file))}</strong><small>${esc(where)}</small></span>
    <span class="slip-ref">${esc(fileRefNo(file))}</span>
    <span class="slip-arrow" aria-hidden="true">→</span>
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
      out.push(`<div class="artifacts">${items.map((item) => { const file = fileByKey(item.key); return file ? artifactHtml(file) : ""; }).join("")}</div>`);
    }
  }
  return out.join("");
}
const readingMinutes = (words) => Math.max(1, Math.round(words / 220));
const crumbs = (items) => `<nav class="breadcrumb" aria-label="Breadcrumb">${items.map((item, index) => (index < items.length - 1 ? `<a href="${item.href}" data-link>${esc(item.label)}</a><span aria-hidden="true">◆</span>` : `<span>${esc(item.label)}</span>`)).join("")}</nav>`;
function passage(previous, next, label, hrefOf, nameOf) {
  if (!previous && !next) return "";
  const side = (item, dir) => (item ? `<a class="passage-${dir}" href="${hrefOf(item)}" data-link${item.key ? ` data-prefetch="${esc(item.key)}"` : ""}><small>${dir === "prev" ? "← Previous" : "Next →"} ${esc(label)}</small><strong${item.key ? ` data-file-name="${esc(item.key)}"` : ""}>${esc(nameOf(item))}</strong></a>` : "<span></span>");
  return `<nav class="passage" aria-label="Adjacent ${esc(label)}s">${side(previous, "prev")}${side(next, "next")}</nav>`;
}

/* ───────── The gate (home) ───────── */
const HERO_CORE = (() => {
  const ticks = Array.from({ length: 90 }, (_, i) => { const a = (i / 90) * Math.PI * 2, r = i % 5 === 0 ? 87 : 92; return `<path d="M${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)} L${(Math.cos(a) * 97).toFixed(1)},${(Math.sin(a) * 97).toFixed(1)}"/>`; }).join("");
  return `<svg viewBox="-100 -100 200 200" aria-hidden="true">
  <defs>
    <path id="coreTextPath" d="M0,-76 a76,76 0 1,1 -0.01,0"/>
    <linearGradient id="kyber" x1="0" y1="0" x2="0" y2="1"><stop class="kyber-a" offset="0" stop-color="#ffd2c8"/><stop class="kyber-b" offset=".35" stop-color="#ff3b44"/><stop class="kyber-c" offset="1" stop-color="#5c0610"/></linearGradient>
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

function stackGroups() {
  const groups = state.site.tree.filter((node) => node.page || node.group).map((node) => ({ node, files: state.site.files.filter((file) => rootOf(fileVault(file)) === node) })).filter((group) => group.files.length);
  const loose = state.site.files.filter((file) => !fileVault(file));
  if (loose.length) groups.unshift({ node: null, files: loose });
  return groups;
}
/* The holocron vault: every record a holocron on one long altar, each section's run of
 * holocrons introduced by an obelisk carrying its numeral. */
function stacksHtml() {
  const groups = stackGroups();
  if (!groups.length) return "";
  let index = 0;
  const first = groups[0].files[0];
  return `<div class="shelf-wrap library" data-reveal>
    <div class="shelf" role="list">${groups.map(({ node, files }) => `${node
      ? `<a class="obelisk" role="listitem" href="${nodeHref(node)}" data-link title="Vault ${node.numeral} · ${esc(nodeTitle(node))}"><em>${node.numeral}</em><span>${esc(nodeTitle(node))}</span></a>`
      : `<span class="obelisk" role="listitem"><em>◆</em><span>The gate</span></span>`}${files.map((file) => holocronHtml(file, index++)).join("")}`).join("")}</div>
    <a class="plaque" href="${fileHref(first)}" data-link data-plaque="${esc(first.key)}" tabindex="-1">${plaqueHtml(first)}</a>
  </div>`;
}

function renderGate(options) {
  const home = homePage();
  const files = state.site.files;
  const list = state.site.tree.filter((node) => node.page || node.group);
  document.title = /central archives/i.test(state.site.name) ? state.site.name : `${state.site.name} — Central Archives`;
  const leadBlock = home.blocks.find((block) => block.type === "p" && block.text.length > 30 && block.text.length < 420);
  const lead = leadBlock ? leadBlock.text : "The central archive of the Sith Order: every vault, every handbook, every record — unsealed for those with the will to read them.";
  const rest = home.blocks.filter((block) => block !== leadBlock);
  app.innerHTML = `<div class="page gate">
    <section class="gate-head">
      <div class="gate-title">
        <p class="eyebrow">The Sith Order</p>
        <h1 class="gate-heading" aria-label="Central Archives"><span>Central</span><span>Archives</span></h1>
        <div class="saber" aria-hidden="true"><span class="saber-hilt"></span><span class="saber-blade"></span></div>
      </div>
      <div class="gate-brief">
        <p class="gate-lead">${esc(lead)}</p>
        <form class="query" role="search" id="heroSearch">
          <span class="query-prompt" aria-hidden="true">query ›</span>
          <input type="search" placeholder="search every vault and record" autocomplete="off" spellcheck="false" aria-label="Query the archive" />
          <kbd aria-hidden="true">/</kbd>
        </form>
        <div class="gate-ctas"><a href="/guide" data-link>New to the Order? Walk the guide <span aria-hidden="true">→</span></a><a href="/paths" data-link>Find your path <span aria-hidden="true">→</span></a></div>
      </div>
    </section>

    <section class="orrery" id="orrery" aria-label="The vaults, orbiting the archive core">
      <svg class="orrery-lines" id="orreryLines" aria-hidden="true"></svg>
      <span class="orrery-ring ring-a" aria-hidden="true"></span><span class="orrery-ring ring-b" aria-hidden="true"></span>
      <button type="button" class="hero-core" id="heroCore" aria-label="Touch the archive core">${HERO_CORE}</button>
      ${list.map((node, index) => {
        const inner = node.children.filter((child) => child.page || child.group).length;
        return `<a class="orrery-node" href="${nodeHref(node)}" data-link data-node="${index}" style="--d:${300 + index * 90}ms">
        <span class="node-orb">${glyph(nodeKey(node))}</span>
        <span class="node-label"><em>Vault ${node.numeral}</em><strong>${esc(nodeTitle(node))}</strong><small>${[inner ? plural(inner, "inner vault") : "", plural(subtreeFiles(node).length, "record")].filter(Boolean).join(" · ")}</small></span>
      </a>`;
      }).join("")}
      <p class="orrery-log"><span class="log-caret" aria-hidden="true">›</span><span id="gateLog"></span></p>
    </section>

    ${files.length ? `${SABER_RULE("The holocron vault", "stacks")}<div class="stacks">${stacksHtml()}</div>
      <div class="more-row"><a class="btn" href="/codex" data-link>Open the catalogue · ${plural(files.length, "record")} <span aria-hidden="true">→</span></a></div>` : ""}
    ${rest.length ? `${SABER_RULE("Inscribed at the gate")}<section class="prose gate-prose" data-reveal>${blocksHtml(rest)}</section>` : ""}
  </div>`;
  const search = byId("heroSearch");
  search.addEventListener("submit", (event) => { event.preventDefault(); openSearch(search.querySelector("input").value); });
  search.querySelector("input").addEventListener("focus", () => openSearch(search.querySelector("input").value));
  byId("heroCore").addEventListener("click", (event) => coreBurst(event.currentTarget));
  afterRender(options);
  startOrrery();
  startGateLog();
}

/* The orrery: every vault orbits the archive core on a tilted ellipse, nearer nodes larger
 * and brighter, each tethered to the core by a line of energy. It slows to a stop while a
 * node is hovered or focused, holds still in lite mode, and on narrow screens the vaults
 * simply stack beneath the core. */
let orreryFrame = 0;
function startOrrery() {
  cancelAnimationFrame(orreryFrame);
  const panel = byId("orrery");
  if (!panel) return;
  const nodes = [...panel.querySelectorAll(".orrery-node")];
  const svg = byId("orreryLines");
  svg.innerHTML = nodes.map(() => `<line class="orrery-line"></line>`).join("");
  const lines = [...svg.querySelectorAll("line")];
  let hovered = -1, speed = 1;
  let offset = -Math.PI / 2 + seededRandom(new Date().toISOString().slice(0, 13)) * .6;
  let last = performance.now();
  nodes.forEach((node, index) => {
    const on = () => { hovered = index; }, off = () => { if (hovered === index) hovered = -1; };
    node.addEventListener("pointerenter", on); node.addEventListener("pointerleave", off);
    node.addEventListener("focus", on); node.addEventListener("blur", off);
  });
  const place = (now) => {
    if (!panel.isConnected) return;
    const dt = Math.min(64, now - last); last = now;
    const stacked = innerWidth <= 700;
    panel.classList.toggle("is-stacked", stacked);
    if (stacked) { nodes.forEach((node) => { node.style.transform = ""; node.style.opacity = ""; }); orreryFrame = requestAnimationFrame(place); return; }
    const still = reducedMotion.matches || perf.lite || document.hidden;
    speed += ((hovered >= 0 || still ? 0 : 1) - speed) * .06;
    offset += dt * .000045 * speed;
    const w = panel.clientWidth, h = panel.clientHeight;
    const cx = w / 2, cy = h * .45;
    const rx = Math.min(w * .39, 34 * 16), ry = h * .29;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    nodes.forEach((node, index) => {
      const ring = nodes.length > 7 && index % 2 ? .64 : 1;
      const angle = offset + (index / nodes.length) * Math.PI * 2;
      const x = cx + Math.cos(angle) * rx * ring, y = cy + Math.sin(angle) * ry * ring;
      const depth = (Math.sin(angle) + 1) / 2; // 0 = far side (top), 1 = near side (bottom)
      node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${(.8 + depth * .26).toFixed(3)})`;
      node.style.opacity = (.5 + depth * .5).toFixed(3);
      node.style.zIndex = String(index === hovered ? 30 : 2 + Math.round(depth * 10));
      node.dataset.side = x < cx ? "left" : "right";
      const line = lines[index];
      line.setAttribute("x1", cx.toFixed(1)); line.setAttribute("y1", cy.toFixed(1));
      line.setAttribute("x2", x.toFixed(1)); line.setAttribute("y2", y.toFixed(1));
      line.classList.toggle("hot", index === hovered);
    });
    orreryFrame = requestAnimationFrame(place);
  };
  orreryFrame = requestAnimationFrame(place);
}

/* The transmission log under the orrery types out the archive's own status, line by line. */
let gateLogTimer = 0;
function startGateLog() {
  clearTimeout(gateLogTimer);
  const node = byId("gateLog");
  if (!node) return;
  let index = 0;
  const lines = () => {
    const list = state.site.tree.filter((node) => node.page || node.group);
    return [
      `Archive synced with Google Sites ${syncAgo()}`,
      `${plural(list.length, "section")} · ${plural(vaults().length, "vault")} · ${plural(state.site.files.length, "record")} on file`,
      ...list.slice(0, 10).map((node) => `Vault ${node.numeral} · ${nodeTitle(node)} · ${node.group ? `${plural(node.children.length, "inner vault")} · ` : ""}${plural(subtreeFiles(node).length, "record")}`),
      "Hold still on empty ground to channel the Force",
    ].filter(Boolean);
  };
  const type = () => {
    if (!node.isConnected) return;
    const all = lines();
    const text = all[index++ % all.length];
    if (reducedMotion.matches) { node.textContent = text; gateLogTimer = setTimeout(type, 4200); return; }
    let shown = 0;
    const step = () => {
      if (!node.isConnected) return;
      node.textContent = text.slice(0, ++shown);
      gateLogTimer = setTimeout(shown < text.length ? step : type, shown < text.length ? 24 : 3400);
    };
    step();
  };
  type();
}

/* ───────── A section (a dropdown tab of the Google Site's menu) ─────────
 * The tab has no page of its own on Google Sites, so its chamber here is the index of what
 * it holds: its pages as inner vaults, then every record filed anywhere inside it. */
function innerVaultsHtml(nodes, owner) {
  if (!nodes.length) return "";
  return `<nav class="inner-vaults" aria-label="Inner vaults of ${esc(owner)}">${nodes.map((child) => (child.page || child.group)
    ? `<a class="inner-vault" href="${nodeHref(child)}" data-link><em>${child.numeral}</em><strong>${esc(nodeTitle(child))}</strong><small>${[child.children.length ? plural(child.children.length, "inner vault") : "", plural(subtreeFiles(child).length, "record")].filter(Boolean).join(" · ")}</small><span aria-hidden="true">→</span></a>`
    : `<a class="inner-vault" href="${esc(child.href)}" target="_blank" rel="noopener"><em>↗</em><strong>${esc(child.label)}</strong><small>Outside the archive</small><span aria-hidden="true">↗</span></a>`).join("")}</nav>`;
}
function renderSection(node, options) {
  const title = nodeTitle(node);
  document.title = `${title} — TSO Central Archives`;
  const files = subtreeFiles(node).map(fileByKey).filter(Boolean);
  const sections = state.site.tree.filter((item) => item.page || item.group);
  const index = sections.indexOf(node);
  app.innerHTML = `<article class="page chamber section-page">
    <header class="chamber-head">
      <span class="chamber-numeral" aria-hidden="true">${node.numeral}</span>
      ${crumbs([{ href: "/", label: "The Gate" }, ...ancestorNodes(node).map((item) => ({ href: nodeHref(item), label: nodeTitle(item) })), { label: title }])}
      <p class="eyebrow">Vault ${node.numeral}</p>
      <h1 data-decrypt>${esc(title)}</h1>
      <div class="chamber-meta"><span>${plural(node.children.length, "inner vault")}</span><span>${plural(files.length, "record")} filed within</span></div>
    </header>
    ${innerVaultsHtml(node.children, title)}
    ${files.length ? `${SABER_RULE(`Holocrons within ${title}`)}<div class="stacks">${shelfHtml(files)}</div>` : ""}
    ${passage(index > 0 ? sections[index - 1] : null, index >= 0 && index < sections.length - 1 ? sections[index + 1] : null, "section", nodeHref, nodeTitle)}
  </article>`;
  afterRender(options);
}

/* ───────── A vault chamber (a page of the Google Site) ───────── */
function renderChamber(page, options) {
  document.title = `${page.title} — TSO Central Archives`;
  const valley = valleyPlan(page.blocks);
  if (valley) return renderValley(page, valley, options);
  const list = vaults();
  const index = list.indexOf(page);
  const shown = new Set(page.blocks.filter((block) => block.type === "file").map((block) => block.key));
  const extra = page.fileKeys.filter((key) => !shown.has(key)).map(fileByKey).filter(Boolean);
  const words = page.text.split(/\s+/).filter(Boolean).length;
  const children = page.node ? page.node.children : [];
  const numeral = vaultNumeral(page) || "◆";
  app.innerHTML = `<article class="page chamber">
    <header class="chamber-head${page.banner ? " has-banner" : ""}">
      <span class="chamber-numeral" aria-hidden="true">${numeral}</span>
      ${page.banner ? `<img class="chamber-banner" src="${esc(page.banner)}" alt="" />` : ""}
      ${crumbs([{ href: "/", label: "The Gate" }, ...(page.node ? ancestors(page).map((item) => ({ href: nodeHref(item), label: nodeTitle(item) })) : []), { label: page.title }])}
      <p class="eyebrow">${index >= 0 ? `Vault ${numeral}` : "The gate"}</p>
      <h1 data-decrypt>${esc(page.title)}</h1>
      <div class="chamber-meta"><span>${plural(page.fileKeys.length, "record")} filed</span>${words > 40 ? `<span>${readingMinutes(words)} min read</span>` : ""}<a href="${esc(page.source)}" target="_blank" rel="noopener">View on Google Sites ↗</a></div>
    </header>
    ${innerVaultsHtml(children, page.title)}
    ${page.blocks.length ? `<div class="prose chamber-prose">${blocksHtml(page.blocks)}</div>` : children.length ? "" : `<div class="prose chamber-prose"><p class="notice">This vault holds no inscriptions of its own${extra.length ? " — only the records on its shelf" : " yet"}.</p></div>`}
    ${extra.length ? `${SABER_RULE(shown.size ? "More holocrons in this vault" : "Holocrons in this vault")}<div class="stacks">${shelfHtml(extra)}</div>` : ""}
    ${passage(index > 0 ? list[index - 1] : null, index >= 0 && index < list.length - 1 ? list[index + 1] : null, "vault", pageHref, (item) => item.title)}
  </article>`;
  afterRender(options);
  setupScrubber(page.headings);
}

/* ───────── The Valley ─────────
 * A page that is a roll of the fallen (a portrait, then a name, then a few lines, over and
 * over, like the Valley of the Dark Lords) is laid out as a walk down a canyon: each lord
 * stands as a stone statue in an alcove along the path, and wakes as you draw level with
 * them. The greatest (the page's larger headings, the Emperors) stand at the head of the
 * valley, alone and on the path itself. */
const lordStart = (blocks, i) => blocks[i]?.type === "img" && blocks[i + 1]?.type === "h";
function valleyPlan(blocks) {
  const first = blocks.findIndex((block, i) => lordStart(blocks, i));
  if (first < 0) return null;
  const lords = [];
  let i = first;
  while (lordStart(blocks, i)) {
    const lord = { image: blocks[i], heading: blocks[i + 1], body: [] };
    i += 2;
    while (i < blocks.length && !lordStart(blocks, i) && ["p", "button", "quote"].includes(blocks[i].type)) lord.body.push(blocks[i++]);
    lords.push(lord);
  }
  if (lords.length < 4) return null;
  const top = Math.min(...lords.map((lord) => lord.heading.level));
  const mixed = lords.some((lord) => lord.heading.level > top);
  for (const lord of lords) lord.emperor = mixed && lord.heading.level === top;
  return { intro: blocks.slice(0, first), lords, after: blocks.slice(i) };
}
function lordName(heading) {
  const [first, ...rest] = heading.html.split(/<br\s*\/?>/i).map((part) => part.trim()).filter(Boolean);
  if (rest.length) return { epithet: first.replace(/,(\s|<\/[^>]+>)*$/, "$1"), name: rest.join(" ") };
  // No line break: "Ancient Spirit of Conquest, Darth Valios" still parts at its first comma.
  const comma = heading.text.indexOf(",");
  if (comma > 0 && comma < heading.text.length - 2) return { epithet: esc(heading.text.slice(0, comma).trim()), name: esc(heading.text.slice(comma + 1).trim()) };
  return { epithet: "", name: first || esc(heading.text) };
}
function tombHtml(lord, index, side) {
  const { epithet, name } = lordName(lord.heading);
  const body = lord.body.map((block) => (block.type === "button" ? block.html : `<p>${block.html}</p>`)).join("");
  return `<li class="tomb ${lord.emperor ? "emperor" : `side-${side}`}" style="--n:${index}">
    <figure class="statue">
      <button data-zoom="${esc(lord.image.src)}" data-caption="${esc(lord.heading.text)}" aria-label="Enlarge the portrait of ${esc(lord.heading.text)}"><img src="${esc(lord.image.src)}" alt="${esc(lord.image.alt || lord.heading.text)}" loading="lazy" /></button>
      <span class="statue-light" aria-hidden="true"></span>
    </figure>
    <div class="tomb-plaque">
      ${epithet ? `<small>${epithet}</small>` : ""}
      <h2 id="${esc(lord.heading.id)}">${name}</h2>
      ${body ? `<div class="tomb-text">${body}</div>` : ""}
    </div>
  </li>`;
}
function renderValley(page, plan, options) {
  const list = vaults();
  const index = list.indexOf(page);
  const numeral = vaultNumeral(page) || "◆";
  let side = 0;
  app.innerHTML = `<article class="page valley">
    <header class="valley-head">
      ${crumbs([{ href: "/", label: "The Gate" }, ...(page.node ? ancestors(page).map((item) => ({ href: nodeHref(item), label: nodeTitle(item) })) : []), { label: page.title }])}
      <p class="eyebrow">${index >= 0 ? `Vault ${numeral} · ` : ""}${plural(plan.lords.length, "spirit")} at rest</p>
      <h1 data-decrypt>${esc(page.title)}</h1>
      ${plan.intro.length ? `<div class="valley-intro">${blocksHtml(plan.intro)}</div>` : ""}
      <a class="valley-cue" href="#${esc(plan.lords[0].heading.id)}" data-scroll>Walk the valley <span aria-hidden="true">↓</span></a>
    </header>
    <div class="valley-walk">
      <div class="canyon" aria-hidden="true">
        <div class="canyon-sky"></div>
        <div class="canyon-wall far left"></div><div class="canyon-wall far right"></div>
        <div class="canyon-wall near left"></div><div class="canyon-wall near right"></div>
        <div class="canyon-dust">${Array.from({ length: 14 }, (_, i) => `<i style="--y:${(seededRandom(`dust${i}`) * 100).toFixed(1)}%;--t:${(9 + seededRandom(`dust${i}t`) * 10).toFixed(1)}s;--d:${(-seededRandom(`dust${i}d`) * 18).toFixed(1)}s;--s:${(.5 + seededRandom(`dust${i}s`) * 1.2).toFixed(2)}"></i>`).join("")}</div>
      </div>
      <div class="valley-path" aria-hidden="true"></div>
      <ol class="tombs">${plan.lords.map((lord, i) => tombHtml(lord, i, lord.emperor ? "" : (side++ % 2 ? "right" : "left"))).join("")}</ol>
      <p class="valley-end">The valley falls silent.</p>
    </div>
    ${plan.after.length ? `<div class="prose chamber-prose">${blocksHtml(plan.after)}</div>` : ""}
    ${passage(index > 0 ? list[index - 1] : null, index >= 0 && index < list.length - 1 ? list[index + 1] : null, "vault", pageHref, (item) => item.title)}
  </article>`;
  afterRender(options);
  setupScrubber(page.headings);
  startValleyWalk();
}
/* As you walk, each statue's --near (0 far, 1 level with you) wakes it from stone, and the
 * canyon walls slide past at two depths. */
const valleyWalk = { walk: null, tombs: [], frame: 0 };
function startValleyWalk() {
  valleyWalk.walk = app.querySelector(".valley-walk");
  valleyWalk.tombs = [...app.querySelectorAll(".tomb")];
  updateValleyWalk();
}
function updateValleyWalk() {
  valleyWalk.frame = 0;
  const { walk, tombs } = valleyWalk;
  if (!walk?.isConnected) { valleyWalk.walk = null; return; }
  const box = walk.getBoundingClientRect();
  walk.style.setProperty("--walk", Math.min(1, Math.max(0, -box.top / Math.max(1, box.height - innerHeight))).toFixed(4));
  for (const tomb of tombs) {
    const r = tomb.getBoundingClientRect();
    const offset = Math.abs(r.top + r.height / 2 - innerHeight * .5) / (innerHeight * .65);
    tomb.style.setProperty("--near", Math.max(0, 1 - offset).toFixed(3));
  }
}
window.addEventListener("scroll", () => { if (valleyWalk.walk && !valleyWalk.frame) valleyWalk.frame = requestAnimationFrame(updateValleyWalk); }, { passive: true });
window.addEventListener("resize", () => { if (valleyWalk.walk) updateValleyWalk(); });

/* ───────── The catalogue: every linked file, A to Z ───────── */
let catalogueFilter = { kind: "all", text: "" };
const sortName = (file) => fileTitle(file).replace(/^(TSO|LA|DHG|TJO)\s*[|:\-–]\s*/i, "").trim();
function renderCatalogue(options) {
  document.title = "Catalogue — TSO Central Archives";
  const files = [...state.site.files].sort((a, b) => sortName(a).localeCompare(sortName(b), "en", { sensitivity: "base" }));
  const kinds = [...new Set(files.map((file) => file.kind))];
  const letterOf = (file) => { const first = sortName(file).charAt(0).toUpperCase(); return /[A-Z]/.test(first) ? first : "#"; };
  const groups = new Map();
  for (const file of files) { const letter = letterOf(file); if (!groups.has(letter)) groups.set(letter, []); groups.get(letter).push(file); }
  const alphabet = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  catalogueFilter = { kind: "all", text: "" };
  app.innerHTML = `<div class="page catalogue-page">
    <header class="chamber-head">
      <span class="chamber-numeral" aria-hidden="true">A–Z</span>
      ${crumbs([{ href: "/", label: "The Gate" }, { label: "Catalogue" }])}
      <p class="eyebrow">Every record on file</p>
      <h1 data-decrypt>The Catalogue</h1>
      <div class="catalogue-tools">
        <div class="kind-filter" role="group" aria-label="Filter by kind">
          <button type="button" data-kind="all" aria-pressed="true">All <small>${files.length}</small></button>
          ${kinds.length > 1 ? kinds.map((kind) => `<button type="button" data-kind="${kind}" aria-pressed="false">${kindIcon(kind)}${esc(KIND[kind]?.plural || kind)} <small>${files.filter((file) => file.kind === kind).length}</small></button>`).join("") : ""}
        </div>
        ${files.length > 4 ? `<label class="filter"><span aria-hidden="true">›</span><input id="catalogueFilter" type="search" placeholder="filter the catalogue" autocomplete="off" spellcheck="false" aria-label="Filter records" /></label>` : ""}
      </div>
    </header>
    ${files.length ? `<nav class="alpha-bar" aria-label="Jump to letter">${alphabet.map((letter) => (groups.has(letter) ? `<a href="#drawer-${letter === "#" ? "num" : letter}" data-scroll>${letter}</a>` : `<span>${letter}</span>`)).join("")}</nav>
    <section class="catalogue" id="catalogue">${[...groups.entries()].map(([letter, items]) => `<div class="drawer" data-drawer>
      <h2 class="drawer-letter" id="drawer-${letter === "#" ? "num" : letter}">${letter}</h2>
      <div class="slips">${items.map((file) => slipHtml(file)).join("")}</div>
    </div>`).join("")}</section>` : `<p class="no-match">No records have been filed in the archive yet.</p>`}
    <p class="no-match" id="catalogueEmpty" hidden>No records match that filter.</p>
  </div>`;
  const apply = () => {
    let shown = 0;
    app.querySelectorAll("[data-drawer]").forEach((drawer) => {
      let inDrawer = 0;
      drawer.querySelectorAll(".slip").forEach((slip) => {
        const file = fileByKey(slip.dataset.prefetch);
        const hit = (catalogueFilter.kind === "all" || file.kind === catalogueFilter.kind) && (!catalogueFilter.text || `${fileTitle(file)} ${fileVault(file) ? trail(fileVault(file)) : ""} ${KIND[file.kind]?.label} ${fileRefNo(file)}`.toLowerCase().includes(catalogueFilter.text));
        slip.hidden = !hit; if (hit) inDrawer += 1;
      });
      drawer.hidden = !inDrawer; shown += inDrawer;
    });
    byId("catalogueEmpty").hidden = shown > 0 || !files.length;
  };
  app.querySelectorAll(".kind-filter button").forEach((button) => button.addEventListener("click", () => {
    catalogueFilter.kind = button.dataset.kind;
    app.querySelectorAll(".kind-filter button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    apply();
  }));
  byId("catalogueFilter")?.addEventListener("input", (event) => { catalogueFilter.text = event.target.value.trim().toLowerCase(); apply(); });
  afterRender(options);
}

/* ───────── Records ───────── */
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
const originalLink = (file) => `<a class="tool" href="${esc(originalUrl(file))}" target="_blank" rel="noopener">Open in ${esc(KIND[file.kind]?.app || "Google Drive")} ↗</a>`;
/* A record opens as a dossier: the title on the left, its file card on the right. */
function dossierHead(file, length = "…", status = "Decrypting") {
  const vault = fileVault(file);
  return `<header class="file-head">
      <div class="file-head-main">
        ${crumbs([{ href: "/", label: "The Gate" }, ...(vault ? (vault.node ? crumbTrail(vault.node) : [{ href: pageHref(vault), label: vault.title }]) : [{ href: "/codex", label: "Catalogue" }]), { label: fileTitle(file) }])}
        <p class="eyebrow">${kindIcon(file.kind)}${esc(KIND[file.kind]?.label || "File")}</p>
        <h1 data-decrypt data-file-name="${esc(file.key)}">${esc(fileTitle(file))}</h1>
      </div>
      <dl class="file-card">
        <div><dt>Reference</dt><dd>${esc(fileRefNo(file))}</dd></div>
        <div><dt>Vault</dt><dd>${vault ? `<a href="${pageHref(vault)}" data-link>${esc(trail(vault))}</a>` : "The gate"}</dd></div>
        <div><dt>Source</dt><dd>${esc(KIND[file.kind]?.app || "Google Drive")}</dd></div>
        <div><dt>Length</dt><dd id="fileLength">${esc(length)}</dd></div>
        <div><dt>Status</dt><dd id="fileStatus" class="status">${esc(status)}</dd></div>
      </dl>
    </header>
    <div class="file-tools" id="fileTools">${originalLink(file)}</div>`;
}
function setStatus(text, sealed = false) {
  const node = byId("fileStatus");
  if (node) { node.textContent = text; node.classList.toggle("sealed-status", sealed); }
}
function siblingsNav(file) {
  const files = state.site.files;
  const index = files.findIndex((item) => item.key === file.key);
  if (index < 0 || files.length < 2) return "";
  return passage(index > 0 ? files[index - 1] : null, index < files.length - 1 ? files[index + 1] : null, "record", fileHref, fileTitle);
}
function renderFile(file, options) {
  document.title = `${fileTitle(file)} — TSO Central Archives`;
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

/* Every record opens as itself: Google's own viewer for the document, sheet, deck, form or
 * file, framed in the archive. (Rebuilding them here lost too much of their formatting.) */
function viewerFrame(file) {
  const id = encodeURIComponent(file.id), pub = file.pub ? "e/" : "", gid = file.gid ? encodeURIComponent(file.gid) : "";
  return {
    document: { src: file.pub ? `https://docs.google.com/document/d/e/${id}/pub?embedded=true` : `https://docs.google.com/document/d/${id}/preview`, shape: "page" },
    spreadsheets: { src: file.pub ? `https://docs.google.com/spreadsheets/d/e/${id}/pubhtml?widget=true&headers=false${gid ? `&gid=${gid}` : ""}` : `https://docs.google.com/spreadsheets/d/${id}/preview${gid ? `#gid=${gid}` : ""}`, shape: "page" },
    presentation: { src: `https://docs.google.com/presentation/d/${pub}${id}/embed?start=false&loop=false&delayms=6000`, shape: "slides" },
    forms: { src: `https://docs.google.com/forms/d/${pub}${id}/viewform?embedded=true`, shape: "tall" },
    file: { src: `https://drive.google.com/file/d/${id}/preview`, shape: "tall" },
    folder: { src: `https://drive.google.com/embeddedfolderview?id=${id}#grid`, shape: "folder" }
  }[file.kind];
}
function renderViewer(file, options) {
  const token = state.renderToken;
  const frame = viewerFrame(file);
  const kind = KIND[file.kind] || KIND.file;
  const drawing = `/api/img?u=${encodeURIComponent(`https://docs.google.com/drawings/d/${file.id}/export/png`)}`;
  const view = file.kind === "drawings"
    ? `<div class="viewer-image"><button data-zoom="${drawing}" aria-label="Enlarge drawing"><img src="${drawing}" alt="${esc(fileTitle(file))}" /></button></div>`
    : `<iframe src="${esc(frame.src)}" title="${esc(fileTitle(file))}" allow="fullscreen" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
  const vault = fileVault(file);
  const related = vault ? vault.fileKeys.map(fileByKey).filter((item) => item && item.key !== file.key) : [];
  app.innerHTML = `<article class="page dossier viewer-page">${dossierHead(file, "—", "Open")}
    <section class="viewer viewer-${frame?.shape || "image"}" aria-label="${esc(kind.label)}">
      <header class="viewer-bar">
        <span class="viewer-kind">${kindIcon(file.kind)}${esc(kind.label)}</span>
        <span class="viewer-name" data-file-name="${esc(file.key)}">${esc(fileTitle(file))}</span>
        <a class="viewer-out" href="${esc(originalUrl(file))}" target="_blank" rel="noopener">Open in ${esc(kind.app)} ↗</a>
      </header>
      <div class="viewer-body">${view}</div>
    </section>
    <p class="viewer-note">Shown here exactly as it is in ${esc(kind.app)}. If it stays blank, the record has not been shared publicly — open it in ${esc(kind.app)} instead.</p>
    ${related.length ? `${SABER_RULE(`More holocrons from ${vault.title}`)}<div class="stacks">${shelfHtml(related)}</div>` : ""}
    ${siblingsNav(file)}
  </article>`;
  byId("fileTools")?.remove(); // the frame's own bar carries the link out
  afterRender(options);
  // A document's length still comes from its text (also used by the archive's search).
  if (file.kind === "document") loadDoc(file).then((doc) => {
    if (token !== state.renderToken) return;
    if (doc.error) { if (doc.error !== "error") setStatus(doc.error === "missing" ? "Struck" : "Sealed", true); return; }
    byId("fileLength").textContent = `${readingMinutes(doc.words)} min · ${doc.words.toLocaleString("en-GB")} words`;
  });
}

function renderNotFound() {
  document.title = "Record not found — TSO Central Archives";
  app.innerHTML = `<div class="empty-page">${glyph("void")}<h1>Nothing is filed here</h1><p>This reference does not exist in the archive, or it has been struck from the record.</p><a class="btn" href="/" data-link>Return to the gate</a></div>`;
  afterRender();
}

/* ───────── The Path Picker (/paths) ─────────
 * A short reading of what draws someone to the dark side. Every answer adds weight to a
 * set of traits; each pathway and division carries its own trait profile, and the match is
 * the cosine similarity between the two, stretched so a strong fit reads in the 80s–90s.
 * A main sphere (one per member, joined as both its pathway and its division) is scored on
 * its members together; side spheres are scored alone. The board beside the questions
 * updates with every answer. Answers live in memory, so leaving and coming back keeps them. */
const PP_TRAITS = {
  combat: "Front-line combat", stealth: "Stealth & infiltration", lore: "Lore & world-building",
  events: "Running events", community: "Community & diplomacy", law: "Law & judgement",
  teaching: "Teaching & mentoring", guard: "Protection & loyalty", enforce: "Enforcing doctrine", lead: "Command"
};
const PP_PATHS = [
  { id: "juggernaut", kind: "pathway", name: "Juggernaut", sphere: "Imperial Conquest",
    blurb: "Masters of the lightsaber and the most combat-oriented pathway. First deployed when a raid is announced, holding back every enemy they face.",
    entry: "Trial of Courage, from Warrior", minRank: 2, t: { combat: 3, lead: 1, guard: 1 } },
  { id: "sorcerer", kind: "pathway", name: "Sorcerer", sphere: "Ancient Knowledge",
    blurb: "Keepers of the Order's history, lore and mysteries. They build world-building events, relics and archive records, often with the Dread Hosts.",
    entry: "Warrior+ · see the SoAK guidelines", minRank: 2, t: { lore: 3, events: 2, teaching: 1, community: 1 } },
  { id: "assassin", kind: "pathway", name: "Assassin", sphere: "Imperial Judgement",
    blurb: "Trained to move unseen, infiltrate, gather intelligence and eliminate targets through contracts. Held as the most disciplined of the Order.",
    entry: "Warrior+ · see the POA guidelines", minRank: 2, t: { stealth: 3, combat: 2, enforce: 1 } },
  { id: "dark-honor-guard", kind: "pathway", name: "Dark Honor Guard", sphere: "The Emperor's detachment",
    blurb: "Personal protectors of the Emperor. They lock down spawn points and strongholds, and answer only to the Powerbase and the Emperor.",
    entry: "Guardsmen Academy, Acolyte+", minRank: 1,
    warn: "Joining means leaving the main Sith progression. You can only join divisions linked to the Guard.",
    t: { guard: 3, combat: 2, enforce: 1 } },
  { id: "galactic-influence", kind: "pathway", name: "Galactic Influence", sphere: "Galactic Influence",
    blurb: "Diplomacy with the Jedi Order, propaganda, community events, game nights and moderation. Keeps the whole Order active.",
    entry: "Application, Acolyte+", minRank: 1, t: { community: 3, events: 2, lead: 1 } },
  { id: "courts-and-appeals", kind: "pathway", name: "Courts and Appeals", sphere: "Courts and Appeals",
    blurb: "The final arbiter on appeals against blacklists, rank-locks and SR deductions. Imperial Accusers prosecute; Imperial Advocates defend.",
    entry: "Application, Acolyte+", minRank: 1, t: { law: 3, enforce: 1, lead: 1 } },
  { id: "education-and-academics", kind: "pathway", name: "Education and Academics", sphere: "Education & Academics",
    blurb: "The Sith Academy: an alternative route for Acolytes without a master. Dark Mentors run training; Sith Instructors host Warrior Trials.",
    entry: "Application, Acolyte+", minRank: 1, t: { teaching: 3, lead: 1, community: 1 } },
  { id: "inquisitors", kind: "division", name: "Inquisitors", sphere: "Imperial Judgement",
    blurb: "Enforcers of Sith Doctrine who root out heresy and weakness, and take reports against members of the Order.",
    entry: "Tryout, from Acolyte · led by the Grand Inquisitor", minRank: 1, t: { enforce: 3, stealth: 1, law: 1, guard: 1 } },
  { id: "reavers", kind: "division", name: "Reavers", sphere: "Imperial Conquest",
    blurb: "Specialised Juggernauts, the elite of the elite. Berserkers used for crowd control, drawing in and cutting down as many enemies as they can.",
    entry: "Tryout, from Acolyte · led by The Overlord", minRank: 1, t: { combat: 3, enforce: 1 } },
  { id: "dread-hosts", kind: "division", name: "Dread Hosts", sphere: "Ancient Knowledge",
    blurb: "Event architects under the Dread Masters. Every gathering they run is a deliberate show of the Empire's power.",
    entry: "Tryout, from Acolyte · led by the Harbinger of Fear", minRank: 1, t: { events: 3, lore: 1, enforce: 1 } }
];
const PP_MAIN = [
  { id: "conquest", name: "Imperial Conquest", members: ["juggernaut", "reavers"] },
  { id: "knowledge", name: "Ancient Knowledge", members: ["sorcerer", "dread-hosts"] },
  { id: "judgement", name: "Imperial Judgement", members: ["assassin", "inquisitors"] },
  { id: "guard", name: "Dark Honor Guard", members: ["dark-honor-guard"] }
];
const PP_SIDE = ["galactic-influence", "courts-and-appeals", "education-and-academics"];
const PP_STEPS = [
  { type: "multi", title: "What interests you?", hint: "Pick everything that catches your eye.",
    opts: [
      ["Lightsaber duels", { combat: 2 }],
      ["Leading raids and battles", { combat: 1, lead: 2 }],
      ["Striking unseen", { stealth: 2 }],
      ["Hunting contract targets", { stealth: 1, enforce: 1 }],
      ["Sith lore and holocrons", { lore: 2 }],
      ["Writing stories and world-building", { lore: 2, events: 1 }],
      ["Hosting events and game nights", { events: 2, community: 1 }],
      ["Diplomacy with the Jedi Order", { community: 2 }],
      ["Keeping the community active", { community: 2 }],
      ["Law, evidence and debate", { law: 2 }],
      ["Teaching and mentoring", { teaching: 2 }],
      ["Guarding the Emperor", { guard: 2 }],
      ["Holding a spawn point", { guard: 1, combat: 1 }],
      ["Rooting out traitors", { enforce: 2 }]
    ] },
  { type: "single", title: "A raid on the Jedi is announced. Where are you?",
    opts: [
      ["First through the gate, saber lit.", { combat: 2 }],
      ["Behind their lines, waiting for their commander to turn his back.", { stealth: 2, combat: 1 }],
      ["Guarding the VIP so no one gets near them.", { guard: 2 }],
      ["Calling formations and telling everyone where to go.", { lead: 2, combat: 1 }]
    ] },
  { type: "single", title: "Pick your ideal night in the Order.",
    opts: [
      ["A dueling tournament.", { combat: 2 }],
      ["A story campaign where we uncover a lost Sith vault.", { lore: 2, events: 1 }],
      ["A game night I host for everyone.", { events: 2, community: 1 }],
      ["A hearing where I argue an appeal.", { law: 2 }]
    ] },
  { type: "single", title: "A Sith breaks the rules. What do you do?",
    opts: [
      ["Hunt them down and make an example of them.", { enforce: 2, stealth: 1 }],
      ["Gather the evidence and build the case.", { law: 2 }],
      ["Take them aside and teach them better.", { teaching: 2 }],
      ["Report it. My duty is to the Emperor's safety.", { guard: 2 }]
    ] },
  { type: "single", title: "What reward would mean the most?",
    opts: [
      ["Ranking up by passing combat trials.", { combat: 2, lead: 1 }],
      ["Unique armour and duties no other Sith receives.", { guard: 2 }],
      ["Seeing my story become canon in the Archives.", { lore: 2 }],
      ["Watching someone I trained pass their Warrior Trials.", { teaching: 2 }],
      ["Being the reason everyone shows up to an event.", { events: 1, community: 2 }]
    ] },
  { type: "single", creed: true, title: "Which creed sounds like you?",
    opts: [
      ["We are the Emperor's guard. We protect him. Kill for him. Die for him.", { guard: 3 }],
      ["By the decrees of the law, we bend the ambitious.", { law: 3 }],
      ["Through manipulation, mass deception and diplomacy, we shall rule the galaxy.", { community: 3 }],
      ["We do not merely teach you to survive the dark side; we teach you to command it.", { teaching: 3 }],
      ["Their combative prowess matches an army easily.", { combat: 3 }],
      ["Ultimate power allows no room for weakness.", { enforce: 3 }],
      ["Every gathering is a deliberate exertion of power.", { events: 3 }]
    ] },
  { type: "single", rank: true, title: "What rank are you now?", hint: "Used only to flag what you can join today.",
    opts: [["Not in the Order yet", 0], ["Acolyte", 1], ["Warrior", 2], ["Above Warrior", 3]] }
];
const picker = { step: 0, answers: PP_STEPS.map((s) => (s.type === "multi" ? new Set() : null)), info: null };
const ppById = Object.fromEntries(PP_PATHS.map((p) => [p.id, p]));
const ppHref = (p) => `/p/${p.kind === "division" ? "divisions" : "pathways"}/${p.id}`;

function ppVector() {
  const v = Object.fromEntries(Object.keys(PP_TRAITS).map((k) => [k, 0]));
  PP_STEPS.forEach((s, i) => {
    if (s.rank) return;
    const a = picker.answers[i];
    const picks = s.type === "multi" ? [...a] : a == null ? [] : [a];
    picks.forEach((j) => { for (const [k, w] of Object.entries(s.opts[j][1])) v[k] += w; });
  });
  return v;
}
function ppMatch(u, t) {
  let dot = 0, nu = 0, nt = 0;
  for (const k in PP_TRAITS) { const a = u[k] || 0, b = t[k] || 0; dot += a * b; nu += a * a; nt += b * b; }
  if (!nu) return 0;
  return Math.round(Math.max(0, Math.min(1, (dot / Math.sqrt(nu * nt) - .05) / .92)) * 100);
}
function ppReasons(u, t) {
  return Object.keys(PP_TRAITS).filter((k) => u[k] > 0 && (t[k] || 0) > 0).sort((a, b) => u[b] * t[b] - u[a] * t[a]).slice(0, 3).map((k) => PP_TRAITS[k]);
}
function ppScores() {
  const u = ppVector();
  const scored = Object.fromEntries(PP_PATHS.map((p) => [p.id, { ...p, pct: ppMatch(u, p.t) }]));
  const main = PP_MAIN.map((m) => {
    const t = {};
    m.members.forEach((id) => { for (const [k, w] of Object.entries(scored[id].t)) t[k] = (t[k] || 0) + w; });
    return { ...m, members: m.members.map((id) => scored[id]), pct: ppMatch(u, t), why: ppReasons(u, t) };
  }).sort((a, b) => b.pct - a.pct);
  const side = PP_SIDE.map((id) => ({ ...scored[id], why: ppReasons(u, scored[id].t) })).sort((a, b) => b.pct - a.pct);
  return { main, side };
}
function ppRank() { const last = PP_STEPS.length - 1, r = picker.answers[last]; return r == null ? null : PP_STEPS[last].opts[r][1]; }
function ppEligibility(p) {
  const r = ppRank();
  if (r == null || p.minRank == null) return null;
  if (p.maxRank != null && r > p.maxRank) return { ok: false, text: "Only open to Acolytes and Warriors" };
  if (r >= p.minRank) return { ok: true, text: "Open to you at your rank" };
  return { ok: false, text: p.minRank === 2 ? "Unlocks at Warrior" : "Unlocks once you reach Acolyte" };
}

function renderPicker(options) {
  document.title = "Path Picker — TSO Central Archives";
  app.innerHTML = `<div class="page picker-page">
    <header class="chamber-head">
      <span class="chamber-numeral" aria-hidden="true">✠</span>
      ${crumbs([{ href: "/", label: "The Gate" }, { label: "Path Picker" }])}
      <p class="eyebrow">Find your place in the Order</p>
      <h1 data-decrypt>The Path Picker</h1>
      <p class="pp-lede">Tell the Archives what draws you to the dark side. You will be given one main sphere, where you join both its pathway and its division, and a side sphere to take on alongside it. Every answer moves the readings on the board.</p>
    </header>
    ${SABER_RULE("Explore the spheres")}
    <section class="pp-explore" aria-label="Explore the spheres">
      <p class="pp-exhead">Press any one to learn what it does</p>
      <div class="pp-groups" id="ppGroups"></div>
      <div class="pp-info" id="ppInfo" hidden></div>
    </section>
    ${SABER_RULE("The reading")}
    <div class="pp-grid">
      <section class="pp-quiz" id="ppQuiz" aria-live="polite"></section>
      <aside class="pp-readout" aria-label="Live match readout">
        <div class="pp-board"><h3><span>Main spheres · pick one</span><span>Match</span></h3><div id="ppMain"></div></div>
        <div class="pp-board"><h3><span>Side spheres</span><span>Match</span></h3><div id="ppSide"></div></div>
      </aside>
    </div>
  </div>`;
  ppExplore(); ppBoard(); ppStep();
  afterRender(options);
}
function ppBoard() {
  const { main, side } = ppScores();
  const any = main.some((p) => p.pct > 0) || side.some((p) => p.pct > 0);
  const row = (p, i, sub) => `<div class="pp-row${any && i === 0 && p.pct > 0 ? " top" : ""}">
      <span class="pp-nm">${esc(p.name)}</span><span class="pp-pc">${any ? `${p.pct}%` : "—"}</span>
      ${sub ? `<span class="pp-sub">${esc(sub)}</span>` : ""}
      <span class="pp-bar"><i style="width:${p.pct}%"></i></span>
    </div>`;
  byId("ppMain").innerHTML = main.map((m, i) => row(m, i, m.members.length > 1 ? m.members.map((p) => p.name).join(" + ") : "Stands apart · no division")).join("");
  byId("ppSide").innerHTML = side.map((p, i) => row(p, i)).join("");
}
function ppCanAdvance() {
  const a = picker.answers[picker.step];
  return PP_STEPS[picker.step].type === "multi" ? a.size > 0 : a != null;
}
function ppStep() {
  const q = byId("ppQuiz");
  if (!q) return;
  const total = PP_STEPS.length, step = picker.step;
  const progress = `<div class="pp-progress" aria-hidden="true">${PP_STEPS.map((_, i) => `<span class="${i < step || step >= total ? "done" : i === step ? "here" : ""}"></span>`).join("")}</div>`;
  if (step >= total) return ppResult(q, progress);
  const s = PP_STEPS[step], a = picker.answers[step];
  const body = s.type === "multi"
    ? `<div class="pp-chips">${s.opts.map((o, j) => `<button type="button" class="pp-chip" id="pp${step}_${j}" data-j="${j}" aria-pressed="${a.has(j)}">${esc(o[0])}</button>`).join("")}</div>`
    : `<div class="pp-opts${s.creed ? " creeds" : ""}">${s.opts.map((o, j) => `<button type="button" class="pp-opt" id="pp${step}_${j}" data-j="${j}" aria-pressed="${a === j}"><span class="pp-mark" aria-hidden="true"></span><span>${esc(o[0])}</span></button>`).join("")}</div>`;
  q.innerHTML = `${progress}
    <div class="pp-qhead"><p class="pp-qnum">Question ${step + 1} of ${total}</p><h2>${esc(s.title)}</h2>${s.hint ? `<p class="pp-hint">${esc(s.hint)}</p>` : ""}</div>
    ${body}
    <div class="pp-nav">
      <button type="button" class="btn" id="ppBack"${step === 0 ? " disabled" : ""}>Back</button>
      ${s.type === "multi" ? `<span class="pp-count">${a.size} picked</span>` : ""}
      <button type="button" class="btn pp-next" id="ppNext"${ppCanAdvance() ? "" : " disabled"}>${step === total - 1 ? "Reveal my path" : "Next"}</button>
    </div>`;
  q.querySelectorAll("[data-j]").forEach((button) => button.addEventListener("click", () => {
    const j = Number(button.dataset.j);
    if (s.type === "multi") { if (a.has(j)) a.delete(j); else a.add(j); } else picker.answers[step] = j;
    ppBoard(); ppStep();
    byId(button.id)?.focus();
  }));
  byId("ppBack").addEventListener("click", () => { picker.step -= 1; ppStep(); });
  byId("ppNext").addEventListener("click", () => {
    picker.step += 1; ppStep();
    q.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
    if (picker.step >= total) ppRevealFx();
  });
}
/* The reveal: the reading card ignites, the sky flashes and the droid announces the sphere. */
function ppRevealFx() {
  const { main } = ppScores();
  skyFlash(.5);
  droidReact(`The Archives have read you. ${main[0].name} awaits.`);
  const card = app.querySelector(".pp-card.wide");
  if (!card || reducedMotion.matches || perf.lite) return;
  const box = card.getBoundingClientRect();
  for (let i = 0; i < 3; i += 1) setTimeout(() => strike(box.left + box.width * (.2 + Math.random() * .6), -10, box.left + box.width * (.15 + Math.random() * .7), box.top + 8, { width: 1.8, decay: .07 }), i * 110);
}
function ppMember(p, bare) {
  const el = ppEligibility(p);
  return `<div class="pp-member">
    ${bare ? "" : `<p class="pp-kind">${p.kind === "pathway" ? "Pathway" : "Division"}</p><h4>${esc(p.name)}</h4>`}
    <p>${esc(p.blurb)}</p>
    <p class="pp-meta">Entry: ${esc(p.entry)}</p>
    ${el ? `<p class="pp-flag${el.ok ? " ok" : ""}">${esc(el.text)}</p>` : ""}
    ${p.warn ? `<p class="pp-flag">${esc(p.warn)}</p>` : ""}
    <a class="pp-link" href="${ppHref(p)}" data-link>Read the ${esc(p.name)} vault →</a>
  </div>`;
}
const ppTags = (why) => (why.length ? `<div class="pp-tags">${why.map((w) => `<span>${esc(w)}</span>`).join("")}</div>` : "");
function ppResult(q, progress) {
  const { main, side } = ppScores();
  const top = main[0], runner = main[1], sideTop = side[0];
  const sideAlso = side.slice(1).filter((p) => p.pct >= 50);
  const joinNote = top.members.length > 1
    ? `In this sphere you join both: the ${top.members[0].name} pathway and the ${top.members[1].name} division. The division is open from Acolyte; the pathway opens at Warrior.`
    : "The Guard has no division of its own. It stands apart from the other spheres and answers only to the Powerbase and the Emperor.";
  q.innerHTML = `${progress}
    <div class="pp-result">
      <div class="pp-qhead"><p class="pp-qnum">Your reading</p><h2>Your main sphere is ${esc(top.name)}</h2></div>
      <article class="pp-card wide">
        <p class="pp-kind">Main sphere · you can hold only one</p>
        <div class="pp-big"><b>${esc(top.name)}</b><span>${top.pct}%</span></div>
        <p>${esc(joinNote)}</p>
        ${ppTags(top.why)}
        <div class="pp-duo">${top.members.map((p) => ppMember(p)).join("")}</div>
      </article>
      <article class="pp-card side">
        <p class="pp-kind">Side sphere · joined alongside your main</p>
        <div class="pp-big"><b>${esc(sideTop.name)}</b><span>${sideTop.pct}%</span></div>
        ${ppTags(sideTop.why)}
        ${sideTop.pct < 40 ? `<p class="pp-also">None of the side spheres stood out for you. This is the closest, and side spheres are optional.</p>` : ""}
        ${ppMember(sideTop, true)}
        ${sideAlso.length ? `<p class="pp-also">Also a good fit: ${sideAlso.map((p) => `${esc(p.name)} (${p.pct}%)`).join(", ")}.</p>` : ""}
      </article>
      <p class="pp-combo"><b>Runner-up main sphere: ${esc(runner.name)}</b> (${runner.pct}%). Main spheres can't be combined, so this is the one you would give up.</p>
      <div class="pp-nav">
        <button type="button" class="btn" id="ppBack">Change last answer</button>
        <button type="button" class="btn pp-next" id="ppAgain">Start over</button>
      </div>
    </div>`;
  byId("ppBack").addEventListener("click", () => { picker.step = PP_STEPS.length - 1; ppStep(); });
  byId("ppAgain").addEventListener("click", () => {
    PP_STEPS.forEach((s, i) => { picker.answers[i] = s.type === "multi" ? new Set() : null; });
    picker.step = 0; ppBoard(); ppStep();
    byId("ppQuiz").scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
  });
}
function ppExplore() {
  const pill = (id) => `<button type="button" class="pp-pill" id="ppx_${id}" data-id="${id}" aria-expanded="${picker.info === id}" aria-controls="ppInfo">${esc(ppById[id].name)}${ppById[id].kind === "division" ? "<small>division</small>" : ""}</button>`;
  byId("ppGroups").innerHTML = PP_MAIN.map((m) => `<div class="pp-group"><span>${esc(m.name)}</span><div>${m.members.map(pill).join("")}</div></div>`).join("")
    + `<div class="pp-group side"><span>Side spheres</span><div>${PP_SIDE.map(pill).join("")}</div></div>`;
  byId("ppGroups").querySelectorAll(".pp-pill").forEach((button) => button.addEventListener("click", () => {
    picker.info = picker.info === button.dataset.id ? null : button.dataset.id;
    ppExplore(); ppInfo();
    byId(button.id).focus();
  }));
}
function ppInfo() {
  const box = byId("ppInfo");
  if (!picker.info) { box.hidden = true; return; }
  const p = ppById[picker.info];
  const main = PP_MAIN.find((m) => m.members.includes(p.id));
  box.hidden = false;
  box.innerHTML = `<div class="pp-info-top"><p class="pp-kind">${main ? `${p.kind === "division" ? "Division" : "Pathway"} of the ${esc(main.name)} main sphere` : "Side sphere"}</p><button type="button" class="pp-x" id="ppInfoClose" aria-label="Close">×</button></div>
    <h3>${esc(p.name)}</h3><p>${esc(p.blurb)}</p>
    <p class="pp-meta">Entry: ${esc(p.entry)}</p>
    ${p.warn ? `<p class="pp-flag">${esc(p.warn)}</p>` : ""}
    <a class="pp-link" href="${ppHref(p)}" data-link>Open the ${esc(p.name)} vault →</a>`;
  byId("ppInfoClose").addEventListener("click", () => { const id = picker.info; picker.info = null; ppExplore(); ppInfo(); byId(`ppx_${id}`).focus(); });
}

/* ───────── The Guide to the Order (/guide) ─────────
 * A walk through the Order from the outside in: what it is, the low ranks, the three doors
 * to Acolyte, the Warrior Trial, the pathways and spheres, the Lords and the throne, and
 * where to go next. One chapter shows at a time beside an ascent of every chapter; "Where
 * do you stand?" jumps to the reader's rank and marks it. Requirements can be ticked off,
 * and the ticks, the chosen rank and the last chapter are remembered in this browser.
 * The wording comes from the Order's own Google Site pages (each chapter links its vault),
 * so update it here when those pages change. */
const GUIDE_KEY = "tso-guide-v1";
const GUIDE_LINKS = {
  roblox: "https://www.roblox.com/groups/16285251/The-Sith-rder#!/about",
  discord: "https://discord.gg/sithorder",
  doctrine: "https://law-portal.koolgos106.workers.dev/",
  dhgAcademy: "https://discord.gg/8mBAXjpUDS",
  srStore: "https://trello.com/b/L3ZVbnSw/sith-reputation-store-re-imagined",
  holocrons: "https://sith-hall-of-records.koolgos106.workers.dev/"
};
const GUIDE_RANKS = [
  ["outsider", "Not in the Order yet", "order"],
  ["minion", "Minion", "low"], ["hopeful", "Hopeful", "low"], ["initiate", "Initiate", "low"], ["adept", "Adept", "low"],
  ["acolyte", "Acolyte", "acolyte"], ["guard", "Dark Honor Guard", "acolyte"], ["apprentice", "Apprentice", "apprentice"],
  ["warrior", "Warrior", "warrior"], ["pathway", "Juggernaut · Sorcerer · Assassin", "paths"],
  ["advanced", "Marauder · Alchemist · Eradicator", "lords"], ["overseer", "Overseer", "lords"], ["lord", "Sith Lord or above", "throne"]
];
const guideReq = (id, text) => ({ id, text });
const GUIDE = [
  { id: "order", next: "Join the Roblox group and the communication server, and read the Sith Doctrine. You begin as a Minion: watch the server for your first training.", title: "The Order", kicker: "Begin here",
    quote: "Peace is a lie, there is only passion.",
    lead: "The Sith Order is an anti-peace-keeping organisation that seeks to assert domination over the galaxy through any means necessary. Where the Jedi use the Force in moderation to help those weaker than themselves, the Sith see it as a tool to gain power over them, and the two are kept in constant war.",
    body: ["The Order prizes skill, discipline and reputation above all else. Everything that follows is earned: every rank has a trial, and every trial has someone watching."],
    reqs: [guideReq("join-group", "Join the Roblox group"), guideReq("join-server", "Join the communication server"), guideReq("read-doctrine", "Read the Sith Doctrine")],
    extra: "code",
    links: [["Roblox group", GUIDE_LINKS.roblox, true], ["Communication server", GUIDE_LINKS.discord, true], ["Sith Doctrine", GUIDE_LINKS.doctrine, true]] },
  { id: "low", next: "Attend the trainings in order: Submission, then Strength, then Knowledge, and finally the Crystal Bleeding Ceremony. Each one moves you up a rank.", title: "The Low Ranks", kicker: "Minion to Adept",
    lead: "Minions to Adepts are the lowest of the low: new Force-sensitives who have yet to be trained in the ways of the Sith. Together they are the Low Ranks, and they rise by attending trainings to learn and prove their worth.",
    ranks: [
      { key: "minion", name: "Minion", quote: "It is refreshing to see the weakness of inferiors affirmed and exploited for gain.", text: "The first rank. Minions still wear a shock collar, are not yet considered Sith, and are treated as pawns by their superiors.", reqs: [guideReq("t-submission", "Complete the Training of Submission")] },
      { key: "hopeful", name: "Hopeful", quote: "Others were former Jedi who had been seduced by the dark side.", text: "The collar comes off. Hopefuls are officially members of the Order, though far from true Sith.", reqs: [guideReq("t-strength", "Complete the Training of Strength")] },
      { key: "initiate", name: "Initiate", quote: "For an initiate, there is nothing more important than gaining strength.", text: "Initiates have proven their value in combat and spilt blood in the name of the Emperor.", reqs: [guideReq("t-knowledge", "Complete the Training of Knowledge")] },
      { key: "adept", name: "Adept", quote: "Foolish Jedi! These are Sith Adepts!", text: "Adepts begin to taste the true power of the dark side, studying the deeds of the Lords before them.", reqs: [guideReq("t-crystal", "Complete the Crystal Bleeding Ceremony")] }
    ],
    links: [["Minion – Adept vault", "/p/sith-progression/minion-adept"]] },
  { id: "acolyte", next: "Pick your door. Show a Warrior you are worth training, or apply to the Sith Academy or the Guardsmen Academy. You can also try out for a division now.", title: "Three Doors", kicker: "Becoming an Acolyte",
    quote: "Watch yourself around those lot. Seen those Sith Acolytes torture people for less.",
    lead: "Acolytes stand at the precipice of becoming true Sith, marked by the first saber of their own, burning crimson. From here the Doctrine is enforced far more harshly. To rise, an Acolyte walks through one of three doors.",
    doors: [
      { name: "Be chosen as an Apprentice", text: "A Warrior or above sees potential in you and takes you on. The traditional road.", href: "/p/sith-progression/acolyte-warrior" },
      { name: "Enrol in the Sith Academy", text: "The alternative route for Acolytes without a master. Dark Mentors train you; Sith Instructors host Warrior Trials.", href: "/p/pathways/education-and-academics" },
      { key: "guard", name: "Enter the Guardsmen Academy", text: "Join the Emperor's Dark Honor Guard. The hardest entrance course in the Order.", warn: "You forsake the Sith progression and the chain of command, and may only join divisions linked to the Guard. In return only the Powerbase and the Emperor may command you.", href: "/p/pathways/dark-honor-guard", ext: ["Guardsmen Academy server", GUIDE_LINKS.dhgAcademy] }
    ],
    body: ["Divisions open now too. From Acolyte you can try out for the Reavers, the Dread Hosts or the Inquisitors, and apply to the side spheres. Going far within a division later needs its matching pathway."],
    reqs: [guideReq("door", "Be chosen, enrol in the Academy, or enter the Guardsmen Academy")],
    links: [["Acolyte – Warrior vault", "/p/sith-progression/acolyte-warrior"], ["Path Picker", "/paths"]] },
  { id: "apprentice", next: "Work through the Trials of an Apprentice with your master, give it at least two days, then take your Warrior Trial.", title: "The Apprentice", kicker: "Earning the Warrior Trial",
    quote: "It is the apprentice's duty to learn all that he can from the master, and the master's right to refrain from revealing all of his secrets.",
    lead: "An Apprentice has been chosen by a Warrior or above who sees in them a future pillar of the Order. Your task is to learn from your master and prepare for what is coming.",
    reqs: [guideReq("trials-apprentice", "Complete the Trials of an Apprentice"), guideReq("two-days", "Spend 2 or more days as an Apprentice"), guideReq("warrior-trial", "Pass the Warrior Trial")],
    note: "Fail the Warrior Trial and you must wait 24 hours before trying again.",
    record: "Trials of an Apprentice",
    links: [["Acolyte – Warrior vault", "/p/sith-progression/acolyte-warrior"]] },
  { id: "warrior", next: "Take on an apprentice of your own, host your events, and choose the pathway you will trial for.", title: "The Warrior", kicker: "True authority",
    quote: "A Sith Warrior's skills are unrivaled.",
    lead: "Many hold that you may only truly call yourself Sith once you pass the Warrior Trial. Warriors are the first to hold real authority: they raise apprentices of their own, and then walk a Pathway that suits them.",
    reqs: [guideReq("three-days", "Spend at least 3 days as a Warrior"), guideReq("apprentice-passed", "Have an Apprentice pass their Warrior Trial"), guideReq("five-events", "Host at least 5 events"), guideReq("pathway-trial", "Choose a Pathway and complete its trial")],
    sr: true,
    links: [["Acolyte – Warrior vault", "/p/sith-progression/acolyte-warrior"], ["Sith Reputation vault", "/p/sith-progression/sith-reputation"]] },
  { id: "paths", next: "Not sure which pathway fits you? Take the Path Picker, then read that pathway’s handbook in the Archives.", title: "Paths of Power", kicker: "Pathways and spheres",
    quote: "To follow down a path of power is to walk in the path of the ancients.",
    lead: "Every Warrior is expected to walk a Path of Power, and all progression after that follows it. Each Pathway belongs to a Sphere led by a Dark Councillor. You hold one main sphere, joining both its pathway and its division, and may take a side sphere alongside it.",
    spheres: true,
    links: [["Pathway Ranks vault", "/p/sith-progression/pathway-ranks"], ["Pathways", "/s/pathways"], ["Divisions", "/s/divisions"]] },
  { id: "lords", next: "Commit to your pathway and keep earning Sith Reputation. Overseers are chosen by the Lords for their dedication.", title: "Overseers and Lords", kicker: "The Lesser Councils",
    quote: "You are what Sith Lords scrape off their boots.",
    lead: "Reach your pathway's advanced rank and a Lord may raise you to Overseer for your relentless commitment. Overseers help their pathway's Lesser Council run it, set the example for every other Sith, and are expected to help in the Sith Academy unless their role belongs to a division.",
    reqs: [guideReq("advanced", "Reach Marauder, Alchemist or Eradicator"), guideReq("overseer", "Be selected as Overseer"), guideReq("lesser-council", "Be selected into a Lesser Council to become a Sith Lord")],
    councils: [["Council of Conquest", "Juggernauts"], ["Council of Dread", "Sorcerers · the Dread Masters"], ["Council of Shadow", "Assassins"], ["Council of Masters", "The Sith Academy"], ["Council of Influence", "Galactic Influence"], ["Council of Justice", "Courts and Appeals"]],
    body: ["The Lesser Councils are turbulent and ever-changing: every Lord is fighting for reputation and the notice of the Dark Council and the Emperor."],
    links: [["Overseer + vault", "/p/sith-progression/overseer"], ["The Sith Lords vault", "/p/sith-leadership/the-sith-lords"]] },
  { id: "throne", next: "Learn who leads the Order. You will meet these titles at events and in the server.", title: "The Throne", kicker: "Who rules the Order",
    quote: "Answerable only to the Force.",
    lead: "Above the Lords sits the Dark Council: one Councillor for each sphere, together able to change any part of the Order except the Powerbase. The Council is led by the Emperor's Voice. Above it is the Emperor's Powerbase, the true ruling body, chosen by the Emperor himself.",
    pyramid: true,
    links: [["Emperor's Powerbase vault", "/p/sith-leadership/emperors-powerbase"], ["The Dark Council vault", "/p/sith-leadership/the-dark-council"]] },
  { id: "beyond", next: "Come back to this guide each time you rank up. It remembers where you are.", title: "Beyond the Ranks", kicker: "Where to go next",
    lead: "The Archives hold more than ranks. These are the places every Sith should know.",
    places: [
      ["Find your path", "Seven questions to match you to a sphere, a pathway and a division.", "/paths"],
      ["The Holocron Network", "The Order's lore and legacy, kept by the Sphere of Ancient Knowledge.", "/p/holocron-network"],
      ["Valley of the Dark Lords", "Every former Emperor, Councillor and member of the Powerbase, remembered.", "/p/valley-of-the-dark-lords"],
      ["The Catalogue", "Every handbook and record on file, A to Z.", "/codex"],
      ["Report a member", "Concerned about someone? Contact the Grand or Lord Inquisitor. Cases about a Sith Lord or above go to the Dark Council.", "/p/divisions/inquisitors"],
      ["Appeal a punishment", "Blacklists, rank-locks and SR deductions for Warriors and above are reviewed by Courts and Appeals.", "/p/pathways/courts-and-appeals"]
    ] }
];
const GUIDE_SPHERES = [
  { name: "Imperial Conquest", ladder: ["Juggernaut", "Marauder", "Siege Lord"], division: "Reavers", path: "juggernaut", div: "reavers", note: "Masters of the saber, first through the gate." },
  { name: "Ancient Knowledge", ladder: ["Sorcerer", "Alchemist", "Sorcerer Lord"], division: "Dread Hosts", path: "sorcerer", div: "dread-hosts", note: "Keepers of lore, relics and the Order's events." },
  { name: "Imperial Judgement", ladder: ["Assassin", "Eradicator", "Decimator"], division: "Inquisitors", path: "assassin", div: "inquisitors", note: "Unseen hunters, and the enforcers of Doctrine." }
];
const GUIDE_THRONE = [
  { tier: "The Emperor", items: ["Darth Azazel"], href: "/p/sith-leadership/emperors-powerbase" },
  { tier: "The Emperor's Powerbase", items: ["Dark Regent", "Shield", "Wrath", "Voice", "Hand"], href: "/p/sith-leadership/emperors-powerbase" },
  { tier: "The Dark Council", items: ["Conquest", "Knowledge", "Judgement", "Education", "Influence", "Courts"], href: "/p/sith-leadership/the-dark-council" },
  { tier: "The Lesser Councils", items: ["Sith Lords of every pathway"], href: "/p/sith-leadership/the-sith-lords" },
  { tier: "Overseers", items: ["Siege Lord", "Sorcerer Lord", "Decimator"], href: "/p/sith-progression/overseer" },
  { tier: "Warriors and the pathways", items: ["Juggernaut", "Sorcerer", "Assassin"], href: "/p/sith-progression/pathway-ranks" },
  { tier: "Acolytes and Apprentices", items: ["The first true Sith"], href: "/p/sith-progression/acolyte-warrior" },
  { tier: "The Low Ranks", items: ["Minion", "Hopeful", "Initiate", "Adept"], href: "/p/sith-progression/minion-adept" }
];
const guide = { at: 0 };
function guideStore() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(GUIDE_KEY) || "{}") || {}; } catch {}
  return { done: new Set(saved.done || []), rank: saved.rank || "", at: Number.isInteger(saved.at) ? saved.at : 0 };
}
function guideSave(store) {
  try { localStorage.setItem(GUIDE_KEY, JSON.stringify({ done: [...store.done], rank: store.rank, at: guide.at })); } catch {}
}
const guideReqs = (ch) => [...(ch.reqs || []), ...(ch.ranks || []).flatMap((r) => r.reqs)];
function guideCheck(req, store) {
  return `<label class="gd-check"><input type="checkbox" data-req="${req.id}"${store.done.has(req.id) ? " checked" : ""} /><span class="gd-box" aria-hidden="true"></span><span>${esc(req.text)}</span></label>`;
}

function renderGuide(options = {}) {
  document.title = "Guide to the Order — TSO Central Archives";
  const store = guideStore();
  const hash = options.hash || location.hash;
  const fromHash = hash ? GUIDE.findIndex((ch) => `#${ch.id}` === hash) : -1;
  guide.at = fromHash >= 0 ? fromHash : Math.min(GUIDE.length - 1, Math.max(0, store.at));
  app.innerHTML = `<div class="page guide-page">
    <header class="chamber-head">
      <span class="chamber-numeral" aria-hidden="true">✦</span>
      ${crumbs([{ href: "/", label: "The Gate" }, { label: "New Player Guide" }])}
      <p class="eyebrow">New player guide · start here</p>
      <h1 data-decrypt>Guide to the Order</h1>
      <p class="pp-lede">Everything a new member needs, one step at a time: how to join, how to rise from Minion to Warrior, which path to walk, and who leads the Order. Pick your rank to jump to your next step, and tick off each requirement as you earn it.</p>
      <div class="gd-stand">
        <label for="gdRank">Where do you stand?</label>
        <select id="gdRank"><option value="">Choose your rank</option>${GUIDE_RANKS.map(([key, label]) => `<option value="${key}"${store.rank === key ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>
      </div>
    </header>
    <div class="gd-layout">
      <nav class="gd-ascent" id="gdAscent" aria-label="Chapters"></nav>
      <section class="gd-chapter" id="gdChapter" aria-live="polite"></section>
    </div>
  </div>`;
  byId("gdRank").addEventListener("change", (event) => {
    const s = guideStore(); s.rank = event.target.value;
    const rank = GUIDE_RANKS.find(([key]) => key === s.rank);
    if (rank) guide.at = GUIDE.findIndex((ch) => ch.id === rank[2]);
    guideSave(s); guideShow(true);
    if (rank) droidReact(rank[0] === "outsider" ? "An outsider. Start at the beginning." : `${rank[1].split(" · ")[0]}. Here is your next step.`);
  });
  guideShow(false);
  afterRender({ ...options, hash: "" });
}
function guideAscent(store) {
  byId("gdAscent").innerHTML = `<ol>${GUIDE.map((ch, i) => {
    const reqs = guideReqs(ch), done = reqs.filter((r) => store.done.has(r.id)).length;
    const rank = GUIDE_RANKS.find(([key]) => key === store.rank);
    return `<li><button type="button" class="gd-step${i === guide.at ? " here" : ""}${i < guide.at ? " passed" : ""}${rank && rank[2] === ch.id ? " is-you" : ""}" data-at="${i}"${i === guide.at ? ' aria-current="step"' : ""}>
      <em>${roman(i + 1)}</em><span><b>${esc(ch.title)}</b><small>${esc(ch.kicker)}</small></span>
      ${rank && rank[2] === ch.id ? `<i class="gd-you">You</i>` : reqs.length ? `<i class="gd-tally${done === reqs.length ? " full" : ""}">${done}/${reqs.length}</i>` : ""}
    </button></li>`;
  }).join("")}</ol>`;
  byId("gdAscent").querySelectorAll("[data-at]").forEach((button) => button.addEventListener("click", () => { guide.at = Number(button.dataset.at); guideShow(true); }));
}
function guideRecordLink(title) {
  const file = state.site.files.find((item) => fileTitle(item).toLowerCase() === title.toLowerCase());
  return file ? `<a class="gd-record" href="${fileHref(file)}" data-link>${kindIcon(file.kind)}<span>Read “${esc(fileTitle(file))}”</span></a>` : "";
}
/* The reader's rank belongs to this chapter but has no card of its own here: say so up top. */
function guideHere(ch, you) {
  const rank = GUIDE_RANKS.find(([key]) => key === you);
  if (!rank || rank[2] !== ch.id || ch.ranks?.some((r) => r.key === you) || ch.doors?.some((d) => d.key === you)) return "";
  return `<p class="gd-here"><i class="gd-you">You are here</i> ${esc(rank[1])}</p>`;
}
function guideChapterHtml(ch, store) {
  const you = store.rank;
  const link = ([label, href, external]) => `<a class="pp-link" href="${esc(href)}"${external ? ' target="_blank" rel="noopener"' : " data-link"}>${esc(label)} ${external ? "↗" : "→"}</a>`;
  let html = `<header class="gd-head"><span class="gd-num" aria-hidden="true">${roman(guide.at + 1)}</span><div><p class="pp-qnum">Chapter ${guide.at + 1} of ${GUIDE.length} · ${esc(ch.kicker)}</p><h2>${esc(ch.title)}</h2></div></header>
    ${guideHere(ch, you)}
    ${ch.quote ? `<blockquote class="gd-quote">${esc(ch.quote)}</blockquote>` : ""}
    <p class="gd-lead">${esc(ch.lead)}</p>`;
  if (ch.extra === "code") html += `<div class="gd-code"><p>Peace is a lie, there is only passion. Through passion, I gain strength. Through strength, I gain power. Through power, I gain victory. Through victory, my chains are broken. The Force shall free me.</p><button type="button" class="btn" id="gdCode">Hear the Code spoken</button></div>`;
  if (ch.ranks) html += `<ol class="gd-ranks">${ch.ranks.map((r) => `<li class="gd-rank${r.key === you ? " is-you" : ""}">
      <span class="gd-node" aria-hidden="true"></span>
      <div><h3>${esc(r.name)}${r.key === you ? ` <i class="gd-you">You are here</i>` : ""}</h3><p class="gd-rq">“${esc(r.quote)}”</p><p>${esc(r.text)}</p>${r.reqs.map((q) => guideCheck(q, store)).join("")}</div>
    </li>`).join("")}</ol>`;
  if (ch.doors) html += `<div class="gd-doors">${ch.doors.map((d, i) => `<article class="gd-door${d.key && d.key === you ? " is-you" : ""}">
      <span class="gd-door-num" aria-hidden="true">${roman(i + 1)}</span>
      <h3>${esc(d.name)}${d.key && d.key === you ? ` <i class="gd-you">You</i>` : ""}</h3><p>${esc(d.text)}</p>
      ${d.warn ? `<p class="pp-flag">${esc(d.warn)}</p>` : ""}
      ${link(["Read the vault", d.href])}${d.ext ? link([...d.ext, true]) : ""}
    </article>`).join("")}</div>`;
  if (ch.spheres) html += `<div class="gd-spheres">${GUIDE_SPHERES.map((s) => `<article class="gd-sphere">
      <h3>${esc(s.name)}</h3><p>${esc(s.note)}</p>
      <ol class="gd-ladder">${s.ladder.map((rank, i) => `<li${i === 0 ? ' class="entry"' : ""}><span>${esc(rank)}</span><small>${["Pathway", "Advanced", "Overseer"][i]}</small></li>`).join("")}</ol>
      <p class="pp-meta">Division: <a href="/p/divisions/${s.div}" data-link>${esc(s.division)}</a> · open from Acolyte</p>
      ${link([`The ${s.ladder[0]} vault`, `/p/pathways/${s.path}`])}
    </article>`).join("")}</div>
    <div class="gd-side"><p><b>Dark Honor Guard</b> stands apart: the Emperor's own detachment, with its own progression and no division.</p>
      <p><b>Side spheres</b> (Galactic Influence, Courts and Appeals, Education and Academics) are joined by application, alongside your main sphere.</p></div>
    <a class="gd-cta" href="/paths" data-link><span class="gd-cta-sigil" aria-hidden="true">✠</span><span><b>Not sure which path is yours?</b><small>Take the Path Picker: seven questions, one reading.</small></span><span aria-hidden="true">→</span></a>`;
  if (ch.councils) html += `<div class="gd-councils">${ch.councils.map(([name, rules]) => `<div><b>${esc(name)}</b><small>${esc(rules)}</small></div>`).join("")}</div>`;
  if (ch.pyramid) html += `<ol class="gd-pyramid">${GUIDE_THRONE.map((t, i) => `<li style="--i:${i}"><a href="${t.href}" data-link><b>${esc(t.tier)}</b><small>${t.items.map(esc).join(" · ")}</small></a></li>`).join("")}</ol>`;
  if (ch.places) html += `<div class="gd-places">${ch.places.map(([title, text, href]) => `<a class="gd-place" href="${href}" data-link><b>${esc(title)}</b><span>${esc(text)}</span></a>`).join("")}</div>`;
  for (const para of ch.body || []) html += `<p>${esc(para)}</p>`;
  if (ch.reqs) html += `<div class="gd-reqs"><p class="pp-kind">${ch.id === "order" ? "First steps" : "To rise"}</p>${ch.reqs.map((q) => guideCheck(q, store)).join("")}${ch.note ? `<p class="pp-flag">${esc(ch.note)}</p>` : ""}</div>`;
  if (ch.record) html += guideRecordLink(ch.record);
  if (ch.sr) html += `<div class="gd-sr"><p class="pp-kind">Sith Reputation</p><p>From Warrior you earn <b>Sith Reputation</b>, the currency of the Order: points for hosting events, training apprentices and pathway tasks. You need it to be promoted from Warrior to Overseer, and can spend it on privileges in the SR store. Co-hosting or supervising a training earns none.</p>${link(["SR store", GUIDE_LINKS.srStore, true])}</div>`;
  if (ch.next) html += `<div class="gd-next"><span class="gd-next-mark" aria-hidden="true">➜</span><div><p class="pp-kind">Your next step</p><p>${esc(ch.next)}</p></div></div>`;
  if (ch.links?.length) html += `<div class="gd-links">${ch.links.map(link).join("")}</div>`;
  const last = guide.at === GUIDE.length - 1;
  html += `<div class="pp-nav">
      <button type="button" class="btn" id="gdPrev"${guide.at === 0 ? " disabled" : ""}>← ${guide.at ? esc(GUIDE[guide.at - 1].title) : "Back"}</button>
      <button type="button" class="btn pp-next" id="gdNext">${last ? "Back to the beginning" : `${esc(GUIDE[guide.at + 1].title)} →`}</button>
    </div>`;
  return html;
}
function guideShow(scroll) {
  const box = byId("gdChapter");
  if (!box) return;
  const store = guideStore();
  const ch = GUIDE[guide.at];
  box.innerHTML = guideChapterHtml(ch, store);
  box.classList.remove("turn"); void box.offsetWidth; box.classList.add("turn");
  guideAscent(store); guideSave(store);
  history.replaceState(history.state, "", `/guide#${ch.id}`);
  box.querySelectorAll("[data-req]").forEach((input) => input.addEventListener("change", () => {
    const s = guideStore();
    if (input.checked) s.done.add(input.dataset.req); else s.done.delete(input.dataset.req);
    guideSave(s); guideAscent(s);
    const reqs = guideReqs(ch);
    if (input.checked && reqs.every((r) => s.done.has(r.id))) droidReact(ch.id === "order" ? "Welcome to the Order." : `${ch.title}: complete. Onward.`);
  }));
  byId("gdCode")?.addEventListener("click", () => reciteCode());
  byId("gdPrev").addEventListener("click", () => { guide.at = Math.max(0, guide.at - 1); guideShow(true); });
  byId("gdNext").addEventListener("click", () => {
    if (guide.at === GUIDE.length - 1) { guide.at = 0; } else guide.at += 1;
    if (guide.at === GUIDE.length - 1) droidReact("You have walked the whole path. Now go and earn it.");
    guideShow(true);
  });
  if (scroll) byId("gdChapter").scrollIntoView({ block: "start", behavior: reducedMotion.matches ? "auto" : "smooth" });
}
document.addEventListener("keydown", (event) => {
  if (parseRoute().view !== "guide" || !byId("gdChapter") || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "ArrowRight" && guide.at < GUIDE.length - 1) { guide.at += 1; guideShow(false); }
  if (event.key === "ArrowLeft" && guide.at > 0) { guide.at -= 1; guideShow(false); }
});

/* ───────── Chapter scrubber ─────────
 * Long pages get a scrubber along the bottom instead of a contents column: one notch per
 * chapter at its true position in the page, a blade that fills as you read, and the current
 * chapter's name. Click a notch to jump to it, or anywhere on the track to seek. */
const scrubber = { headings: [] };
function hideScrubber() { byId("scrubber").hidden = true; scrubber.headings = []; document.body.classList.remove("has-scrubber"); }
function setupScrubber(headings = []) {
  let usable = headings.filter((heading) => heading.level <= 3).map((heading) => ({ ...heading, el: byId(heading.id) })).filter((heading) => heading.el);
  // Long handbooks: keep the bar readable by marking only the major chapters.
  if (usable.length > 20 && usable.some((heading) => heading.level === 2)) usable = usable.filter((heading) => heading.level === 2);
  if (usable.length < 2) { hideScrubber(); return; }
  scrubber.headings = usable;
  byId("scrubTicks").innerHTML = usable.map((heading, index) => `<button type="button" class="scrub-tick${heading.level === 3 ? " minor" : ""}" data-tick="${index}" aria-label="Jump to ${esc(heading.text)}"><span>${esc(heading.text)}</span></button>`).join("");
  byId("scrubber").hidden = false;
  document.body.classList.add("has-scrubber");
  layoutScrubber();
  updateScrubber();
  setTimeout(layoutScrubber, 900); // images arriving can move every chapter
}
const scrollMax = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);
function layoutScrubber() {
  const ticks = byId("scrubTicks").children;
  scrubber.headings.forEach((heading, index) => {
    const y = heading.el.getBoundingClientRect().top + scrollY - innerHeight * .25;
    if (ticks[index]) ticks[index].style.left = `${(Math.min(1, Math.max(0, y / scrollMax())) * 100).toFixed(2)}%`;
  });
}
function updateScrubber() {
  if (!scrubber.headings.length) return;
  const progress = Math.min(1, scrollY / scrollMax());
  byId("scrubFill").style.transform = `scaleX(${progress})`;
  let current = -1;
  scrubber.headings.forEach((heading, index) => { if (heading.el.getBoundingClientRect().top < innerHeight * .3) current = index; });
  [...byId("scrubTicks").children].forEach((tick, index) => { tick.classList.toggle("passed", index <= current); tick.classList.toggle("current", index === current); });
  const label = current >= 0 ? scrubber.headings[current].text : "Opening";
  if (byId("scrubLabel").textContent !== label) byId("scrubLabel").textContent = label;
}
byId("scrubTrack").addEventListener("click", (event) => {
  const tick = event.target.closest("[data-tick]");
  if (tick) { scrubber.headings[Number(tick.dataset.tick)]?.el.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" }); return; }
  const box = byId("scrubTrack").getBoundingClientRect();
  scrollTo({ top: ((event.clientX - box.left) / box.width) * scrollMax(), behavior: reducedMotion.matches ? "auto" : "smooth" });
});
window.addEventListener("resize", () => { if (scrubber.headings.length) layoutScrubber(); }, { passive: true });

/* ───────── The terminal (search) ─────────
 * Vault pages are searchable straight away. Document text is pulled in the background the
 * first time the terminal opens (and reused when a document is opened), so full-text
 * matches appear as the index fills. */
let indexing = false;
async function indexDocuments() {
  if (indexing) return;
  const pending = state.site.files.filter((file) => file.kind === "document" && !docCache.get(file.key)?.value);
  if (!pending.length) return;
  indexing = true;
  let done = 0;
  const label = byId("searchIndexing");
  const update = () => { label.textContent = done < pending.length ? `indexing ${done}/${pending.length}` : ""; };
  update();
  for (let i = 0; i < pending.length; i += 3) {
    await Promise.all(pending.slice(i, i + 3).map((file) => loadDoc(file).then(() => { done += 1; update(); })));
    if (!byId("searchPanel").hidden && byId("globalSearch").value.trim()) renderSearch(byId("globalSearch").value);
  }
  indexing = false;
  update();
}
function searchItems() {
  const pages = state.site.pages.map((page) => ({ tag: page.path ? "VAULT" : "GATE", title: page.path ? page.title : `${state.site.name}`, text: page.text, href: pageHref(page), where: page.path ? `Vault ${vaultNumeral(page)}${ancestors(page).length ? ` · ${ancestors(page).map(nodeTitle).join(" › ")}` : ""}` : "The gate", ref: page.path ? `VAULT ${vaultNumeral(page)}` : "GATE" }));
  const files = state.site.files.map((file) => ({ tag: (KIND[file.kind]?.short || "File").toUpperCase(), file, title: fileTitle(file), text: docCache.get(file.key)?.value?.text || "", href: fileHref(file), where: [KIND[file.kind]?.label, fileVault(file) && trail(fileVault(file))].filter(Boolean).join(" · "), ref: fileRefNo(file) }));
  const pathPicker = { tag: "PATHS", title: "Path Picker", text: "Which pathway, division and sphere suits you? Juggernaut Sorcerer Assassin Dark Honor Guard Inquisitors Reavers Dread Hosts Galactic Influence Courts and Appeals Education and Academics", href: "/paths", where: "Find your place in the Order", ref: "✠" };
  const guidePage = { tag: "GUIDE", title: "New Player Guide", text: "New here? How to rise: Minion Hopeful Initiate Adept Acolyte Apprentice Warrior Trial pathway Overseer Sith Lord Dark Council Emperor's Powerbase Sith Reputation", href: "/guide", where: "New to the Order? How to join and rise, step by step", ref: "✦" };
  return [...files, ...pages, guidePage, pathPicker];
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
  const rank = (item) => (item.title.toLowerCase().startsWith(value) ? 0 : item.title.toLowerCase().includes(value) ? 1 : item.where.toLowerCase().includes(value) ? 2 : 3);
  const matches = items.filter((item) => !value || `${item.title} ${item.where} ${item.ref} ${item.text}`.toLowerCase().includes(value)).sort((a, b) => (value ? rank(a) - rank(b) : 0)).slice(0, 40);
  const letters = lettersOf(value);
  if (letters.length >= 5 && (CODE_WORDS.startsWith(letters) || letters.startsWith(CODE_WORDS))) matches.unshift({ recite: true, tag: "CODE", title: "Recite the Code of the Sith", where: "Peace is a lie, there is only passion…", ref: "◆", href: "#code" });
  // Someone searching "emperor" may want the Emperor's pages, so he waits just behind the best match.
  if (letters.length >= 3 && (letters === GUARD_WORD || (letters.length >= 5 && "darkhonorguard".startsWith(letters)))) matches.splice(Math.min(1, matches.length), 0, { summon: "guard", tag: "DHG", title: "Summon the Dark Honor Guard", where: "The Emperor's Shield. None shall pass.", ref: "◆", href: "#dhg" });
  if (letters === HAND_WORD) matches.splice(Math.min(1, matches.length), 0, { summon: "hand", tag: "HAND", title: "Summon the Emperor's Hand", where: "Darth Astarion, the Emperor's Hand", ref: "◆", href: "#hand" });
  if (letters.length >= Math.min(5, WRATH_WORD.length) && WRATH_WORD.startsWith(letters)) matches.splice(Math.min(1, matches.length), 0, { summon: "wrath", tag: "WRATH", title: "Summon the Emperor's Wrath", where: "Darth Aeravix, the Emperor's Wrath", ref: "◆", href: "#wrath" });
  if (letters.length >= 5 && VOICE_WORD.startsWith(letters)) matches.splice(Math.min(1, matches.length), 0, { summon: "voice", tag: "VOICE", title: "Summon the Emperor's Voice", where: "Darth Soteris, the Emperor's Voice", ref: "◆", href: "#voice" });
  if (letters.length >= 5 && REGENT_WORD.startsWith(letters)) matches.splice(Math.min(1, matches.length), 0, { summon: "regent", tag: "REGENT", title: "Summon the Dark Regent", where: "Darth Zephros, Dark Regent of the Sith", ref: "◆", href: "#regent" });
  if (letters.length >= 5 && EMPEROR_WORD.startsWith(letters)) matches.splice(Math.min(1, matches.length), 0, { summon: "emperor", tag: "EMPEROR", title: "Summon the Emperor", where: "Darth Azazel, the Sith Emperor", ref: "◆", href: "#emperor" });
  state.searchMatches = matches; state.searchIndex = 0;
  byId("searchCount").textContent = value ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}` : `${items.length} ${items.length === 1 ? "entry" : "entries"} on file`;
  const header = `<p class="term-sys">› ${value ? `scanning ${items.length} entries for “${esc(query.trim())}”` : "awaiting query · listing every entry on file"}</p>`;
  byId("searchResults").innerHTML = header + (matches.length ? matches.map((item, index) => `<a class="term-line${index === 0 ? " active" : ""}${item.recite || item.summon ? " term-code" : ""}" href="${item.href}" ${item.recite ? "data-recite" : item.summon ? `data-summon="${item.summon}"` : "data-link"} data-index="${index}">
      <span class="term-tag">[${esc(item.tag)}]</span>
      <span class="term-main"><strong>${highlight(item.title, value)}</strong><small>${esc(item.where)}</small>${item.text && value && !item.recite && !item.summon ? `<p>${highlight(snippet(item.text, value), value)}</p>` : ""}</span>
      <span class="term-ref">${esc(item.ref)}</span></a>`).join("") : `<p class="term-sys term-empty">› no entry matches “${esc(query)}”${indexing ? " · still indexing records" : ""}</p>`);
}
function moveSearch(step) {
  const items = byId("searchResults").querySelectorAll(".term-line");
  if (!items.length) return;
  state.searchIndex = (state.searchIndex + step + items.length) % items.length;
  items.forEach((item, index) => item.classList.toggle("active", index === state.searchIndex));
  items[state.searchIndex].scrollIntoView({ block: "nearest" });
}

/* ───────── Interaction ───────── */
function bindImageFallbacks(root) {
  root.querySelectorAll("img").forEach((image) => {
    if (image.dataset.fallbackBound) return;
    image.dataset.fallbackBound = "1";
    const fail = () => {
      // Google refuses an image now and then; one more try through the proxy usually lands.
      const src = image.getAttribute("src") || "";
      if (src.startsWith("/api/img?") && !image.dataset.retried) {
        image.dataset.retried = "1";
        setTimeout(() => { image.src = `${src}&retry=1`; }, 1200);
        return;
      }
      image.removeEventListener("error", fail);
      const statue = image.closest(".statue");
      if (statue) { statue.classList.add("faceless"); statue.querySelector("[data-zoom]")?.removeAttribute("data-zoom"); image.remove(); return; }
      const thumb = image.closest(".plaque-thumb, .dossier-thumb, .artifact-page");
      if (thumb) { thumb.classList.add("is-glyph"); image.replaceWith(document.createRange().createContextualFragment(glyph(thumb.dataset.seed || image.alt || "record"))); return; }
      if (image.classList.contains("chamber-banner")) { image.closest(".chamber-head")?.classList.remove("has-banner"); image.remove(); return; }
      (image.closest("figure") || image).remove();
    };
    image.addEventListener("error", fail);
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
    event.preventDefault(); navigate(anchor.getAttribute("href"), anchor); return;
  }
  if (event.target.closest("[data-recite]")) { event.preventDefault(); huntFound("code"); reciteCode(); return; }
  const summoned = event.target.closest("[data-summon]");
  if (summoned) { event.preventDefault(); summon(summoned.dataset.summon); return; }
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
  if (event.target === byId("railScrim")) closeMenus();
});
/* Hovering a holocron reads its inscription below the altar and starts fetching the record,
 * so it is usually ready by the time the doors open. */
document.addEventListener("pointerover", (event) => {
  const holocron = event.target.closest(".holocron");
  if (holocron) setPlaque(holocron);
  const card = event.target.closest("[data-prefetch]");
  if (!card || card.dataset.prefetched) return;
  card.dataset.prefetched = "1";
  const file = fileByKey(card.dataset.prefetch);
  if (file?.kind === "document") loadDoc(file);
});
document.addEventListener("focusin", (event) => { const holocron = event.target.closest?.(".holocron"); if (holocron) setPlaque(holocron); });

let revealObserver = null;
function observeReveals(root) {
  const items = root.querySelectorAll("[data-reveal]");
  if (!("IntersectionObserver" in window) || reducedMotion.matches) { items.forEach((item) => item.classList.add("in")); return; }
  document.documentElement.classList.add("reveal-ready");
  revealObserver ||= new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add("in"); revealObserver.unobserve(entry.target); } }), { rootMargin: "0px 0px -6% 0px" });
  items.forEach((item) => revealObserver.observe(item));
  setTimeout(() => items.forEach((item) => item.classList.add("in")), 1500); // never leave content hidden
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
 * lightning from the pointer; the archive core at the gate discharges on touch; and typing
 * the word "power" anywhere outside a text field calls down a full storm. Bolts are jagged
 * polylines made by midpoint displacement, redrawn every frame with a fading life. */
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
    // Nightsister magick crackles green while the Halloween theme is on.
    const [glow, core] = halloween.on ? ["90,255,120", "225,255,225"] : ["140,120,255", "235,232,255"];
    if (!perf.lite) { lctx.shadowColor = `rgba(${glow},.9)`; lctx.shadowBlur = 18; }
    lctx.strokeStyle = `rgba(${glow},${(flicker * .55).toFixed(3)})`; lctx.lineWidth = bolt.width * 3.2; trace();
    lctx.shadowBlur = 0;
    lctx.strokeStyle = `rgba(${core},${flicker.toFixed(3)})`; lctx.lineWidth = bolt.width; trace();
  }
  if (bolts.length || channel.active) requestAnimationFrame(drawLightning);
  else { lightningLoop = false; lctx.clearRect(0, 0, innerWidth, innerHeight); }
}
function channelTargets(x, y) {
  return [...document.querySelectorAll(".holocron, .orrery-node, .hero-core, .slip, .brand, .droid")]
    .map((el) => el.getBoundingClientRect())
    .filter((box) => box.width && box.bottom > 0 && box.top < innerHeight)
    .map((box) => [box.left + box.width * (.2 + Math.random() * .6), box.top + box.height * (.2 + Math.random() * .6)])
    .filter(([tx, ty]) => Math.hypot(tx - x, ty - y) < 460);
}
function channelTick() {
  if (!channel.active) return;
  const targets = channelTargets(channel.x, channel.y);
  for (let i = 0; i < (perf.lite ? 1 : 2); i += 1) {
    const angle = Math.random() * Math.PI * 2, reach = 140 + Math.random() * 260;
    const [tx, ty] = targets.length && Math.random() > .35 ? targets[Math.floor(Math.random() * targets.length)] : [channel.x + Math.cos(angle) * reach, channel.y + Math.sin(angle) * reach];
    strike(channel.x, channel.y, tx, ty);
  }
  channel.timer = setTimeout(channelTick, perf.lite ? 140 : 70);
}
const NOT_A_CHANNEL = "a, button, input, textarea, select, label, iframe, .prose, p, h1, h2, h3, h4, li, td, th, dd, dt, .rail, .topbar, .terminal, .lightbox, .droid, .scrubber, .shelf, .file-card, .orrery-log";
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

/* Touching the core discharges lightning along every tether to the orbiting vaults. */
function coreBurst(core) {
  if (reducedMotion.matches) { droidReact("The core hums. Quietly."); return; }
  const box = core.getBoundingClientRect();
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  core.classList.remove("discharge"); void core.offsetWidth; core.classList.add("discharge");
  const nodes = [...document.querySelectorAll(".orrery-node .node-orb")].map((orb) => orb.getBoundingClientRect()).filter((r) => r.width);
  const targets = nodes.length ? nodes.map((r) => [r.left + r.width / 2, r.top + r.height / 2]) : Array.from({ length: 7 }, (_, i) => { const a = (i / 7) * Math.PI * 2; return [cx + Math.cos(a) * box.width, cy + Math.sin(a) * box.width]; });
  targets.slice(0, perf.lite ? 3 : 12).forEach(([tx, ty], i) => setTimeout(() => strike(cx, cy, tx, ty, { width: 2.2 }), i * 55));
  document.querySelectorAll(".orrery-line").forEach((line) => { line.classList.remove("surge"); void line.getBoundingClientRect(); line.classList.add("surge"); });
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
  if (riteBusy() || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") || !/^[a-z]$/i.test(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
  typed = (typed + event.key.toLowerCase()).slice(-16);
  if (typed.endsWith("power")) { typed = ""; huntFound("power"); forceStorm(); }
  else if (typed.endsWith(CODE_WORDS)) { typed = ""; huntFound("code"); reciteCode(); }
  else if (typed.endsWith(EMPEROR_WORD)) { typed = ""; summon("emperor"); }
  else if (typed.endsWith(REGENT_WORD)) { typed = ""; summon("regent"); }
  else if (typed.endsWith(VOICE_WORD)) { typed = ""; summon("voice"); }
  else if (typed.endsWith(WRATH_WORD)) { typed = ""; summon("wrath"); }
  else if (typed.endsWith(HAND_WORD)) { typed = ""; summon("hand"); }
  else if (typed.endsWith(GUARD_WORD)) { typed = ""; summon("guard"); }
});

/* ───────── The Halloween hunt (temporary) ─────────
 * While HUNT.on, three summons answer to new words ("sentinel" for the Regent, "knowledge" for
 * the Voice, "rage" for the Wrath) and the droid gives riddles instead of the plain "Type …" hints: one each time it is
 * tapped, and now and then on its own. Secrets found are remembered in this browser, their
 * riddles retire, and the droid keeps count. Set HUNT.on to false to put everything back. */
const HUNT = {
  on: true,
  key: "tso-hunt-found-v1",
  clues: [
    ["power", "Unlimited… what? Say the word the old Emperor screamed, and the sky will answer."],
    ["code", "The Sith Code begins with a lie. Type its first four words as one, and hear the rest."],
    ["emperor", "One sits upon the throne above all others. Call him by his title, and he rises."],
    ["regent", "Before he was the Emperor's most loyal soldier, he stood watch. Name the rank he held then, and the Regent draws his blade."],
    ["voice", "Every holocron holds it. Every Sith hungers for it. Type it, and the Voice will answer."],
    ["wrath", "Not anger. Not fury. Four letters, red as blood. Type it, and the Wrath conquers."],
    ["hand", "Five fingers. One snap. What does the Emperor reach with?"],
    ["guard", "Three letters stand at the Emperor's gate. Loyal. Disciplined. Unbroken."]
  ],
  next: 0, timer: 0
};
function huntFoundSet() { try { return new Set(JSON.parse(localStorage.getItem(HUNT.key) || "[]")); } catch { return new Set(); } }
function huntFound(id) {
  if (!HUNT.on) return;
  const found = huntFoundSet();
  if (found.has(id)) return;
  found.add(id);
  try { localStorage.setItem(HUNT.key, JSON.stringify([...found])); } catch {}
  // Tell the hunter once the scene (and the droid's own line after it) has passed.
  const total = HUNT.clues.length, count = found.size;
  const report = () => {
    if (riteBusy()) { setTimeout(report, 800); return; }
    setTimeout(() => droidReact(count === total ? `All ${total} secrets found. The archive has no more to hide from you.` : `Secret found: ${count} of ${total}. Tap me for the next riddle.`), 4200);
  };
  setTimeout(report, 1500);
}
function huntClue(asked) {
  const found = huntFoundSet();
  const left = HUNT.clues.filter(([id]) => !found.has(id));
  if (!left.length) { if (asked) droidReact(`You found all ${HUNT.clues.length} secrets. Happy Halloween, Sith.`); return; }
  const [, clue] = left[HUNT.next++ % left.length];
  const droid = byId("droid");
  droid.classList.remove("startled"); void droid.offsetWidth; droid.classList.add("startled");
  showDroidBubble(clue, { label: `Hunt · ${found.size} of ${HUNT.clues.length} found`, ms: 8000 });
}
// Now and then, unasked, the droid whispers a riddle.
function scheduleHuntClue(delay = 45000 + Math.random() * 30000) {
  clearTimeout(HUNT.timer);
  HUNT.timer = setTimeout(() => {
    if (!document.hidden && !riteBusy() && !byId("droidBubble").classList.contains("show")) huntClue(false);
    scheduleHuntClue();
  }, delay);
}

/* ───────── The Code ─────────
 * Typing "peaceisalie" (the Code's first words, as one word) anywhere outside a text field,
 * or picking it from the terminal, has the archive recite the whole Code. The last line breaks
 * the chains: lightning, and the archive stays awakened for the rest of the visit, with
 * every holocron lit and the vault burning brighter. */
const SITH_CODE = ["Peace is a lie, there is only passion.", "Through passion, I gain strength.", "Through strength, I gain power.", "Through power, I gain victory.", "Through victory, my chains are broken.", "The Force shall free me."];
const CODE_WORDS = "peaceisalie";
const AWAKENED = "tso-awakened";
const recital = { running: false, timers: [] };
const lettersOf = (text) => text.toLowerCase().replace(/[^a-z]/g, "");
function reciteCode() {
  if (riteBusy()) return;
  recital.running = true;
  closeSearch(); closeLightbox(); closeMenus();
  const overlay = byId("sithCode");
  const still = reducedMotion.matches;
  const beat = perf.lite ? 950 : 1150;
  byId("codeLines").innerHTML = SITH_CODE.map((line, index) => `<li style="--i:${index}">${line.split(" ").map((word, w) => `<span style="--w:${w}">${esc(word)}</span>`).join(" ")}</li>`).join("");
  overlay.className = `sith-code${still ? " still" : ""}`;
  overlay.style.setProperty("--beat", `${beat}ms`);
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  const lines = [...overlay.querySelectorAll("li")];
  const later = (ms, fn) => recital.timers.push(setTimeout(fn, ms));
  const finish = () => {
    recital.timers.forEach(clearTimeout); recital.timers = [];
    removeEventListener("keydown", skip, true); overlay.removeEventListener("click", skip);
    overlay.hidden = true; overlay.className = "sith-code";
    document.body.style.overflow = "";
    recital.running = false;
    awaken(true);
  };
  const skip = (event) => { if (event.type === "keydown") { event.preventDefault(); event.stopPropagation(); } finish(); };
  if (still) lines.forEach((line) => line.classList.add("spoken"));
  else lines.forEach((line, index) => later(500 + index * beat, () => line.classList.add("spoken")));
  // The last line is held a moment before the chains break.
  const end = still ? 2600 : 500 + (lines.length - 1) * beat + 1500;
  if (!still) later(end, () => { overlay.classList.add("broken"); forceStorm(); });
  later(end + (still ? 0 : 1700), finish);
  setTimeout(() => { addEventListener("keydown", skip, true); overlay.addEventListener("click", skip); }, 400);
}
function awaken(announce) {
  document.documentElement.classList.add("awakened");
  try { sessionStorage.setItem(AWAKENED, "1"); } catch {}
  if (!announce) return;
  toast("The Code is spoken. The archive has awakened.");
  setTimeout(() => droidReact("The archive answers to you now. For now."), 900);
}
try { if (sessionStorage.getItem(AWAKENED)) awaken(false); } catch {}

/* ───────── The Emperor ─────────
 * Typing "emperor" anywhere outside a text field, or summoning him from the terminal, brings
 * Darth Azazel up out of the dark. He powers up: the dark side boils off him as a crimson
 * aura, his hair ignites, the ground cracks into shockwaves, his eyes blaze and his name
 * slams in. The aura is drawn on a canvas: flames rise from the edge of his
 * silhouette (read from the picture's own transparency) and from a flickering envelope
 * around him. */
const EMPEROR_WORD = "emperor";
const rite = { running: false, timers: [], frame: 0, edges: null, image: null, particles: [], intensity: 0, target: 0, sprites: null };
function riteSprites() {
  if (rite.sprites) return rite.sprites;
  const sprite = (stops) => {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d"), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    stops.forEach(([at, color]) => grad.addColorStop(at, color));
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    return c;
  };
  rite.sprites = {
    hot: sprite([[0, "rgba(255,255,255,1)"], [.25, "rgba(255,214,206,.9)"], [.55, "rgba(255,60,60,.45)"], [1, "rgba(160,0,16,0)"]]),
    red: sprite([[0, "rgba(255,120,110,.9)"], [.4, "rgba(227,38,47,.55)"], [1, "rgba(110,0,10,0)"]])
  };
  return rite.sprites;
}
async function emperorImage() {
  if (rite.image) return rite.image;
  const img = byId("riteEmperor");
  if (!img.getAttribute("src")) img.src = "/emperor.webp";
  await img.decode().catch(() => {});
  // Edge of the silhouette: opaque pixels next to transparent ones, with the way out.
  const c = document.createElement("canvas"); c.width = img.naturalWidth || 339; c.height = img.naturalHeight || 429;
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
  const alpha = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : data[(y * width + x) * 4 + 3]);
  const edges = [];
  for (let y = 0; y < height; y += 3) for (let x = 0; x < width; x += 3) {
    if (alpha(x, y) < 150) continue;
    const nx = alpha(x - 4, y) - alpha(x + 4, y), ny = alpha(x, y - 4) - alpha(x, y + 4);
    if (Math.abs(nx) + Math.abs(ny) < 120) continue;
    const length = Math.hypot(nx, ny) || 1;
    edges.push({ x: x / width, y: y / height, nx: nx / length, ny: ny / length });
  }
  rite.edges = edges; rite.image = img;
  return img;
}
async function summonEmperor() {
  if (riteBusy()) return;
  rite.running = true;
  closeSearch(); closeLightbox(); closeMenus();
  const overlay = byId("emperorRite");
  const still = reducedMotion.matches;
  await emperorImage();
  overlay.className = `emperor-rite${still ? " still" : ""}`;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  const later = (ms, fn) => rite.timers.push(setTimeout(fn, ms));
  const finish = () => {
    rite.timers.forEach(clearTimeout); rite.timers = [];
    cancelAnimationFrame(rite.frame); rite.frame = 0; rite.particles = [];
    removeEventListener("keydown", skip, true); overlay.removeEventListener("click", skip);
    overlay.hidden = true; overlay.className = "emperor-rite";
    document.body.style.overflow = "";
    rite.running = false;
    toast("The Emperor has spoken. Kneel.");
    setTimeout(() => droidReact("His power level… it's over nine thousand!"), 700);
  };
  const skip = (event) => { if (event.type === "keydown") { event.preventDefault(); event.stopPropagation(); } finish(); };
  setTimeout(() => { if (rite.running) { addEventListener("keydown", skip, true); overlay.addEventListener("click", skip); } }, 400);
  if (still) { overlay.classList.add("charging", "ascended"); later(4200, finish); return; }
  rite.intensity = 0;
  startAura();
  void overlay.offsetWidth;
  overlay.classList.add("rising");
  later(900, () => { overlay.classList.add("charging"); rite.target = .45; });
  later(2700, () => {
    overlay.classList.add("ascended"); rite.target = 1; rite.intensity = 1.4;
    document.body.classList.remove("quake"); void document.body.offsetWidth; document.body.classList.add("quake");
    setTimeout(() => document.body.classList.remove("quake"), 1600);
    skyFlash(1);
  });
  later(7800, () => { overlay.classList.add("leaving"); rite.target = 0; });
  later(8500, finish);
}
/* ───────── The Dark Regent ─────────
 * Typing "regent" (or summoning him from the terminal) brings Darth Zephros, Dark Regent of the
 * Sith and its second in command, before the enemies of the Sith. He has already struck:
 * three cuts of blade-light cross the screen while he stands still, his sword spins down out
 * of the air and slides home into the scabbard on his back, and on the click of the hilt the
 * enemies fall apart along the cuts. Then the vow, and his name. */
const REGENT_WORD = HUNT.on ? "sentinel" : "regent";
const regent = { running: false, timers: [], built: false };
const REGENT_CUTS = [[14, 36], [44, 62], [71, 93]]; // each cut: where it crosses the top and the bottom, in % of the width
function regentEnemies() {
  // Distant figures on the horizon, hooded and robed, each with a blue blade raised.
  const figure = (x, scale, angle, i) => `<g class="enemy" transform="translate(${x} 600) scale(${scale})">
      <line class="enemy-blade" x1="12" y1="-46" x2="${12 + Math.sin(angle) * 64}" y2="${-46 - Math.cos(angle) * 64}" style="--i:${i}"/>
      <path d="M-15 -78Q0 -86 15 -78L24 0H-24Z"/><circle cx="0" cy="-88" r="10"/></g>`;
  const spots = [[150, 1.6, .5], [340, 2, -.3], [520, 1.4, .9], [660, 1.7, .2], [940, 1.7, -.2], [1090, 1.4, -.8], [1270, 2, .35], [1450, 1.6, -.5]];
  return `<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">${spots.map(([x, scale, angle], i) => figure(x, scale, angle, i)).join("")}</svg>`;
}
function buildRegent() {
  if (regent.built) return;
  regent.built = true;
  const edges = [[-20, -20], ...REGENT_CUTS, [120, 120]];
  const drift = [[-3.5, 7, -2.5], [2.5, -6, 2], [-2.5, 8, -1.5], [3.5, -5, 2.8]];
  byId("regentField").innerHTML = edges.slice(0, -1).map((edge, i) => {
    const next = edges[i + 1];
    return `<div class="regent-strip" style="clip-path:polygon(${edge[0]}% 0,${next[0]}% 0,${next[1]}% 100%,${edge[1]}% 100%);--dx:${drift[i][0]}vw;--dy:${drift[i][1]}vh;--rot:${drift[i][2]}deg">${regentEnemies()}</div>`;
  }).join("");
}
// The cuts of light are drawn for the screen at hand, from top edge to bottom edge.
function layRegentSlashes() {
  byId("regentSlashes").innerHTML = REGENT_CUTS.map(([top, bottom], i) => {
    const x1 = top / 100 * innerWidth, x2 = bottom / 100 * innerWidth, h = innerHeight + 40;
    return `<i style="left:${x1}px;width:${Math.hypot(x2 - x1, h)}px;rotate:${Math.atan2(h, x2 - x1)}rad;--i:${i}"></i>`;
  }).join("");
}
async function summonRegent() {
  if (riteBusy()) return;
  regent.running = true;
  closeSearch(); closeLightbox(); closeMenus();
  buildRegent(); layRegentSlashes();
  const overlay = byId("regentRite"), img = byId("regentImage"), rig = byId("regentRig"), sword = byId("regentSword");
  if (!img.getAttribute("src")) img.src = "/regent.webp";
  await img.decode().catch(() => {});
  const still = reducedMotion.matches;
  overlay.className = `regent-rite${still ? " still" : ""}`;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  const later = (ms, fn) => regent.timers.push(setTimeout(fn, ms));
  const finish = () => {
    regent.timers.forEach(clearTimeout); regent.timers = [];
    sword.getAnimations().forEach((animation) => animation.cancel());
    removeEventListener("keydown", skip, true); overlay.removeEventListener("click", skip);
    overlay.hidden = true; overlay.className = "regent-rite";
    document.body.style.overflow = "";
    regent.running = false;
    toast("The Dark Regent has passed judgement.");
    setTimeout(() => droidReact("I saw nothing. I was never here."), 700);
  };
  const skip = (event) => { if (event.type === "keydown") { event.preventDefault(); event.stopPropagation(); } finish(); };
  setTimeout(() => { if (regent.running) { addEventListener("keydown", skip, true); overlay.addEventListener("click", skip); } }, 400);
  const H = rig.getBoundingClientRect().height;
  rig.style.setProperty("--h", `${H}px`);
  if (still) { overlay.classList.add("standing", "cut", "sheathed", "vow"); later(4500, finish); return; }
  void overlay.offsetWidth;
  overlay.classList.add("standing");
  later(700, () => overlay.classList.add("cut")); // the three cuts flash across
  later(1300, () => {
    // The sword comes down out of the air, turning, and lines up over his shoulder...
    const anchor = sword.getBoundingClientRect();
    const dx = innerWidth - anchor.left + H * .3, dy = -anchor.top - H * .4;
    const sin = Math.sin(35 * Math.PI / 180), cos = Math.cos(35 * Math.PI / 180), lift = H * .46;
    const above = `translate(${-sin * lift}px, ${-cos * lift}px) rotate(-35deg)`;
    overlay.classList.add("flying");
    const flight = sword.animate([
      { transform: `translate(${dx}px, ${dy}px) rotate(865deg)`, opacity: 0 },
      { opacity: 1, offset: .1 },
      { transform: `translate(${H * .42}px, ${-H * .78}px) rotate(325deg)`, offset: .62 },
      { transform: above }
    ], { duration: perf.lite ? 900 : 1150, easing: "cubic-bezier(.3,.6,.35,1)", fill: "forwards" });
    flight.finished.then(() => {
      if (!regent.running) return;
      // ...and slides home.
      sword.animate([{ transform: above }, { transform: "rotate(-35deg)" }], { duration: 170, easing: "cubic-bezier(.6,0,1,.6)", fill: "forwards" })
        .finished.then(() => {
          if (!regent.running) return;
          overlay.classList.remove("flying"); overlay.classList.add("sheathed");
          skyFlash(.8);
          later(380, () => overlay.classList.add("fallen")); // the enemies come apart along the cuts
          later(900, () => overlay.classList.add("vow"));
        }).catch(() => {});
    }).catch(() => {});
  });
  later(9200, () => overlay.classList.add("leaving"));
  later(9900, finish);
}

const summon = (who) => { if (!riteBusy()) huntFound(who); return ({ regent: summonRegent, voice: summonVoice, wrath: summonWrath, hand: summonHand, guard: summonGuard }[who] || summonEmperor)(); };
const riteBusy = () => recital.running || rite.running || regent.running || voice.running || wrath.running || hand.running || guard.running;

/* ───────── The Dark Honor Guard ─────────
 * Typing "dhg" (or summoning them from the terminal) brings the Dark Honor Guard to the
 * Emperor's gate at night. In the rain only a visor glows (.g1); the torches flare on the Lord
 * Commandant and a line of guards in the fog (.g2); every visor lights: "Loyal." (.g3); he
 * ignites his saber and the line ignites with him: "Disciplined." (.g4); one stamp shakes
 * the ground and the seal burns: "Unbroken." (.g5); "None shall pass." (.g6); the guard's
 * cry, "Glory to the Emperor!" (.g7); and their title (.g8). Like the Voice, the scene is a 1600 by 900 stage scaled to the screen. */
const GUARD_WORD = "dhg";
const guard = { running: false, timers: [], built: false };
const GUARD_STAGES = [400, 1900, 3400, 4700, 6000, 7100, 8100, 9100];
// Both poses share one 1120 by 1040 canvas, lined up on the visor; these are fractions of it.
const GUARD_POSE = { w: 1120, h: 1040, visor: [.5, .3077], hilt: [.3393, .3606], feet: .8865 };
function buildGuard() {
  if (guard.built) return;
  guard.built = true;
  let h = hash("guard-gate");
  const rand = () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296; };
  const between = (lo, hi) => lo + rand() * (hi - lo);
  const P = GUARD_POSE, place = (cx, feet, tall) => { const w = tall * P.w / P.h; return { left: cx - w / 2, top: feet - P.feet * tall, w }; };
  const line = [[-1, 0], [1, 0], [-1, 1], [1, 1], [-1, 2], [1, 2], [-1, 3], [1, 3]].map(([side, d], i) => {
    const tall = 300 - d * 42, { left, top, w } = place(800 + side * (250 + d * 150), 640 - d * 22, tall);
    const blade = tall * .42;
    // Each guard holds the same two poses as the Commandant: at rest, then with the saber drawn.
    const at = `left:${left.toFixed(0)}px;top:${top.toFixed(0)}px;height:${tall}px;--i:${i}`;
    return `<img class="dg-line" src="/dhg-idle.webp" alt="" style="${at}"><img class="dg-line dg-line-armed" src="/dhg-saber.webp" alt="" style="${at}">
      <i class="dg-line-visor" style="left:${(left + P.visor[0] * w).toFixed(0)}px;top:${(top + P.visor[1] * tall).toFixed(0)}px;width:${(tall * .05).toFixed(1)}px;--i:${i}"></i>
      <i class="dg-line-blade" style="left:${(left + P.hilt[0] * w).toFixed(0)}px;top:${(top + P.hilt[1] * tall - blade).toFixed(0)}px;height:${blade.toFixed(0)}px;--i:${i}"></i>`;
  }).join("");
  const hero = place(800, 760, 540), hx = hero.left + P.hilt[0] * hero.w, hy = hero.top + P.hilt[1] * 540;
  const vx = hero.left + P.visor[0] * hero.w, vy = hero.top + P.visor[1] * 540;
  const rain = Array.from({ length: 110 }, () => `<i style="left:${between(-100, 1700).toFixed(0)}px;--t:${between(.5, .9).toFixed(2)}s;--d:${(-between(0, 1)).toFixed(2)}s;--h:${between(40, 90).toFixed(0)}px"></i>`).join("");
  const fog = (rows) => rows.map(([y, t, d, w, tall, o]) => `<i style="top:${y}px;--t:${t}s;--d:${-d}s;width:${w}px;height:${tall}px;--o:${o}"></i>`).join("");
  const sparks = Array.from({ length: 26 }, () => `<i style="--x:${between(-90, 90).toFixed(0)}px;--y:${between(-160, -20).toFixed(0)}px;--t:${between(.5, 1).toFixed(2)}s;--d:${between(0, .25).toFixed(2)}s"></i>`).join("");
  byId("guardStage").innerHTML = `
    <svg class="vt-abs dg-gate" viewBox="0 0 1600 900">
      <rect class="dg-wall" width="1600" height="640"/><path class="dg-wall-edge" d="M0 120H1600M0 300H1600M0 470H1600"/>
      <path class="dg-door" d="M560 640V200Q800 40 1040 200V640Z"/><path class="dg-door-rib" d="M800 120V640M600 300H1000M590 460H1010"/>
      <circle class="dg-seal" cx="800" cy="300" r="70"/><path class="dg-seal" d="M800 240 852 270V330L800 360 748 330V270Z"/>
      <path class="dg-ban" d="M380 60H470V430L425 395L380 430Z"/><path class="dg-ban-emb" d="M425 180l28 16v32l-28 16-28-16v-32Z"/>
      <path class="dg-ban" d="M1130 60H1220V430L1175 395L1130 430Z"/><path class="dg-ban-emb" d="M1175 180l28 16v32l-28 16-28-16v-32Z"/>
      <path class="dg-ground" d="M0 620H1600V900H0Z"/><rect class="dg-step" x="500" y="626" width="600" height="18"/><rect class="dg-step" x="460" y="644" width="680" height="18"/></svg>
    <div class="dg-torch" style="left:330px;top:470px"><b></b></div><div class="dg-torch" style="left:1270px;top:470px"><b></b></div>
    <div class="vt-abs dg-fog">${fog([[520, 40, 5, 1100, 180, .5], [580, 52, 26, 1300, 200, .55]])}</div>
    <div class="vt-abs">${line}</div>
    <div class="vt-abs dg-fog">${fog([[680, 36, 14, 1400, 220, .6], [760, 46, 33, 1500, 240, .7]])}</div>
    <div class="dg-shock"><i></i></div><div class="dg-shadow"></div>
    <div class="dg-bladelight" style="left:${hx.toFixed(0)}px;top:${(hy - 110).toFixed(0)}px"></div>
    <div class="dg-hero" style="left:${hero.left.toFixed(0)}px;top:${hero.top.toFixed(0)}px;width:${hero.w.toFixed(0)}px;height:540px">
      <img class="dg-idle" id="guardImage" src="/dhg-idle.webp" alt="The Lord Commandant of the Dark Honor Guard" width="1120" height="1040" />
      <img class="dg-saber" src="/dhg-saber.webp" alt="" width="1120" height="1040" /></div>
    <div class="dg-blade" style="left:${hx.toFixed(0)}px;top:${(hy - 290).toFixed(0)}px"></div>
    <div class="dg-sparks" style="left:${hx.toFixed(0)}px;top:${hy.toFixed(0)}px">${sparks}</div>
    <div class="dg-visor" style="left:${vx.toFixed(0)}px;top:${vy.toFixed(0)}px"></div>
    <div class="vt-abs dg-rain">${rain}</div>`;
}
function fitGuard() {
  const scale = Math.max(innerWidth / 1600, Math.min(innerHeight / 900, innerWidth / 700));
  byId("guardStage").style.setProperty("--vt-scale", scale.toFixed(4));
}
async function summonGuard() {
  if (riteBusy()) return;
  guard.running = true;
  closeSearch(); closeLightbox(); closeMenus();
  buildGuard();
  const overlay = byId("guardRite"), stage = byId("guardStage");
  await Promise.all([...stage.querySelectorAll(".dg-hero img")].map((img) => img.decode().catch(() => {})));
  const still = reducedMotion.matches;
  overlay.className = `guard-rite${still ? " still" : ""}${perf.lite ? " lite" : ""}`;
  overlay.hidden = false;
  fitGuard(); addEventListener("resize", fitGuard);
  document.body.style.overflow = "hidden";
  const later = (ms, fn) => guard.timers.push(setTimeout(fn, ms));
  const finish = () => {
    guard.timers.forEach(clearTimeout); guard.timers = [];
    removeEventListener("resize", fitGuard);
    removeEventListener("keydown", skip, true); overlay.removeEventListener("click", skip);
    overlay.hidden = true; overlay.className = "guard-rite";
    document.body.style.overflow = "";
    guard.running = false;
    toast("The Emperor's gate is held.");
    setTimeout(() => droidReact("I would not try to pass. I have tried. Once."), 700);
  };
  const skip = (event) => { if (event.type === "keydown") { event.preventDefault(); event.stopPropagation(); } finish(); };
  setTimeout(() => { if (guard.running) { addEventListener("keydown", skip, true); overlay.addEventListener("click", skip); } }, 400);
  if (still) { GUARD_STAGES.forEach((ms, i) => overlay.classList.add(`g${i + 1}`)); later(4500, finish); return; }
  const enter = (n) => {
    overlay.classList.add(`g${n}`);
    if (n === 4 || n === 5) { stage.classList.remove("jolt"); void stage.offsetWidth; stage.classList.add("jolt"); }
    if (n === 4) skyFlash(.5);
    if (n === 7) { stage.classList.remove("jolt"); void stage.offsetWidth; stage.classList.add("jolt"); skyFlash(.6); }
  };
  GUARD_STAGES.forEach((ms, i) => later(ms, () => enter(i + 1)));
  later(11800, () => overlay.classList.add("leaving"));
  later(12500, finish);
}

/* ───────── The Emperor's Hand ─────────
 * Typing "hand" (or summoning him from the terminal) brings the Emperor's Hand out of the
 * shadows: black mist pours in and wraps a dark shape like a cloak, then billows away from him
 * as he takes form. The Emperor commands: six crystals gather round his fist. The
 * Hand enforces: he snaps, and half the enemies standing in the mist crumble into dust. The
 * mist and the dust are drawn on two canvases, one behind him and one in front. */
const HAND_WORD = "hand";
const hand = { running: false, timers: [], frame: 0, smoke: [], dust: [], enemies: null, phase: "", sprite: null };
function handSprite() {
  if (hand.sprite) return hand.sprite;
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d"), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(4,2,3,.9)"); grad.addColorStop(.5, "rgba(8,5,6,.55)"); grad.addColorStop(1, "rgba(10,6,8,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return (hand.sprite = c);
}
// The enemies in the mist, drawn once for this screen: the survivors on one layer, the doomed
// (every other one) as particles ready to be blown away.
function handEnemies(width, height) {
  const layer = (doomed) => {
    const c = document.createElement("canvas"); c.width = width; c.height = height;
    const g = c.getContext("2d");
    const spots = [[.08, 1, .5], [.19, .8, -.3], [.3, 1.1, .8], [.41, .75, .2], [.59, .75, -.2], [.7, 1.1, -.7], [.81, .8, .35], [.92, 1, -.5]];
    spots.forEach(([x, scale, angle], i) => {
      if ((i % 2 === 1) !== doomed) return;
      const k = height / 900 * 1.6 * scale, cx = x * width, cy = height * .74;
      g.save(); g.translate(cx, cy); g.scale(k, k);
      g.strokeStyle = "#9fd8ff"; g.lineWidth = 3.2; g.lineCap = "round"; g.shadowColor = "#1e7bff"; g.shadowBlur = 10;
      g.beginPath(); g.moveTo(12, -46); g.lineTo(12 + Math.sin(angle) * 64, -46 - Math.cos(angle) * 64); g.stroke();
      g.shadowBlur = 0; g.fillStyle = "#0b0708"; g.strokeStyle = "rgba(227,38,47,.4)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(-15, -78); g.quadraticCurveTo(0, -86, 15, -78); g.lineTo(24, 0); g.lineTo(-24, 0); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.arc(0, -88, 10, 0, Math.PI * 2); g.fill(); g.stroke();
      g.restore();
    });
    return c;
  };
  const survivors = layer(false), doomed = layer(true);
  const data = doomed.getContext("2d").getImageData(0, 0, width, height).data;
  const grains = [], step = perf.lite ? 4 : 3;
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    const o = (y * width + x) * 4;
    if (data[o + 3] < 60) continue;
    grains.push({ x, y, x0: x, y0: y, c: `rgb(${data[o]},${data[o + 1]},${data[o + 2]})`, delay: x / width * 70 + Math.random() * 30, vx: 0, vy: 0, life: 0 });
  }
  return { survivors, doomed, grains, width, height };
}
async function summonHand() {
  if (riteBusy()) return;
  hand.running = true;
  closeSearch(); closeLightbox(); closeMenus();
  const overlay = byId("handRite"), img = byId("handImage");
  if (!img.getAttribute("src")) img.src = "/hand.webp";
  await img.decode().catch(() => {});
  const still = reducedMotion.matches;
  overlay.className = `hand-rite${still ? " still" : ""}`;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  const later = (ms, fn) => hand.timers.push(setTimeout(fn, ms));
  const finish = () => {
    hand.timers.forEach(clearTimeout); hand.timers = [];
    cancelAnimationFrame(hand.frame); hand.frame = 0; hand.smoke = []; hand.enemies = null;
    removeEventListener("keydown", skip, true); overlay.removeEventListener("click", skip);
    overlay.hidden = true; overlay.className = "hand-rite";
    document.body.style.overflow = "";
    hand.running = false;
    toast("The Hand has enforced the Emperor's will.");
    setTimeout(() => droidReact("Perfectly balanced. As all things should be."), 700);
  };
  const skip = (event) => { if (event.type === "keydown") { event.preventDefault(); event.stopPropagation(); } finish(); };
  setTimeout(() => { if (hand.running) { addEventListener("keydown", skip, true); overlay.addEventListener("click", skip); } }, 400);
  if (still) { overlay.classList.add("shadowed", "formed", "commands", "raised", "snapped", "enforces"); later(4500, finish); return; }
  hand.phase = "gather";
  startShadow();
  void overlay.offsetWidth;
  later(300, () => overlay.classList.add("shadowed")); // a dark shape inside the mist
  later(1900, () => { hand.phase = "disperse"; overlay.classList.add("formed"); }); // the cloak of mist billows away
  later(2600, () => { hand.phase = "linger"; overlay.classList.add("commands"); });
  later(3200, () => overlay.classList.add("raised")); // the crystals circle his fist and close in
  later(4700, () => {
    overlay.classList.add("snapped"); // snap
    skyFlash(.9);
    overlay.classList.remove("jolt"); void overlay.offsetWidth; overlay.classList.add("jolt");
    later(350, () => { hand.phase = "dust"; hand.dustAt = performance.now(); });
  });
  later(5600, () => overlay.classList.add("enforces"));
  later(10600, () => overlay.classList.add("leaving"));
  later(11300, finish);
}
function startShadow() {
  const back = byId("handBack"), front = byId("handFront");
  const ratio = Math.min(devicePixelRatio || 1, perf.lite ? 1 : 1.5);
  const W = innerWidth, H = innerHeight;
  for (const c of [back, front]) { c.width = W * ratio; c.height = H * ratio; c.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0); }
  const gb = back.getContext("2d"), gf = front.getContext("2d");
  hand.enemies = handEnemies(W, H);
  const sprite = handSprite();
  const tick = (now) => {
    hand.frame = requestAnimationFrame(tick);
    const box = byId("handImage").getBoundingClientRect();
    const cx = box.left + box.width / 2, cy = box.top + box.height * .55;
    gb.clearRect(0, 0, W, H); gf.clearRect(0, 0, W, H);
    // The enemies: survivors stay; the doomed are their grains, still until the snap reaches them.
    const { survivors, grains } = hand.enemies;
    gb.globalAlpha = .9; gb.drawImage(survivors, 0, 0, W, H); gb.globalAlpha = 1;
    const dusting = hand.phase === "dust", t = dusting ? (now - hand.dustAt) / 16.7 : 0;
    for (const p of grains) {
      if (dusting && t > p.delay) {
        p.life += 1;
        p.vx += .09 + Math.random() * .09; p.vy -= .03 + Math.random() * .05;
        p.x += p.vx + Math.sin((p.life + p.y0) * .2) * .4; p.y += p.vy;
        const a = 1 - p.life / 90;
        if (a <= 0) continue;
        gb.globalAlpha = a; gb.fillStyle = p.life < 8 ? "#ff6b5e" : p.c;
      } else { gb.globalAlpha = 1; gb.fillStyle = p.c; }
      gb.fillRect(p.x, p.y, 2.4, 2.4);
    }
    gb.globalAlpha = 1;
    // The shadow mist: pulled in round him, then thrown off him, then idling at his feet.
    const rate = hand.phase === "gather" ? (perf.lite ? 4 : 9) : hand.phase === "linger" || hand.phase === "dust" ? 1 : 0;
    for (let i = 0; i < rate; i += 1) {
      const a = Math.random() * Math.PI * 2, r = box.height * (.7 + Math.random() * .5);
      const linger = hand.phase !== "gather";
      const x = linger ? cx + (Math.random() - .5) * box.width * 1.6 : cx + Math.cos(a) * r;
      const y = linger ? box.bottom - Math.random() * box.height * .15 : cy + Math.sin(a) * r * .8;
      hand.smoke.push({ x, y, vx: linger ? (Math.random() - .5) * .6 : (cx - x) * .018, vy: linger ? -.3 - Math.random() * .4 : (cy - y) * .018 - .4, life: 0, max: linger ? 110 : 60 + Math.random() * 30, size: box.width * (linger ? .35 : .5 + Math.random() * .4), front: Math.random() < .45 });
    }
    if (hand.phase === "disperse" && !hand.burst) {
      hand.burst = true;
      for (let i = 0; i < (perf.lite ? 30 : 70); i += 1) {
        const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 5;
        hand.smoke.push({ x: cx + (Math.random() - .5) * box.width * .6, y: cy + (Math.random() - .5) * box.height * .7, vx: Math.cos(a) * s, vy: Math.sin(a) * s * .7 - .6, life: 0, max: 70 + Math.random() * 40, size: box.width * (.45 + Math.random() * .5), front: Math.random() < .5 });
      }
    }
    if (hand.phase === "gather") hand.burst = false;
    hand.smoke = hand.smoke.filter((p) => {
      p.life += 1; if (p.life > p.max) return false;
      p.x += p.vx; p.y += p.vy; p.vx *= .985; p.vy *= .985;
      const u = p.life / p.max, size = p.size * (.6 + u * .9);
      const g = p.front && hand.phase !== "linger" && hand.phase !== "dust" ? gf : gb;
      g.globalAlpha = Math.sin(Math.PI * u) * .85;
      g.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size);
      return true;
    });
    gb.globalAlpha = 1; gf.globalAlpha = 1;
  };
  hand.frame = requestAnimationFrame(tick);
}

/* ───────── The Emperor's Wrath ─────────
 * Typing "wrath" (or summoning him from the terminal) brings the Emperor's Wrath before a war
 * map of the galaxy. The Emperor points: a targeting line streaks across the map and locks on
 * a world. The Wrath conquers: from that world crimson spreads along the hyperlanes, planet by
 * planet, each taking a flag, while four war banners slam into the ground around him and
 * unfurl. The map keeps pulling back on more worlds falling, for the conquest is never ending. */
const WRATH_WORD = HUNT.on ? "rage" : "wrath";
const wrath = { running: false, timers: [], built: false };
const WRATH_BANNERS = [{ x: 30, far: true }, { x: 70, far: true }, { x: 10 }, { x: 90 }];
function wrathMap() {
  // Worlds scattered well past the edges, so pulling back finds more of them.
  const worlds = [];
  for (let i = 0; worlds.length < 74 && i < 900; i += 1) {
    const x = -520 + seededRandom(`wx${i}`) * 2640, y = -340 + seededRandom(`wy${i}`) * 1580;
    if (worlds.every((w) => Math.hypot(w.x - x, w.y - y) > 130)) worlds.push({ x, y, r: 5 + seededRandom(`wr${i}`) * 9, links: [] });
  }
  const lanes = [];
  worlds.forEach((w, i) => {
    worlds.map((v, j) => [j, Math.hypot(v.x - w.x, v.y - w.y)]).filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]).slice(0, 2).forEach(([j]) => {
      if (!w.links.includes(j)) { w.links.push(j); worlds[j].links.push(i); lanes.push([i, j]); }
    });
  });
  // The Emperor's mark: the world nearest a point beside the Wrath's head, clear of the words.
  const start = worlds.reduce((best, w, i) => (Math.hypot(w.x - 1120, w.y - 240) < Math.hypot(worlds[best].x - 1120, worlds[best].y - 240) ? i : best), 0);
  const hops = worlds.map(() => Infinity); hops[start] = 0;
  for (const queue = [start]; queue.length;) { const i = queue.shift(); for (const j of worlds[i].links) if (hops[j] === Infinity) { hops[j] = hops[i] + 1; queue.push(j); } }
  const delay = (i) => Math.round((Number.isFinite(hops[i]) ? hops[i] : 9) * 330 + seededRandom(`wd${i}`) * 140);
  const grid = [...Array.from({ length: 21 }, (_, i) => `<line x1="${i * 80}" y1="-400" x2="${i * 80}" y2="1300"/>`), ...Array.from({ length: 20 }, (_, i) => `<line x1="-600" y1="${i * 80 - 300}" x2="2200" y2="${i * 80 - 300}"/>`)].join("");
  const target = worlds[start];
  return `<g class="map-grid">${grid}</g>
    <g class="map-lanes">${lanes.map(([i, j]) => `<line pathLength="1" x1="${worlds[i].x.toFixed(0)}" y1="${worlds[i].y.toFixed(0)}" x2="${worlds[j].x.toFixed(0)}" y2="${worlds[j].y.toFixed(0)}" style="--d:${Math.min(delay(i), delay(j)) + 150}ms"/>`).join("")}</g>
    <g class="map-worlds">${worlds.map((w, i) => `<g class="world" style="--d:${delay(i)}ms" transform="translate(${w.x.toFixed(0)} ${w.y.toFixed(0)})"><circle class="halo" r="${(w.r + 9).toFixed(1)}"/><circle class="orb" r="${w.r.toFixed(1)}"/><path class="flag" d="M0 ${(-w.r).toFixed(1)}V${(-w.r - 20).toFixed(1)}L13 ${(-w.r - 15).toFixed(1)}L0 ${(-w.r - 10).toFixed(1)}"/></g>`).join("")}</g>
    <g class="map-pointer"><line pathLength="1" x1="-200" y1="-160" x2="${target.x.toFixed(0)}" y2="${target.y.toFixed(0)}"/>
      <g class="reticle" transform="translate(${target.x.toFixed(0)} ${target.y.toFixed(0)})"><g><circle r="30"/><circle r="44" stroke-dasharray="10 8"/><path d="M-58 0H-36M36 0H58M0 -58V-36M0 36V58"/></g></g></g>`;
}
// The enemy's banners stand first; each burns from the hem up and falls, and a Sith banner
// is driven into the ground where it stood (--f: when this one catches fire).
const WRATH_BURN_MS = 420, WRATH_REPLACE_MS = 1150;
const BANNER_SHAPES = ["M12 20H108Q108 175 108 330L60 296L12 330Q12 175 12 20Z", "M12 20H108Q122 170 114 332L64 300L16 326Q2 168 12 20Z", "M12 20H108Q98 180 104 328L56 294L8 332Q20 182 12 20Z"];
const bannerWave = (i) => `<animate attributeName="d" values="${[0, 1, 0, 2, 0].map((n) => BANNER_SHAPES[n]).join(";")}" dur="${(2.6 + i * .3).toFixed(1)}s" repeatCount="indefinite"/>`;
function wrathFoe({ x, far }, i) {
  const rays = Array.from({ length: 8 }, (_, k) => { const a = k * Math.PI / 4; return `M${(Math.cos(a) * 24).toFixed(1)} ${(Math.sin(a) * 24).toFixed(1)}L${(Math.cos(a) * 34).toFixed(1)} ${(Math.sin(a) * 34).toFixed(1)}`; }).join("");
  const embers = Array.from({ length: 12 }, (_, k) => `<i style="--x:${(10 + seededRandom(`em${i}${k}`) * 80).toFixed(0)}%;--e:${(k * .08).toFixed(2)}s"></i>`).join("");
  return `<div class="wrath-banner wrath-foe${far ? " far" : ""}${x < 50 ? " left" : ""}" style="left:${x}%;--f:${i * WRATH_BURN_MS}ms">
    <svg class="banner-art foe-pole" viewBox="0 -30 120 560"><rect class="pole" x="57" y="0" width="6" height="530" rx="2"/><path class="tip" d="M60 -28 67 2H53Z"/>
      <rect class="bar" x="6" y="12" width="108" height="8" rx="4"/><circle class="finial" cx="6" cy="16" r="6"/><circle class="finial" cx="114" cy="16" r="6"/></svg>
    <svg class="banner-art foe-cloth" viewBox="0 -30 120 560"><g class="cloth"><path d="${BANNER_SHAPES[0]}">${bannerWave(i + 1)}</path>
      <g class="emblem" transform="translate(60 150)"><circle r="17"/><path d="${rays}"/></g></g></svg>
    <span class="foe-burn"></span><span class="foe-embers">${embers}</span>
  </div>`;
}
function wrathBanner({ x, far }, i) {
  return `<div class="wrath-banner${far ? " far" : ""}" style="left:${x}%;--d:${i * WRATH_BURN_MS + WRATH_REPLACE_MS}ms">
    <div class="banner-drop"><svg class="banner-art" viewBox="0 -30 120 560">
      <rect class="pole" x="57" y="0" width="6" height="530" rx="2"/><path class="tip" d="M60 -28 67 2H53Z"/>
      <g class="cloth"><path d="${BANNER_SHAPES[0]}">${bannerWave(i)}</path>
        <g class="emblem" transform="translate(60 150)"><path d="M0 -34 30 -17V17L0 34-30 17V-17Z"/><path class="emblem-core" d="m0 -17 10 17-10 17-10-17Z"/><path d="M-30 -17 0 0 30 -17M0 0V34"/></g></g>
      <rect class="bar" x="6" y="12" width="108" height="8" rx="4"/><circle class="finial" cx="6" cy="16" r="6"/><circle class="finial" cx="114" cy="16" r="6"/>
    </svg></div>
    <span class="banner-dust"></span>
  </div>`;
}
function buildWrath() {
  if (wrath.built) return;
  wrath.built = true;
  byId("wrathMap").innerHTML = wrathMap();
  byId("wrathBanners").innerHTML = WRATH_BANNERS.map(wrathFoe).join("") + WRATH_BANNERS.map(wrathBanner).join("");
}
async function summonWrath() {
  if (riteBusy()) return;
  wrath.running = true;
  closeSearch(); closeLightbox(); closeMenus();
  buildWrath();
  const overlay = byId("wrathRite"), img = byId("wrathImage"), stage = byId("wrathStage");
  if (!img.getAttribute("src")) img.src = "/wrath.webp";
  await img.decode().catch(() => {});
  const still = reducedMotion.matches;
  overlay.className = `wrath-rite${still ? " still" : ""}`;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  const later = (ms, fn) => wrath.timers.push(setTimeout(fn, ms));
  const finish = () => {
    wrath.timers.forEach(clearTimeout); wrath.timers = [];
    removeEventListener("keydown", skip, true); overlay.removeEventListener("click", skip);
    overlay.hidden = true; overlay.className = "wrath-rite";
    document.body.style.overflow = "";
    wrath.running = false;
    toast("The Wrath has claimed another world.");
    setTimeout(() => droidReact("Another world conquered. I'll redraw the maps. Again."), 700);
  };
  const skip = (event) => { if (event.type === "keydown") { event.preventDefault(); event.stopPropagation(); } finish(); };
  setTimeout(() => { if (wrath.running) { addEventListener("keydown", skip, true); overlay.addEventListener("click", skip); } }, 400);
  if (still) { overlay.classList.add("shown", "point", "conquest", "banners", "conquers", "glory", "titled"); byId("wrathTally").textContent = "∞"; byId("wrathTally").parentElement.classList.add("infinite"); later(4500, finish); return; }
  void overlay.offsetWidth;
  overlay.classList.add("shown");
  later(900, () => overlay.classList.add("point"));
  later(1800, () => overlay.classList.add("conquest"));
  later(1800, () => countConquests(5700 - 1800));
  later(2200, () => overlay.classList.add("banners"));
  // Each Sith banner shakes the ground as it lands where an enemy's stood.
  WRATH_BANNERS.forEach((banner, i) => later(2200 + i * WRATH_BURN_MS + WRATH_REPLACE_MS + 420, () => { stage.classList.remove("jolt"); void stage.offsetWidth; stage.classList.add("jolt"); }));
  later(4500, () => { overlay.classList.add("conquers"); skyFlash(.6); });
  later(5700, () => overlay.classList.add("glory"));
  later(6400, () => overlay.classList.add("titled"));
  later(11200, () => overlay.classList.add("leaving"));
  later(11900, finish);
}
// The tally of worlds taken climbs ever faster, then gives way to infinity.
function countConquests(duration) {
  const tally = byId("wrathTally"), box = tally.parentElement;
  box.classList.remove("infinite");
  const start = performance.now(), rate = Math.log(9000) / duration;
  const step = () => {
    if (!wrath.running) return;
    const t = performance.now() - start;
    if (t >= duration) { tally.textContent = "∞"; box.classList.add("infinite"); return; }
    tally.textContent = Math.max(1, Math.floor(Math.exp(rate * t))).toLocaleString("en-GB");
    wrath.timers.push(setTimeout(step, 70));
  };
  step();
}

/* ───────── The Emperor's Voice ─────────
 * Typing "voice" (or summoning him from the terminal) brings Darth Soteris, the Emperor's
 * Voice, into an ancient Sith temple. The hall wakes (.s1), the ritual circle at his feet
 * ignites (.s2), six holocrons rise and orbit him on rings of violet energy (.s3), the temple
 * answers with flying debris and burning rune pillars (.s4), and the Emperor's spirit rises
 * behind him: "The Emperor whispers." (.s5). Power gathers round the Voice (.s6) and is
 * released in violet lightning: "The Voice thunders." (.s7). Then the aftermath and his name
 * (.s8). The scene is drawn on a 1600 by 900 stage scaled to fill the screen. */
const VOICE_WORD = HUNT.on ? "knowledge" : "voice";
const voice = { running: false, timers: [], frame: 0, built: false, holocrons: [] };
const VOICE_STAGES = [300, 1100, 2200, 3400, 4600, 5800, 6800, 8000];
// A rune: two or three angular strokes on a stem, in a 10 by 10 cell.
function runePath(seed) {
  let h = hash(`rune:${seed}`);
  const rand = () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296; };
  const at = (lo, hi) => (lo + rand() * (hi - lo)).toFixed(1);
  const stem = `M5 1V9`;
  const kinds = [
    () => `M5 ${at(1, 4)}L${at(7, 9)} ${at(3, 6)}M5 ${at(5, 8)}L${at(1, 3)} ${at(6, 9)}`,
    () => `M5 ${at(1, 3)}L${at(1, 3)} ${at(3, 5)}M5 ${at(1, 3)}L${at(7, 9)} ${at(3, 5)}`,
    () => `M${at(1, 3)} ${at(2, 4)}L5 ${at(4, 6)}L${at(7, 9)} ${at(6, 8)}`,
    () => `M5 ${at(2, 4)}L${at(7, 9)} 5L5 ${at(6, 8)}`,
    () => `M${at(1, 3)} 3H${at(7, 9)}M${at(2, 4)} 7L${at(6, 8)} ${at(5, 8)}`
  ];
  return stem + kinds[Math.floor(rand() * kinds.length)]() + (rand() < .4 ? kinds[Math.floor(rand() * kinds.length)]() : "");
}
// A ring of runes about the origin, each standing on the circle and facing out.
const runeRing = (prefix, radius, count, size, turn = 0) => Array.from({ length: count }, (_, i) =>
  `<path d="${runePath(`${prefix}${i}`)}" transform="rotate(${(i * 360 / count + turn).toFixed(1)}) translate(0 ${-radius}) scale(${size}) translate(-5 -5)"/>`).join("");
const spinning = (seconds, to) => `<animateTransform attributeName="transform" type="rotate" from="0" to="${to}" dur="${seconds}s" repeatCount="indefinite"/>`;
function buildVoice() {
  if (voice.built) return;
  voice.built = true;
  let h = hash("voice-temple");
  const rand = () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296; };
  const between = (lo, hi) => lo + rand() * (hi - lo);
  // The hall: receding columns hung with banners, and a stair up to a lit doorway.
  let hall = "";
  for (const side of [-1, 1]) {
    [[740, 120, 0], [560, 90, 40], [420, 70, 90], [320, 52, 130]].forEach(([dx, w, top]) => {
      const x = 800 + side * dx - w / 2;
      hall += `<rect class="vt-col" x="${x}" y="${top}" width="${w}" height="${900 - top}"/><rect class="vt-col-edge" x="${x + (side < 0 ? w - 4 : 0)}" y="${top}" width="4" height="${900 - top}"/>`;
    });
    [[650, 62, 360, 30], [490, 48, 300, 70], [370, 38, 250, 110]].forEach(([dx, w, len, top]) => {
      const x = 800 + side * dx - w / 2;
      hall += `<path class="vt-ban" d="M${x} ${top}H${x + w}V${top + len}L${x + w / 2} ${top + len - w * .5}L${x} ${top + len}Z"/><path class="vt-emb" d="M${x + w / 2} ${top + len * .32}l${w * .24} ${w * .14}v${w * .28}l${-w * .24} ${w * .14}l${-w * .24} ${-w * .14}v${-w * .28}Z"/>`;
    });
  }
  const stairs = Array.from({ length: 10 }, (_, i) => `<rect class="vt-step" x="${630 + i * 14}" y="${560 - i * 14}" width="${340 - i * 28}" height="14"/>`).join("");
  const pillars = [-1, 1].flatMap((side) => [[560, 760, 300, 56], [380, 700, 220, 42]].map(([dx, base, tall, w], k) => {
    const x = 800 + side * dx;
    const runes = Array.from({ length: 6 }, (_, j) => `<path d="${runePath(`pillar${side}${k}${j}`)}" transform="translate(${x} ${(base - tall + 40 + j * (tall - 60) / 5).toFixed(0)}) scale(${(w / 22).toFixed(2)}) translate(-5 -5)"/>`).join("");
    return `<path class="vt-ob" d="M${x - w / 2} ${base}L${x - w / 2 + 4} ${base - tall + 20}L${x} ${base - tall}L${x + w / 2 - 4} ${base - tall + 20}L${x + w / 2} ${base}Z"/><g class="vt-runes">${runes}</g>`;
  })).join("");
  const bolt = (ang, len) => {
    let x = 800, y = 560; const pts = [[x, y]];
    for (let k = 0; k < 10; k += 1) { x += Math.cos(ang) * len / 10 + between(-14, 14); y += Math.sin(ang) * len / 10 + between(-14, 14); pts.push([x, y]); }
    return "M" + pts.map(([a, b]) => `${a.toFixed(0)} ${b.toFixed(0)}`).join(" L");
  };
  const bolts = [-2.9, -2.5, -2.1, -1.8, -1.4, -1, -.6, -.25, .15, 3, 2.7].map((a, i) => `<path d="${bolt(a, between(260, 520))}" style="--k:${i % 4}"/>`).join("");
  const debris = Array.from({ length: 26 }, () => `<i style="left:${between(40, 1560).toFixed(0)}px;top:${between(380, 860).toFixed(0)}px;--s:${between(14, 46).toFixed(0)}px;--r:${between(0, 360).toFixed(0)}deg;--t:${between(5, 9).toFixed(1)}s;--d:${(-between(0, 5)).toFixed(1)}s"></i>`).join("");
  const motes = Array.from({ length: 60 }, () => `<i style="left:${between(200, 1400).toFixed(0)}px;--t:${between(4, 8).toFixed(1)}s;--d:${(-between(0, 8)).toFixed(1)}s;--x:${between(-60, 60).toFixed(0)}px"></i>`).join("");
  const holocron = `<svg viewBox="-40 -40 80 80"><polygon class="vt-hf" points="0,-34 29,-17 29,17 0,34 -29,17 -29,-17"/><polygon class="vt-hf2" points="0,-34 29,-17 0,0 -29,-17"/>
    <path class="vt-hl" d="M0 -34V0M29 -17L0 0L-29 -17M0 0V34M-29 17L-14 8M29 17L14 8M-14 -25L0 -12L14 -25M-20 6L-10 0M20 6L10 0"/><circle r="11" fill="url(#vtCore)"/></svg>`;
  const stage = byId("voiceStage");
  stage.innerHTML = `
    <svg class="vt-abs vt-hall" viewBox="0 0 1600 900"><defs>
      <linearGradient id="vtCol" x1="0" x2="1"><stop offset="0" stop-color="#140a10"/><stop offset=".5" stop-color="#22121a"/><stop offset="1" stop-color="#0c0609"/></linearGradient>
      <linearGradient id="vtBeam" x1="0" x2="1"><stop offset="0" stop-color="#ff2e4a" stop-opacity="0"/><stop offset=".5" stop-color="#ff6a80" stop-opacity=".9"/><stop offset="1" stop-color="#ff2e4a" stop-opacity="0"/></linearGradient>
      <linearGradient id="vtBeamFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".45" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff"/></linearGradient>
      <mask id="vtBeamMask"><rect x="700" y="0" width="200" height="560" fill="url(#vtBeamFade)"/></mask>
      <radialGradient id="vtCore"><stop offset="0" stop-color="#fff"/><stop offset=".3" stop-color="#ff5a6a"/><stop offset="1" stop-color="#ff1e3c" stop-opacity="0"/></radialGradient>
      <radialGradient id="vtSpirit" cx=".5" cy=".35" r=".7"><stop offset="0" stop-color="#d27bff" stop-opacity=".75"/><stop offset=".55" stop-color="#7a1fd1" stop-opacity=".42"/><stop offset="1" stop-color="#3a0a6a" stop-opacity="0"/></radialGradient>
    </defs>
      <g mask="url(#vtBeamMask)"><rect class="vt-beam" x="760" y="0" width="80" height="560" fill="url(#vtBeam)"/><rect class="vt-beam" x="792" y="0" width="16" height="560" fill="#ffd0d8" opacity=".5"/></g>
      <rect x="740" y="380" width="120" height="180" fill="#0a0408" stroke="#3a1420"/>${stairs}${hall}</svg>
    <div class="vt-floor"></div>
    <div class="vt-ring"><svg viewBox="-340 -340 680 680"><g>${spinning(60, 360)}<circle r="320"/><circle r="280"/><circle r="214"/>${runeRing("vring", 300, 40, 2.4)}${runeRing("vring2", 236, 28, 1.9, 6)}</g></svg></div>
    <svg class="vt-spirit" viewBox="0 0 800 820">
      <path class="vt-sb" d="M400 40C340 40 300 100 295 170C250 190 200 220 150 300L60 480C90 500 130 490 160 470L230 380C240 500 230 640 210 820H590C570 640 560 500 570 380L640 470C670 490 710 500 740 480L650 300C600 220 550 190 505 170C500 100 460 40 400 40Z"/>
      <path class="vt-sl" d="M400 40C340 40 300 100 295 170C250 190 200 220 150 300L60 480M400 40C460 40 500 100 505 170C550 190 600 220 650 300L740 480M400 170V820"/>
      <path class="vt-folds" d="M330 260Q360 520 330 820M470 260Q440 520 470 820M400 300V820M260 400Q300 600 270 820M540 400Q500 600 530 820"/>
      <path class="vt-claws" d="M60 480l-22 14M60 480l-14 22M60 480l-26 2M740 480l22 14M740 480l14 22M740 480l26 2"/>
      <ellipse cx="400" cy="180" rx="56" ry="64" fill="#07020c"/><path class="vt-hood" d="M344 180Q400 100 456 180"/><circle class="vt-eye" cx="380" cy="178" r="6"/><circle class="vt-eye" cx="420" cy="178" r="6"/></svg>
    <svg class="vt-abs vt-pillars" viewBox="0 0 1600 900">${pillars}</svg>
    <div class="vt-circle"><div class="vt-circle-glow"></div><svg viewBox="-560 -120 1120 240"><g transform="scale(1 .21)">
      <g class="vt-r0">${spinning(40, 360)}<circle r="500"/>${runeRing("floor", 440, 36, 3.6)}<circle r="380"/></g>
      <g class="vt-r1">${spinning(28, -360)}<circle r="340"/>${runeRing("floor2", 300, 24, 2.9)}<circle r="200"/></g></g></svg></div>
    <div class="vt-abs vt-debris">${debris}</div>
    <div class="vt-aura"></div>
    <div class="vt-trails"><svg viewBox="-400 -200 800 400">${[[330, 70, -12], [280, 90, 14], [380, 60, 4]].map(([rx, ry, rot]) => `<ellipse rx="${rx}" ry="${ry}" transform="rotate(${rot})"/>`).join("")}</svg></div>
    <div class="vt-abs" id="vtBack"></div>
    <div class="vt-feet"></div>
    <img class="vt-voice" id="voiceImage" alt="Darth Soteris, the Emperor's Voice" width="482" height="664" />
    <div class="vt-shade"></div>
    <div class="vt-abs" id="vtFront"></div>
    <svg class="vt-abs vt-bolts" viewBox="0 0 1600 900">${bolts}</svg>
    <div class="vt-abs vt-motes">${motes}</div>`;
  voice.holocrons = Array.from({ length: 6 }, () => {
    const el = document.createElement("div");
    el.className = "vt-holo"; el.innerHTML = holocron;
    byId("vtBack").append(el);
    return el;
  });
}
// The stage keeps its shape and fills the screen; on tall phones it fills the width instead.
function fitVoice() {
  const scale = Math.max(innerWidth / 1600, Math.min(innerHeight / 900, innerWidth / 700));
  byId("voiceStage").style.setProperty("--vt-scale", scale.toFixed(4));
}
// The holocrons ride three tilted orbits round him, passing in front and behind; they rise
// from the floor once the third stage begins.
const VOICE_ORBITS = [[330, 70, -12], [280, 90, 14], [380, 60, 4]];
function placeVoiceHolocrons(t, rise) {
  const back = byId("vtBack"), front = byId("vtFront");
  voice.holocrons.forEach((el, i) => {
    const [rx, ry, rot] = VOICE_ORBITS[i % 3], r = rot * Math.PI / 180;
    const a = t * .0006 * (i % 2 ? 1 : -1) * (1 + i * .08) + i * Math.PI / 3;
    const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
    const X = x * Math.cos(r) - y * Math.sin(r), Y = x * Math.sin(r) + y * Math.cos(r);
    const depth = Math.sin(a), scale = .75 + .35 * (depth + 1) / 2;
    el.style.transform = `translate(${(800 + X - 38).toFixed(1)}px, ${(580 + Y - 38 + (1 - rise) * 220).toFixed(1)}px) scale(${scale.toFixed(3)}) rotate(${(t * .05 + i * 40).toFixed(1)}deg)`;
    const layer = depth > 0 ? front : back;
    if (el.parentNode !== layer) layer.append(el);
  });
}
async function summonVoice() {
  if (riteBusy()) return;
  voice.running = true;
  closeSearch(); closeLightbox(); closeMenus();
  buildVoice();
  const overlay = byId("voiceRite"), img = byId("voiceImage"), stage = byId("voiceStage");
  if (!img.getAttribute("src")) img.src = "/voice.webp";
  await img.decode().catch(() => {});
  const still = reducedMotion.matches;
  overlay.className = `voice-rite${still ? " still" : ""}${perf.lite ? " lite" : ""}`;
  overlay.hidden = false;
  fitVoice(); addEventListener("resize", fitVoice);
  document.body.style.overflow = "hidden";
  const later = (ms, fn) => voice.timers.push(setTimeout(fn, ms));
  const finish = () => {
    voice.timers.forEach(clearTimeout); voice.timers = [];
    cancelAnimationFrame(voice.frame); voice.frame = 0;
    removeEventListener("resize", fitVoice);
    removeEventListener("keydown", skip, true); overlay.removeEventListener("click", skip);
    overlay.hidden = true; overlay.className = "voice-rite";
    document.body.style.overflow = "";
    voice.running = false;
    toast("The Emperor's Voice has spoken.");
    setTimeout(() => droidReact("I understood none of that. Which is how I know it was powerful."), 700);
  };
  const skip = (event) => { if (event.type === "keydown") { event.preventDefault(); event.stopPropagation(); } finish(); };
  setTimeout(() => { if (voice.running) { addEventListener("keydown", skip, true); overlay.addEventListener("click", skip); } }, 400);
  if (still) { VOICE_STAGES.forEach((ms, i) => overlay.classList.add(`s${i + 1}`)); placeVoiceHolocrons(0, 1); later(4500, finish); return; }
  const t0 = performance.now();
  let risen = 0;
  const tick = (now) => {
    voice.frame = requestAnimationFrame(tick);
    if (!risen && overlay.classList.contains("s3")) risen = now;
    placeVoiceHolocrons(now - t0, risen ? Math.min(1, (now - risen) / 1400) : 0);
  };
  voice.frame = requestAnimationFrame(tick);
  const enter = (n) => {
    overlay.classList.add(`s${n}`);
    if (n === 4 || n === 7) { stage.classList.remove("jolt"); void stage.offsetWidth; stage.classList.add("jolt"); }
    if (n === 7) skyFlash(.8);
  };
  VOICE_STAGES.forEach((ms, i) => later(ms, () => enter(i + 1)));
  later(11600, () => overlay.classList.add("leaving"));
  later(12300, finish);
}

function startAura() {
  const canvas = byId("riteAura"), g = canvas.getContext("2d");
  const ratio = Math.min(devicePixelRatio || 1, perf.lite ? 1 : 1.5);
  canvas.width = innerWidth * ratio; canvas.height = innerHeight * ratio;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  const { hot, red } = riteSprites();
  rite.target = .12;
  const tick = (now) => {
    rite.frame = requestAnimationFrame(tick);
    rite.intensity += (rite.target - rite.intensity) * .06;
    const box = byId("riteEmperor").getBoundingClientRect();
    const scale = box.height / 429;
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, innerWidth, innerHeight);
    // New flames: off the edge of his silhouette, and up the envelope around him.
    const spawn = Math.round(rite.intensity * (perf.lite ? 7 : 18));
    for (let i = 0; i < spawn && rite.edges.length; i += 1) {
      if (Math.random() < .62) {
        const e = rite.edges[Math.floor(Math.random() * rite.edges.length)];
        rite.particles.push({ x: box.left + e.x * box.width, y: box.top + e.y * box.height, vx: e.nx * (.4 + Math.random()) * scale, vy: (-1.6 - Math.random() * 3.2 + e.ny * .6) * scale, life: 0, max: 26 + Math.random() * 30, size: (9 + Math.random() * 18) * scale, stretch: 1.6 + Math.random() });
      } else {
        // The envelope: an egg of flame all the way round him, licking up into spikes over his head.
        const a = Math.random() * Math.PI * 2, rx = box.width * .7, ry = box.height * .6;
        const above = Math.sin(a) < 0;
        rite.particles.push({ x: box.left + box.width / 2 + Math.cos(a) * rx * (above ? .8 : 1), y: box.top + box.height * .5 + Math.sin(a) * ry, vx: Math.cos(a) * .3 * scale, vy: (above ? -6 - Math.random() * 6 : -4 - Math.random() * 5) * scale, life: 0, max: above ? 14 + Math.random() * 16 : 22 + Math.random() * 26, size: (14 + Math.random() * 24) * scale, stretch: above ? 3 + Math.random() * 2 : 2.4 + Math.random() * 1.6 });
      }
    }
    g.globalCompositeOperation = "lighter";
    // A halo of light behind him that breathes with the aura.
    if (rite.intensity > .05) {
      const cx = box.left + box.width / 2, cy = box.top + box.height * .48, r = box.height * .75;
      const halo = g.createRadialGradient(cx, cy, r * .1, cx, cy, r);
      halo.addColorStop(0, `rgba(255,120,110,${(.32 * Math.min(1, rite.intensity) * (.85 + Math.sin(now / 160) * .15)).toFixed(3)})`);
      halo.addColorStop(.5, `rgba(227,38,47,${(.16 * Math.min(1, rite.intensity)).toFixed(3)})`);
      halo.addColorStop(1, "rgba(120,0,10,0)");
      g.fillStyle = halo; g.beginPath(); g.ellipse(cx, cy, r * .8, r, 0, 0, Math.PI * 2); g.fill();
    }
    rite.particles = rite.particles.filter((p) => {
      p.life += 1; if (p.life > p.max) return false;
      p.x += p.vx + Math.sin((p.life + p.y) * .15) * .5; p.y += p.vy; p.vy *= .985;
      const t = p.life / p.max, fade = Math.sin(Math.PI * Math.min(1, t * 1.15)) * Math.min(1, rite.intensity + .15);
      const w = p.size * (1 - t * .55), h = w * p.stretch;
      g.globalAlpha = fade * .55;
      g.drawImage(red, p.x - w, p.y - h, w * 2, h * 2);
      if (t < .45) { g.globalAlpha = fade * (.45 - t) * 1.6; g.drawImage(hot, p.x - w * .6, p.y - h * .6, w * 1.2, h * 1.2); }
      return true;
    });
    g.globalAlpha = 1;
  };
  rite.frame = requestAnimationFrame(tick);
}
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
 * state (see updateSyncLabel). On larger screens it patrols the stage's perimeter, clear of
 * the index rail; pointer events make it draggable with mouse or touch. */
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
  "Touch the core. Watch the vaults answer.",
  "Type “peaceisalie”. The archive is listening.",
  "Say “emperor”. If you dare.",
  "Type “regent”. Watch his blade.",
  "Type “voice”. The old spells still answer.",
  "Type “wrath”. Plant a banner.",
  "Type “hand”. Then hear the snap.",
  "Type “dhg”. The gate is guarded.",
];
let droidBubbleTimer;
const droidMotion = { x: 0, y: 0, pointerId: null, offsetX: 0, offsetY: 0, startX: 0, startY: 0, dragged: false, suppressClick: false, patrolIndex: 0, patrolTimer: 0, resumeTimer: 0 };
function showDroidBubble(text, { label = "", ms = 2800 } = {}) {
  const bubble = byId("droidBubble");
  bubble.textContent = text;
  if (label) { const tag = document.createElement("small"); tag.className = "bubble-label"; tag.textContent = label; bubble.prepend(tag); }
  bubble.classList.toggle("clue", Boolean(label));
  bubble.classList.add("show");
  clearTimeout(droidBubbleTimer);
  droidBubbleTimer = setTimeout(() => bubble.classList.remove("show"), ms);
}
function droidReact(line) {
  const droid = byId("droid");
  droid.classList.remove("startled"); void droid.offsetWidth; droid.classList.add("startled");
  showDroidBubble(line || DROID_QUIPS[Math.floor(Math.random() * DROID_QUIPS.length)]);
}
function droidLimits() {
  const droid = byId("droid");
  const margin = innerWidth <= 760 ? 10 : 18;
  const rail = byId("rail").getBoundingClientRect();
  const left = narrow.matches ? margin : rail.right + margin;
  const top = narrow.matches ? (byId("siteHeader").getBoundingClientRect().bottom || 0) + 12 : margin;
  const bottom = innerHeight - droid.offsetHeight - margin - (scrubber.headings.length ? 56 : 0);
  return { minX: left, maxX: Math.max(left, innerWidth - droid.offsetWidth - margin), minY: top, maxY: Math.max(top, bottom) };
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
  droid.addEventListener("click", () => { if (droidMotion.suppressClick) return; if (HUNT.on) huntClue(true); else droidReact(); });
  if (HUNT.on) scheduleHuntClue(9000);
  window.addEventListener("resize", () => { placeDroid(droidMotion.x, droidMotion.y); scheduleDroidPatrol(2400); }, { passive: true });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopDroidPatrol(); else scheduleDroidPatrol(2200); });
  scheduleDroidPatrol();
}

/* ───────── Performance guard ─────────
 * Everyone starts on the full version. Shortly after the first page renders we sample real
 * frame timing for ~1.5s of visible time, and only if the page is consistently choppy does it
 * switch to a lighter mode for the rest of the tab session: the blurred drifting glows become
 * static gradients, the embers and grain stop, the orrery holds still and lightning loses its
 * glow. The rail switch lets anyone pick either mode; that choice is remembered and always
 * beats the automatic check. ?fx=lite / ?fx=full force either mode for the current tab. */
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
  toast("Lighter effects on for smoother performance — switch back in the index rail");
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

/* ───────── Seasonal wrapper: Halloween ─────────
 * Dathomir comes to the archive: the crimson turns Nightsister green, embers become
 * spirit-fire, Force lightning crackles green, and a fixed layer behind the page holds a
 * sickly moon, a web with a dangling spider, bats, hooded Sith spectres drifting through
 * the dark, a graveyard of Sith tombstones in green fog, eyes that blink from the shadows
 * and a patch of jack-o'-lanterns (press them: trick or treat). The droid wears a
 * Nightsister's hat. Page content is never covered except by the small pumpkin patch.
 * Lite mode and reduced motion hold the same scene still. On by default for the season,
 * switchable from the rail (remembered). The <head> script in index.html applies the
 * class before first paint and carries the same end date: keep both in step.
 * Site-wide off: HALLOWEEN.enabled = false (and drop the class from that script). */
const HALLOWEEN = { enabled: true, until: "2026-11-02" };
const HW_PREF = "tso-halloween";
const halloween = { on: false, built: false, recolor: null, swarm: 0 };
const HW_EMBERS = ["95,227,106", "150,255,140", "60,200,90", "205,255,170", "255,140,26"];
const HW_QUIPS = [
  "Something is moving in the graveyard.",
  "The Nightsisters have claimed the archive tonight.",
  "Trick or treat. Mostly trick.",
  "The pumpkins are restless. Press one.",
  "Even the spectres come to read here.",
  "Do not feed the bats. Or the Sithspawn.",
  "Here lies the Jedi Order. Rest in pieces.",
];
const HW_SPECTRE = `<svg viewBox="0 0 80 124"><path d="M40 3C22 3 12 19 12 37c0 15-3 30-8 48 6-4 10 2 12 12 4-8 10-5 12 8 4-10 10-6 12 14 2-20 8-24 12-14 2-13 8-16 12-8 2-10 6-16 12-12-5-18-8-33-8-48C68 19 58 3 40 3z" fill="url(#hwSpectre)"/><path d="M40 14c-11 0-18 10-18 22 0 11 8 18 18 18s18-7 18-18c0-12-7-22-18-22z" fill="#020a05"/><path d="M14 52c8 6 14 18 14 30M66 52c-8 6-14 18-14 30" fill="none" stroke="rgba(190,255,200,.35)" stroke-width="1.6" stroke-linecap="round"/><ellipse class="hw-spectre-eye" cx="33" cy="35" rx="3.4" ry="1.7"/><ellipse class="hw-spectre-eye" cx="47" cy="35" rx="3.4" ry="1.7"/></svg>`;
const HW_GRAVEYARD = `<svg class="hw-graveyard" viewBox="0 0 1440 140" preserveAspectRatio="xMidYMax slice">
  <path class="hw-iron" stroke-width="5" d="M1320 114C1322 84 1316 62 1310 40M1312 58C1296 48 1288 42 1274 34M1314 50C1330 38 1342 32 1358 28M1310 40C1308 28 1312 18 1320 8M1284 39 1270 26M1346 31 1356 16M1274 34C1268 36 1262 34 1258 30"/>
  <path class="hw-iron" stroke-width="4" d="M604 106V76M626 104V72M648 105V78M670 103V70M692 106V75M714 104V73M736 105V79M758 103V71M780 106V76M598 86H786M598 98H786"/>
  <g class="hw-stone"><path d="M380 114V82q0-17 18-17t18 17v32z"/><path class="hw-rune" d="M398 74 405 78v8L398 90 391 86v-8Z"/></g>
  <g class="hw-stone" transform="rotate(-7 520 100)"><path d="M504 114V80q0-16 16-16t16 16v34z"/><text x="520" y="92" text-anchor="middle">RIP</text></g>
  <g class="hw-stone"><path d="M840 112V58l10-14 10 14v54z"/><path class="hw-rune" d="M850 66 855 69v6L850 78 845 75v-6Z"/></g>
  <g class="hw-stone"><path d="M900 112V66q0-22 26-22t26 22v46z"/><text x="926" y="80" text-anchor="middle">JEDI</text><text class="hw-small" x="926" y="92" text-anchor="middle">R.I.P.</text></g>
  <g class="hw-stone" transform="rotate(6 1060 96)"><path d="M1046 108V80h-11v-9h11V60h10v11h11v9h-11v28z"/></g>
  <g class="hw-stone" transform="rotate(4 1190 98)"><path d="M1176 108V88q0-10 12-10t12 10v20z"/></g>
  <path class="hw-ground" d="M0 140V112q120-14 260-4t300-6 320 6 300-10 260 8v34z"/>
</svg>`;
const HW_BAT = `<svg viewBox="0 0 64 28"><path d="M32 11C30 7 28 6 26 6c1 2 1 3 0 4-4-3-11-5-20-3 4 2 5 5 4 8 4-1 7 0 9 3 2-2 5-2 7 0l6 6 6-6c2-2 5-2 7 0 2-3 5-4 9-3-1-3 0-6 4-8-9-2-16 0-20 3-1-1-1-2 0-4-2 0-4 1-6 5z"/></svg>`;
const HW_SPIDER = `<svg class="hw-spider-body" viewBox="0 0 40 40"><path d="M16 18 8 10 4 14M16 20 6 18 2 24M16 22 8 26 6 33M17 24 12 30 12 37M24 18 32 10 36 14M24 20 34 18 38 24M24 22 32 26 34 33M23 24 28 30 28 37" fill="none" stroke="#2c3a30" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="20" cy="22" rx="6" ry="7" fill="#1d2a21"/><circle cx="20" cy="13.5" r="4" fill="#1d2a21"/><circle cx="18.6" cy="13" r="1" fill="#8cff6a"/><circle cx="21.4" cy="13" r="1" fill="#8cff6a"/></svg>`;
const HW_PUMPKIN = `<svg viewBox="0 0 100 92"><path d="M47 22c0-9 3-14 9-17l4 4c-5 2-7 7-7 13z" fill="#3f6b25"/><path d="M58 9c8-2 14 2 16 8-6-3-11-3-15-1z" fill="#4c8a2a"/><ellipse cx="29" cy="56" rx="24" ry="32" fill="#b24a0a"/><ellipse cx="71" cy="56" rx="24" ry="32" fill="#b24a0a"/><ellipse cx="50" cy="56" rx="27" ry="35" fill="#e2690f"/><path d="M50 22v68" stroke="#b24a0a" stroke-width="1.6" opacity=".6"/><g class="hw-face" fill="#ffd36a"><path d="M27 48l12-10 6 12z"/><path d="M55 50l6-12 12 10z"/><path d="M46 58l4-8 4 8z"/><path d="M24 62q26 12 52 0-4 20-26 22-22-2-26-22z"/></g><path d="M34 65l5 8 5-7zM52 67l5 7 5-8zM44 79l3-6 3 6z" fill="#e2690f"/></svg>`;

function halloweenInSeason() {
  return HALLOWEEN.enabled && Date.now() < new Date(`${HALLOWEEN.until}T00:00:00`).getTime();
}
/* A corner web for the top-right of the viewport: spokes fanning from the corner, joined
 * by rings that sag slightly toward it (the SVG is mirrored in CSS). */
function hwWeb() {
  const spokes = [0, 15, 30, 45, 60, 75, 90].map((deg) => (deg * Math.PI) / 180);
  const at = (r, a) => `${(r * Math.cos(a)).toFixed(1)} ${(r * Math.sin(a)).toFixed(1)}`;
  let d = spokes.map((a) => `M0 0L${at(220, a)}`).join("");
  for (const r of [34, 70, 108, 150, 196]) {
    for (let i = 0; i < spokes.length - 1; i += 1) d += `M${at(r, spokes[i])}Q${at(r * .86, (spokes[i] + spokes[i + 1]) / 2)} ${at(r, spokes[i + 1])}`;
  }
  return `<svg class="hw-web" viewBox="0 0 220 220"><path d="${d}"/></svg>`;
}
function buildHalloween() {
  if (halloween.built) return;
  halloween.built = true;
  // sx/sy: where a bat hangs when the scene is held still (Lite / reduced motion).
  const bats = [
    { w: 40, y: "9vh", dur: 24, delay: -3, sx: "63vw", sy: "3vh" },
    { w: 26, y: "21vh", dur: 31, delay: -14, sx: "50vw", sy: "10vh", back: true },
    { w: 32, y: "14vh", dur: 27, delay: -20, sx: "57vw", sy: "15vh" },
    { w: 22, y: "30vh", dur: 35, delay: -8, sx: "0", sy: "0", back: true },
    { w: 28, y: "5vh", dur: 29, delay: -25, sx: "0", sy: "0" },
  ];
  // Spectres drift between A and B, fading as they pass; S is where each waits when held still.
  const spectres = [
    { size: 84, ax: "26vw", ay: "58vh", bx: "34vw", by: "26vh", sx: "28vw", sy: "40vh", dur: 18, delay: -4 },
    { size: 70, ax: "90vw", ay: "36vh", bx: "80vw", by: "60vh", sx: "88vw", sy: "46vh", dur: 21, delay: -9 },
    { size: 54, ax: "44vw", ay: "14vh", bx: "70vw", by: "8vh", sx: "52vw", sy: "12vh", dur: 26, delay: -12, wide: true },
    { size: 46, ax: "30vw", ay: "78vh", bx: "76vw", by: "70vh", sx: "0", sy: "0", dur: 30, delay: -18, roamer: true, wide: true },
  ];
  const eyes = [
    { at: "left:calc(var(--rail-w) + 14vw);bottom:5vh", eye: 6, gap: 7, blink: 6, delay: -1 },
    { at: "right:30vw;bottom:8vh", eye: 5, gap: 6, blink: 8, delay: -5, wide: true },
    { at: "right:2.4vw;top:42vh", eye: 7, gap: 8, blink: 7, delay: -3 },
  ];
  byId("hwLayer").innerHTML = `
    <div class="hw-moon"><i></i></div>
    ${hwWeb()}
    <div class="hw-spider"><i class="hw-thread"></i>${HW_SPIDER}</div>
    <div class="hw-bats">${bats.map((b) => `<div class="hw-bat${b.back ? " is-back" : ""}" style="--w:${b.w}px;--y:${b.y};--dur:${b.dur}s;--delay:${b.delay}s;--sx:${b.sx};--sy:${b.sy}">${HW_BAT}</div>`).join("")}</div>
    <div class="hw-spectres">${spectres.map((g) => `<div class="hw-spectre${g.roamer ? " is-roamer" : ""}${g.wide ? " is-wide" : ""}" style="--size:${g.size}px;--sx:${g.sx};--sy:${g.sy};--ax:${g.ax};--ay:${g.ay};--bx:${g.bx};--by:${g.by};--dur:${g.dur}s;--delay:${g.delay}s"><div class="hw-spectre-bob">${HW_SPECTRE}</div></div>`).join("")}</div>
    <div class="hw-spectre-peek">${HW_SPECTRE}</div>
    <div class="hw-graveyard-glow"></div>
    <div class="hw-fog hw-fog-a"></div><div class="hw-fog hw-fog-b"></div>
    ${HW_GRAVEYARD}
    ${eyes.map((e) => `<div class="hw-eyes${e.wide ? " is-wide" : ""}" style="${e.at};--eye:${e.eye}px;--gap:${e.gap}px;--blink:${e.blink}s;--delay:${e.delay}s"><i></i><i></i></div>`).join("")}`;
  byId("hwPatch").innerHTML = `<span class="hw-pumpkin"><i class="hw-pumpkin-glow"></i>${HW_PUMPKIN}</span><span class="hw-pumpkin is-small"><i class="hw-pumpkin-glow"></i>${HW_PUMPKIN}</span>`;
}
/* Trick or treat: the lanterns flare and a swarm of bats bursts out across the screen. */
const HW_TRICKS = ["Trick or treat!", "You woke the bats.", "The lanterns remember you.", "Bats. Why is it always bats.", "Treat denied. Trick granted."];
function hwTrick() {
  const patch = byId("hwPatch");
  patch.classList.remove("flare"); void patch.offsetWidth; patch.classList.add("flare");
  droidReact(HW_TRICKS[halloween.swarm++ % HW_TRICKS.length]);
  if (reducedMotion.matches || perf.lite) return;
  const box = patch.getBoundingClientRect();
  const swarm = document.createElement("div");
  swarm.className = "hw-swarm";
  swarm.setAttribute("aria-hidden", "true");
  swarm.innerHTML = Array.from({ length: 22 }, (_, i) => {
    const angle = -Math.PI / 2 + (Math.random() - .3) * 1.9;
    const reach = innerHeight * (.55 + Math.random() * .6);
    return `<i class="hw-swarm-bat" style="--x0:${(box.left + box.width / 2).toFixed(0)}px;--y0:${(box.top + box.height * .4).toFixed(0)}px;--dx:${(Math.cos(angle) * reach * 1.4).toFixed(0)}px;--dy:${(Math.sin(angle) * reach).toFixed(0)}px;--w:${(26 + Math.random() * 38).toFixed(0)}px;--t:${(1.3 + Math.random() * .9).toFixed(2)}s;--d:${(i * .04).toFixed(2)}s">${HW_BAT}</i>`;
  }).join("");
  document.body.appendChild(swarm);
  setTimeout(() => swarm.remove(), 2800);
}
function setHalloween(on) {
  halloween.on = on;
  if (on) buildHalloween();
  document.documentElement.classList.toggle("theme-halloween", on);
  byId("hwLayer").hidden = !on;
  byId("hwPatch").hidden = !on;
  byId("hwToggle").setAttribute("aria-checked", String(on));
  byId("hwToggleState").textContent = on ? "On" : "Off";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", on ? "#040a06" : "#070508");
  halloween.recolor?.();
}
function initHalloween() {
  if (!halloweenInSeason()) { document.documentElement.classList.remove("theme-halloween"); return; }
  byId("hwToggle").hidden = false;
  let pref = null;
  try { pref = localStorage.getItem(HW_PREF); } catch {}
  setHalloween(pref !== "off");
  if (halloween.on) DROID_QUIPS.push(...HW_QUIPS);
  if (!halloween.on) return;
  try {
    if (sessionStorage.getItem("tso-hw-greeted")) return;
    sessionStorage.setItem("tso-hw-greeted", "1");
  } catch {}
  setTimeout(() => { if (halloween.on && !riteBusy()) showDroidBubble("The Nightsisters have claimed the archive. Happy Halloween.", { ms: 4200 }); }, 2600);
}
function toggleHalloween() {
  setHalloween(!halloween.on);
  try { localStorage.setItem(HW_PREF, halloween.on ? "on" : "off"); } catch {}
  for (const line of HW_QUIPS) { const at = DROID_QUIPS.indexOf(line); if (at >= 0) DROID_QUIPS.splice(at, 1); }
  if (halloween.on) DROID_QUIPS.push(...HW_QUIPS);
}

/* ───────── Atmosphere ─────────
 * Embers rise from the bottom of the archive, sway, flicker, and scatter away from the
 * pointer; the crimson aura follows the cursor and the archive core tilts toward it. */
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
  const pickColor = () => { const palette = halloween.on ? HW_EMBERS : colors; return palette[Math.random() < .08 ? 4 : Math.floor(Math.random() * 4)]; };
  const spawn = (anywhere) => ({ x: Math.random() * width, y: anywhere ? Math.random() * height : height + 10, vx: 0, size: .6 + Math.random() * 1.8, speed: .25 + Math.random() * .7, sway: Math.random() * Math.PI * 2, swaySpeed: .004 + Math.random() * .014, alpha: .25 + Math.random() * .55, color: pickColor() });
  halloween.recolor = () => { for (const ember of embers) ember.color = pickColor(); };
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
  const target = event.target.closest(".btn, .rail-query, .slip, .passage a, .plaque, .orrery-node");
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
  const progress = Math.min(1, Math.max(0, scrollY / scrollMax()));
  byId("readingProgress").style.setProperty("--progress", progress.toFixed(4));
  byId("siteHeader").classList.toggle("scrolled", scrollY > 12);
  updateScrubber();
}
window.addEventListener("scroll", updateProgress, { passive: true });

/* ───────── Boot ───────── */
byId("menuToggle").addEventListener("click", () => (document.body.classList.contains("rail-open") ? closeMenus() : openRail()));
byId("searchTrigger").addEventListener("click", () => openSearch());
byId("searchTriggerMobile").addEventListener("click", () => openSearch());
byId("fxToggle").addEventListener("click", toggleFxMode);
byId("hwToggle").addEventListener("click", toggleHalloween);
byId("hwPatch").addEventListener("click", hwTrick);
byId("closeSearch").addEventListener("click", closeSearch);
byId("globalSearch").addEventListener("input", (event) => renderSearch(event.target.value));
byId("globalSearch").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") { event.preventDefault(); moveSearch(1); }
  if (event.key === "ArrowUp") { event.preventDefault(); moveSearch(-1); }
  if (event.key === "Enter") { const item = state.searchMatches[state.searchIndex]; if (item) { event.preventDefault(); if (item.recite) { huntFound("code"); reciteCode(); } else if (item.summon) summon(item.summon); else navigate(item.href); } }
});
document.addEventListener("keydown", (event) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
  if ((event.key === "/" && !typing && !event.metaKey && !event.ctrlKey) || (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey))) { event.preventDefault(); openSearch(); }
  if (event.key === "Escape") { closeLightbox(); closeSearch(); closeMenus(); }
});
narrow.addEventListener("change", () => { closeMenus(); placeDroid(droidMotion.x, droidMotion.y); });
window.addEventListener("popstate", () => route({ hash: location.hash }));
applyChosenFxMode();
initHalloween();
createAtmosphere();
initDroid();
start();
