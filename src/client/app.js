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
 * holocron rises to the middle of the screen, its capstone lifts away, and the light inside
 * floods out to fill the screen. The record is swapped in under the light as it fades. */
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
    const flare = document.createElement("div");
    flare.className = "holo-flare";
    const diagonal = Math.hypot(innerWidth, innerHeight);
    flare.style.cssText = `width:${diagonal * 1.25}px;height:${diagonal * 1.25}px`;
    stage.replaceChildren(flyer, flare);
    stage.className = "holo-open active";
    holocron.classList.add("lifted");
    const size = Math.min(innerWidth * .46, innerHeight * .42, 340);
    const scale = size / box.width;
    const dx = innerWidth / 2 - (box.left + box.width / 2), dy = innerHeight * .46 - (box.top + box.height / 2);
    const rise = flyer.animate([{ transform: "none" }, { transform: `translate(${dx}px, ${dy}px) scale(${scale})` }], { duration: perf.lite ? 380 : 560, easing: "cubic-bezier(.2,.75,.25,1)", fill: "forwards" });
    await wait(perf.lite ? 260 : 400);
    stage.classList.add("unsealed"); // the capstone lifts, the beam and core ignite
    await rise.finished.catch(() => {});
    if (!perf.lite) {
      const cx = innerWidth / 2, cy = innerHeight * .46;
      for (let i = 0; i < 5; i += 1) setTimeout(() => { const a = Math.random() * Math.PI * 2, r = size * (.9 + Math.random() * .7); strike(cx, cy - size * .1, cx + Math.cos(a) * r, cy + Math.sin(a) * r, { width: 1.6 }); }, i * 70);
    }
    await wait(perf.lite ? 120 : 260);
    stage.classList.add("flood"); // the light pours out over the screen
    await wait(perf.lite ? 340 : 480);
    swap(); swapped = true;
    app.classList.remove("holo-arrive"); void app.offsetWidth; app.classList.add("holo-arrive");
    stage.classList.add("fade");
    await wait(perf.lite ? 420 : 700);
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
    ${tree.length ? `<p class="rail-label">Vaults</p>${tree.map(railNode).join("")}` : ""}
    <p class="rail-label">Records</p>
    <a class="rail-link" href="/codex" data-link data-route="/codex"><em aria-hidden="true">✦</em><span>The Catalogue</span><small>${state.site.files.length}</small></a>
    <button type="button" class="rail-link" id="randomButton"><em aria-hidden="true">⟳</em><span>Random record</span></button>`;
  byId("randomButton").addEventListener("click", jumpToRandomRecord);
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
  return `<a class="holocron tone-${tone}" role="listitem" href="${fileHref(file)}" data-link data-prefetch="${esc(file.key)}" data-holocron="${esc(file.key)}" style="--scale:${(.86 + r * .26).toFixed(3)};--d:${Math.min(index * 70, 700)}ms;--bob:${(4.2 + r2 * 2.6).toFixed(2)}s">
    <span class="holocron-float">${holocronSvg(file.key)}</span>
    <span class="holocron-pool" aria-hidden="true"></span>
    <span class="holocron-name" data-file-name="${esc(file.key)}">${esc(fileTitle(file))}</span>
    <span class="holocron-ref">${esc(fileRefNo(file).slice(-3))} · ${esc(KIND[file.kind]?.short || "File")}</span>
  </a>`;
}
function plaqueHtml(file) {
  const vault = fileVault(file);
  return `<span class="plaque-thumb" data-seed="${esc(file.key)}">${thumbHtml(file)}</span>
    <span class="plaque-text"><small>${esc(fileRefNo(file))} · ${esc(KIND[file.kind]?.label || "File")}${vault ? ` · ${esc(vault.title)}` : ""}</small><strong data-file-name="${esc(file.key)}">${esc(fileTitle(file))}</strong></span>
    <span class="plaque-open" aria-hidden="true">Unseal →</span>`;
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
      out.push(`<div class="slips in-prose">${items.map((item) => { const file = fileByKey(item.key); return file ? slipHtml(file) : ""; }).join("")}</div>`);
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
function jumpToRandomRecord() {
  const files = state.site.files;
  if (!files.length) { droidReact("The holocron vault is empty. For now."); return; }
  let pick = files[Math.floor(Math.random() * files.length)];
  for (let guard = 0; guard < 8 && files.length > 1 && fileHref(pick) === currentPath() + location.search; guard += 1) pick = files[Math.floor(Math.random() * files.length)];
  droidReact("Retrieving a record at random.");
  navigate(fileHref(pick));
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
  app.innerHTML = `<article class="page dossier">${dossierHead(file)}<div id="docBody">${LOADING("Decrypting the record")}</div></article>`;
  afterRender(options);
  const doc = await loadDoc(file);
  if (token !== state.renderToken) return;
  if (doc.error) {
    setStatus(doc.error === "missing" ? "Struck" : doc.error === "error" ? "Unreachable" : "Sealed", true);
    byId("fileLength").textContent = "—";
    byId("docBody").innerHTML = doc.error === "error" ? `<div class="sealed"><h2>The archive could not reach this record</h2><p>Google did not answer in time. Try again in a moment.</p><button class="btn" type="button" id="retryDoc">Try again</button></div>` : sealedNotice(file, doc.error);
    byId("retryDoc")?.addEventListener("click", () => route({ instant: true }));
    return;
  }
  document.title = `${fileTitle(file)} — TSO Central Archives`;
  setStatus("Unsealed");
  byId("fileLength").textContent = `${readingMinutes(doc.words)} min · ${doc.words.toLocaleString("en-GB")} words`;
  byId("fileTools").innerHTML = `<span class="scale-control" role="group" aria-label="Text size"><button type="button" data-scale="-1" aria-label="Smaller text">A−</button><button type="button" data-scale="1" aria-label="Larger text">A+</button></span>
    <button type="button" class="tool" id="copyLink">Copy link</button>${originalLink(file)}`;
  const vault = fileVault(file);
  const related = vault ? vault.fileKeys.map(fileByKey).filter((item) => item && item.key !== file.key) : [];
  byId("docBody").innerHTML = `<div class="prose doc-prose" style="--doc-scale:${docScale}">${doc.html || `<p class="notice">This record is blank.</p>`}</div>
    ${related.length ? `${SABER_RULE(`More holocrons from ${vault.title}`)}<div class="stacks">${shelfHtml(related)}</div>` : ""}
    ${siblingsNav(file)}`;
  app.querySelectorAll("[data-scale]").forEach((button) => button.addEventListener("click", () => {
    docScale = Math.min(1.3, Math.max(.85, docScale + Number(button.dataset.scale) * .075));
    app.querySelector(".doc-prose").style.setProperty("--doc-scale", docScale);
    try { localStorage.setItem("tso-archives-scale", String(docScale)); } catch {}
    requestAnimationFrame(layoutScrubber);
  }));
  byId("copyLink").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Link copied to your datapad"); } catch { toast("Copy failed — use the address bar"); }
  });
  const body = byId("docBody");
  bindImageFallbacks(body); observeReveals(body);
  setupScrubber(doc.headings);
  if (options.hash) byId(decodeURIComponent(options.hash.slice(1)))?.scrollIntoView({ block: "start" });
  updateProgress();
}

async function renderSheet(file, options) {
  const token = state.renderToken;
  app.innerHTML = `<article class="page dossier sheet-page">${dossierHead(file)}<div id="sheetBody">${LOADING("Opening the ledger")}</div></article>`;
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
  if (!tabs.length) { setStatus("Sealed", true); byId("fileLength").textContent = "—"; byId("sheetBody").innerHTML = sealedNotice(file, status === "missing" ? "missing" : "restricted"); return; }
  setStatus("Unsealed");
  byId("fileLength").textContent = `${plural(tabs.length, "sheet")} · ${plural(tabs.reduce((sum, tab) => sum + Math.max(0, tab.rows.length - 1), 0), "row")}`;
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
      <label class="filter"><span aria-hidden="true">›</span><input id="sheetFilter" type="search" placeholder="filter rows" autocomplete="off" aria-label="Filter rows" /></label>
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
  const drawing = `/api/img?u=${encodeURIComponent(`https://docs.google.com/drawings/d/${file.id}/export/png`)}`;
  const body = file.kind === "drawings"
    ? `<div class="viewer viewer-image"><button data-zoom="${drawing}" aria-label="Enlarge drawing"><img src="${drawing}" alt="${esc(fileTitle(file))}" /></button></div>`
    : `<div class="viewer viewer-${frame.shape}"><iframe src="${esc(frame.src)}" title="${esc(fileTitle(file))}" loading="lazy" allow="fullscreen" referrerpolicy="no-referrer-when-downgrade"></iframe></div>`;
  app.innerHTML = `<article class="page dossier viewer-page">${dossierHead(file, "Projected", "Projected")}
    ${body}
    <p class="viewer-note">If the projection stays dark, the record has not been shared publicly — open it in ${esc(KIND[file.kind]?.app || "Google Drive")} instead.</p>
    ${siblingsNav(file)}
  </article>`;
  afterRender(options);
}

function renderNotFound() {
  document.title = "Record not found — TSO Central Archives";
  app.innerHTML = `<div class="empty-page">${glyph("void")}<h1>Nothing is filed here</h1><p>This reference does not exist in the archive, or it has been struck from the record.</p><a class="btn" href="/" data-link>Return to the gate</a></div>`;
  afterRender();
}

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
  const rank = (item) => (item.title.toLowerCase().startsWith(value) ? 0 : item.title.toLowerCase().includes(value) ? 1 : item.where.toLowerCase().includes(value) ? 2 : 3);
  const matches = items.filter((item) => !value || `${item.title} ${item.where} ${item.ref} ${item.text}`.toLowerCase().includes(value)).sort((a, b) => (value ? rank(a) - rank(b) : 0)).slice(0, 40);
  const letters = lettersOf(value);
  if (letters.length >= 5 && (CODE_WORDS.startsWith(letters) || letters.startsWith(CODE_WORDS))) matches.unshift({ recite: true, tag: "CODE", title: "Recite the Code of the Sith", where: "Peace is a lie, there is only passion…", ref: "◆", href: "#code" });
  // Someone searching "emperor" may want the Emperor's pages, so he waits just behind the best match.
  if (letters === HAND_WORD) matches.splice(Math.min(1, matches.length), 0, { summon: "hand", tag: "HAND", title: "Summon the Emperor's Hand", where: "The Emperor commands. The Hand enforces.", ref: "◆", href: "#hand" });
  if (letters.length >= 5 && WRATH_WORD.startsWith(letters)) matches.splice(Math.min(1, matches.length), 0, { summon: "wrath", tag: "WRATH", title: "Summon the Emperor's Wrath", where: "The Emperor points. The Wrath conquers.", ref: "◆", href: "#wrath" });
  if (letters.length >= 5 && VOICE_WORD.startsWith(letters)) matches.splice(Math.min(1, matches.length), 0, { summon: "voice", tag: "VOICE", title: "Summon the Emperor's Voice", where: "UnvincibleShadow, the Emperor's Voice", ref: "◆", href: "#voice" });
  if (letters.length >= 5 && REGENT_WORD.startsWith(letters)) matches.splice(Math.min(1, matches.length), 0, { summon: "regent", tag: "REGENT", title: "Summon the Dark Regent", where: "Discovery, Dark Regent of the Sith", ref: "◆", href: "#regent" });
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
      const thumb = image.closest(".plaque-thumb, .dossier-thumb");
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
  if (event.target.closest("[data-recite]")) { event.preventDefault(); reciteCode(); return; }
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
    if (!perf.lite) { lctx.shadowColor = "rgba(150,130,255,.9)"; lctx.shadowBlur = 18; }
    lctx.strokeStyle = `rgba(140,120,255,${(flicker * .55).toFixed(3)})`; lctx.lineWidth = bolt.width * 3.2; trace();
    lctx.shadowBlur = 0;
    lctx.strokeStyle = `rgba(235,232,255,${flicker.toFixed(3)})`; lctx.lineWidth = bolt.width; trace();
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
  if (typed.endsWith("power")) { typed = ""; forceStorm(); }
  else if (typed.endsWith(CODE_WORDS)) { typed = ""; reciteCode(); }
  else if (typed.endsWith(EMPEROR_WORD)) { typed = ""; summonEmperor(); }
  else if (typed.endsWith(REGENT_WORD)) { typed = ""; summonRegent(); }
  else if (typed.endsWith(VOICE_WORD)) { typed = ""; summonVoice(); }
  else if (typed.endsWith(WRATH_WORD)) { typed = ""; summonWrath(); }
  else if (typed.endsWith(HAND_WORD)) { typed = ""; summonHand(); }
});

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
 * Typing "regent" (or summoning him from the terminal) brings Discovery, Dark Regent of the
 * Sith and its second in command, before the enemies of the Sith. He has already struck:
 * three cuts of blade-light cross the screen while he stands still, his sword spins down out
 * of the air and slides home into the scabbard on his back, and on the click of the hilt the
 * enemies fall apart along the cuts. Then the vow, and his name. */
const REGENT_WORD = "regent";
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

const summon = (who) => ({ regent: summonRegent, voice: summonVoice, wrath: summonWrath, hand: summonHand }[who] || summonEmperor)();
const riteBusy = () => recital.running || rite.running || regent.running || voice.running || wrath.running || hand.running;

/* ───────── The Emperor's Hand ─────────
 * Typing "hand" (or summoning him from the terminal) brings the Emperor's Hand out of the
 * shadows: black mist pours in and wraps a dark shape like a cloak, then billows away from him
 * as he takes form. The Emperor commands: his gauntlet rises and its six crystals wake. The
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
  later(3200, () => overlay.classList.add("raised")); // the gauntlet rises and its crystals wake
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
const WRATH_WORD = "wrath";
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
function wrathBanner({ x, far }, i) {
  const shapes = ["M12 20H108Q108 175 108 330L60 296L12 330Q12 175 12 20Z", "M12 20H108Q122 170 114 332L64 300L16 326Q2 168 12 20Z", "M12 20H108Q98 180 104 328L56 294L8 332Q20 182 12 20Z"];
  const wave = [0, 1, 0, 2, 0].map((n) => shapes[n]).join(";");
  return `<div class="wrath-banner${far ? " far" : ""}" style="left:${x}%;--d:${i * 260}ms">
    <div class="banner-drop"><svg class="banner-art" viewBox="0 -30 120 560">
      <rect class="pole" x="57" y="0" width="6" height="530" rx="2"/><path class="tip" d="M60 -28 67 2H53Z"/>
      <g class="cloth"><path d="${shapes[0]}"><animate attributeName="d" values="${wave}" dur="${(2.6 + i * .3).toFixed(1)}s" repeatCount="indefinite"/></path>
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
  byId("wrathBanners").innerHTML = WRATH_BANNERS.map(wrathBanner).join("");
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
  if (still) { overlay.classList.add("shown", "point", "conquest", "banners", "conquers", "glory", "titled"); later(4500, finish); return; }
  void overlay.offsetWidth;
  overlay.classList.add("shown");
  later(900, () => overlay.classList.add("point"));
  later(1800, () => overlay.classList.add("conquest"));
  later(2200, () => overlay.classList.add("banners"));
  // Each banner shakes the ground as it lands.
  WRATH_BANNERS.forEach((banner, i) => later(2200 + 420 + i * 260, () => { stage.classList.remove("jolt"); void stage.offsetWidth; stage.classList.add("jolt"); }));
  later(3700, () => { overlay.classList.add("conquers"); skyFlash(.6); });
  later(4700, () => overlay.classList.add("glory"));
  later(5400, () => overlay.classList.add("titled"));
  later(10400, () => overlay.classList.add("leaving"));
  later(11100, finish);
}

/* ───────── The Emperor's Voice ─────────
 * Typing "voice" (or summoning him from the terminal) brings UnvincibleShadow, the Emperor's
 * Voice, into a circle of Sith runes that inscribes itself behind him and on the ground. He
 * rises into the air; an ancient spellbook opens before him and its pages turn; runes lift off
 * the pages and spiral up around him while four holocrons circle him; then the runes gather
 * into a sigil above his head, the holocrons open, and the spell is made manifest. */
const VOICE_WORD = "voice";
const voice = { running: false, timers: [], frame: 0, built: false, glyphs: [], runes: null, holocrons: [] };
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
function runeCircle(prefix, outer, count) {
  const band = Array.from({ length: count }, (_, i) => {
    const a = (i / count) * 360, r = outer - 9;
    return `<path class="rune" style="--i:${i}" d="${runePath(`${prefix}${i}`)}" transform="rotate(${a}) translate(-4 ${-r - 4}) scale(.8)"/>`;
  }).join("");
  const inner = Array.from({ length: 12 }, (_, i) => `<path class="rune" style="--i:${i + count}" d="${runePath(`${prefix}in${i}`)}" transform="rotate(${i * 30 + 15}) translate(-3 -45) scale(.6)"/>`).join("");
  return `<circle class="line" pathLength="1" r="${outer}"/><circle class="line" pathLength="1" r="${outer - 18}"/>${band}
    <polygon class="line" pathLength="1" points="0,-72 62.4,36 -62.4,36"/><polygon class="line" pathLength="1" points="0,72 62.4,-36 -62.4,-36"/>
    <circle class="line" pathLength="1" r="52"/><circle class="line" pathLength="1" r="36"/>${inner}`;
}
function buildVoice() {
  if (voice.built) return;
  voice.built = true;
  // The circles turn about their own centre (SVG's rotate, which CSS origins get wrong on a centred viewBox).
  const turning = (seconds, to) => `<animateTransform attributeName="transform" type="rotate" from="0" to="${to}" dur="${seconds}s" repeatCount="indefinite"/>`;
  byId("voiceRing").innerHTML = `<g>${turning(48, 360)}${runeCircle("ring", 96, 30)}</g>`;
  byId("voiceFloor").innerHTML = `<g>${turning(64, -360)}${runeCircle("floor", 96, 36)}</g>`;
  voice.runes = Array.from({ length: 18 }, (_, i) => new Path2D(runePath(`spell${i}`)));
  byId("voiceHolocrons").innerHTML = Array.from({ length: 4 }, (_, i) => `<span class="voice-holocron tone-${i % 2 ? 3 : 2}">${holocronSvg(`voice${i}`)}</span>`).join("");
  voice.holocrons = [...byId("voiceHolocrons").children];
}
async function summonVoice() {
  if (riteBusy()) return;
  voice.running = true;
  closeSearch(); closeLightbox(); closeMenus();
  buildVoice();
  const overlay = byId("voiceRite"), img = byId("voiceImage");
  if (!img.getAttribute("src")) img.src = "/voice.webp";
  await img.decode().catch(() => {});
  const rig = byId("voiceRig");
  const still = reducedMotion.matches;
  overlay.className = `voice-rite${still ? " still" : ""}`;
  overlay.hidden = false;
  rig.style.setProperty("--rig-w", `${rig.getBoundingClientRect().width}px`);
  document.body.style.overflow = "hidden";
  const later = (ms, fn) => voice.timers.push(setTimeout(fn, ms));
  const finish = () => {
    voice.timers.forEach(clearTimeout); voice.timers = [];
    cancelAnimationFrame(voice.frame); voice.frame = 0; voice.glyphs = [];
    removeEventListener("keydown", skip, true); overlay.removeEventListener("click", skip);
    overlay.hidden = true; overlay.className = "voice-rite";
    document.body.style.overflow = "";
    voice.running = false;
    toast("The Emperor's Voice has spoken.");
    setTimeout(() => droidReact("I understood none of that. Which is how I know it was powerful."), 700);
  };
  const skip = (event) => { if (event.type === "keydown") { event.preventDefault(); event.stopPropagation(); } finish(); };
  setTimeout(() => { if (voice.running) { addEventListener("keydown", skip, true); overlay.addEventListener("click", skip); } }, 400);
  if (still) { overlay.classList.add("inscribed", "risen", "open", "manifest", "vow"); placeHolocrons(0); later(4500, finish); return; }
  void overlay.offsetWidth;
  overlay.classList.add("inscribed"); // the circles draw themselves
  later(500, () => overlay.classList.add("risen"));
  later(1400, () => overlay.classList.add("open")); // the book opens and its pages turn
  later(2000, () => { voice.casting = true; });
  voice.casting = false; voice.manifest = false;
  startSpell();
  later(4600, () => {
    voice.manifest = true; overlay.classList.add("manifest");
    skyFlash(.7);
  });
  later(5200, () => overlay.classList.add("vow"));
  later(9800, () => { overlay.classList.add("leaving"); voice.casting = false; });
  later(10500, finish);
}
// The holocrons ride an ellipse round his middle, larger and in front of him on the near side.
function placeHolocrons(t) {
  const rig = byId("voiceRig").getBoundingClientRect();
  voice.holocrons.forEach((el, i) => {
    const a = t * .0009 + i * Math.PI / 2, near = Math.sin(a);
    const x = Math.cos(a) * rig.width * .95, y = near * rig.height * .09 - rig.height * .06;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${(.82 + near * .22).toFixed(3)})`;
    el.style.zIndex = near > 0 ? 4 : 1;
    el.style.opacity = byId("voiceRite").classList.contains("open") ? (.75 + near * .25).toFixed(2) : "0";
  });
}
function startSpell() {
  const back = byId("voiceBack"), front = byId("voiceFront");
  const ratio = Math.min(devicePixelRatio || 1, perf.lite ? 1 : 1.5);
  const size = () => { const r = back.getBoundingClientRect(); for (const c of [back, front]) { c.width = r.width * ratio; c.height = r.height * ratio; c.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0); } return r; };
  let box = size();
  const gb = back.getContext("2d"), gf = front.getContext("2d");
  const t0 = performance.now();
  const tick = (now) => {
    voice.frame = requestAnimationFrame(tick);
    placeHolocrons(now - t0);
    const img = byId("voiceImage").getBoundingClientRect();
    box = back.getBoundingClientRect();
    const cx = img.left + img.width / 2 - box.left, top = img.top - box.top;
    const sigil = { x: cx, y: top - img.height * .17 };
    const book = byId("voiceRig").querySelector(".book-tilt").getBoundingClientRect();
    for (const g of [gb, gf]) g.clearRect(0, 0, box.width, box.height);
    if (voice.casting && voice.glyphs.length < (perf.lite ? 40 : 90)) {
      for (let i = 0; i < (perf.lite ? 1 : 2); i += 1) voice.glyphs.push({
        x0: book.left - box.left + book.width * (.15 + Math.random() * .7), y0: book.top - box.top + book.height * (.2 + Math.random() * .5),
        phase: Math.random() * Math.PI * 2, spin: (Math.random() < .5 ? -1 : 1) * (2.2 + Math.random() * 1.6) * Math.PI,
        reach: img.width * (.75 + Math.random() * .5), life: 0, max: 130 + Math.random() * 80, rune: voice.runes[Math.floor(Math.random() * voice.runes.length)], size: 15 + Math.random() * 12
      });
    }
    voice.glyphs = voice.glyphs.filter((p) => {
      p.life += voice.manifest ? 2.2 : 1;
      const u = Math.min(1, p.life / p.max);
      if (u >= 1) return false;
      // Up from the page in a widening, then tightening spiral, ending in the sigil.
      const ease = u * u * (3 - 2 * u), radius = p.reach * Math.sin(Math.PI * Math.min(1, u * 1.1)) * (1 - u * .4);
      const a = p.phase + p.spin * u;
      const x = p.x0 + (sigil.x - p.x0) * ease + Math.cos(a) * radius, y = p.y0 + (sigil.y - p.y0) * ease;
      const g = Math.sin(a) > 0 ? gf : gb;
      const alpha = Math.min(1, u * 6) * (1 - Math.max(0, u - .85) / .15);
      g.save(); g.translate(x, y); g.rotate(Math.sin(a) * .3); g.scale(p.size / 10, p.size / 10); g.translate(-5, -5);
      g.lineCap = "round"; g.lineJoin = "round";
      g.globalAlpha = alpha * .45; g.strokeStyle = "#b48cff"; g.lineWidth = 3.2; g.stroke(p.rune);
      g.globalAlpha = alpha; g.strokeStyle = "#ffe3a3"; g.lineWidth = 1.1; g.stroke(p.rune);
      g.restore();
      return true;
    });
  };
  voice.frame = requestAnimationFrame(tick);
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
  droid.addEventListener("click", () => { if (!droidMotion.suppressClick) droidReact(); });
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
byId("closeSearch").addEventListener("click", closeSearch);
byId("globalSearch").addEventListener("input", (event) => renderSearch(event.target.value));
byId("globalSearch").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") { event.preventDefault(); moveSearch(1); }
  if (event.key === "ArrowUp") { event.preventDefault(); moveSearch(-1); }
  if (event.key === "Enter") { const item = state.searchMatches[state.searchIndex]; if (item) { event.preventDefault(); if (item.recite) reciteCode(); else if (item.summon) summon(item.summon); else navigate(item.href); } }
});
document.addEventListener("keydown", (event) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
  if ((event.key === "/" && !typing && !event.metaKey && !event.ctrlKey) || (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey))) { event.preventDefault(); openSearch(); }
  if (event.key === "Escape") { closeLightbox(); closeSearch(); closeMenus(); }
});
narrow.addEventListener("change", () => { closeMenus(); placeDroid(droidMotion.x, droidMotion.y); });
window.addEventListener("popstate", () => route({ hash: location.hash }));
applyChosenFxMode();
createAtmosphere();
initDroid();
start();
