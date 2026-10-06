/* TSO Central Archives — Worker
 *
 * The published Google Site is the source of truth. This Worker reads it live and hands
 * the browser just enough to rebuild it as a themed archive:
 *
 *   /api/site    every page of the site (its navigation plus any page linked from a page),
 *                each page's main content with scripts and styles removed, and every Google
 *                Doc, Sheet, Slides deck, Form, Drawing, Drive file or folder the pages link
 *                to or embed.
 *   /api/doc     a Google Doc's HTML export (or a "Publish to web" copy), for the browser to
 *                turn into a reading page.
 *   /api/sheet   a Google Sheet's public HTML view, with its CSV export as a fallback.
 *   /api/title   the title of any other linked Google file, for cards that have no label.
 *   /api/img     images hosted by Google (site images, images inside docs, file thumbnails).
 *
 * Every upstream is fixed to Google hosts and every id is validated, so none of these can be
 * pointed at an arbitrary URL. Documents must be shared as "Anyone with the link can view"
 * (or published to the web); anything else comes back as `restricted` and the page offers the
 * original link instead.
 *
 * GOOGLE_UPSTREAM is only for local development: when set (for example to
 * http://127.0.0.1:8899) every Google request goes to `${GOOGLE_UPSTREAM}/<host><path>`,
 * so `wrangler dev` can run against saved copies of the site and its documents. */

const SITE_ORIGIN = "https://sites.google.com";
const SITE_PREFIX = "/view/tso-central-archives";
const SITE_HOME = `${SITE_PREFIX}/home`;
const MAX_PAGES = 30;
const MAX_TITLE_LOOKUPS = 16;
const SITE_TTL = 120;   // seconds the assembled site is reused before re-reading Google
const DOC_TTL = 300;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const ID = /^[A-Za-z0-9_-]{20,140}$/;
const KINDS = ["document", "spreadsheets", "presentation", "forms", "drawings", "file", "folder"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/site") return await siteResponse(env, ctx, url.searchParams.has("fresh"));
      if (url.pathname === "/api/doc") return await docResponse(env, url);
      if (url.pathname === "/api/sheet") return await sheetResponse(env, url);
      if (url.pathname === "/api/title") return await titleResponse(env, url);
      if (url.pathname === "/api/img") return await imageResponse(env, url);
    } catch (error) {
      return json({ ok: false, error: "The archive could not reach Google.", detail: error instanceof Error ? error.message : String(error) }, 503, 0);
    }
    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "Unknown endpoint" }, 404, 0);

    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404 || url.pathname.includes(".")) return asset;
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }
    return new Response("Not found", { status: 404 });
  }
};

function json(body, status = 200, maxAge = 60) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": maxAge ? `public, max-age=${maxAge}, s-maxage=${maxAge * 2}` : "no-store",
      "X-Robots-Tag": "noindex"
    }
  });
}

/* ───────── Upstream ───────── */
function upstreamUrl(env, target) {
  if (!env.GOOGLE_UPSTREAM) return target;
  const parsed = new URL(target);
  return `${env.GOOGLE_UPSTREAM.replace(/\/$/, "")}/${parsed.host}${parsed.pathname}${parsed.search}`;
}
/* Google Sites serves its own uploads (banners, logos) only to visitors carrying the NID
 * cookie it sets when a page of the site loads, so the Worker keeps the latest one it was
 * given and presents it when it fetches those images. */
let siteCookie = "";
async function google(env, target, ttl = 60) {
  const toSite = new URL(target).hostname === "sites.google.com";
  const headers = { "User-Agent": BROWSER_UA, "Accept-Language": "en-GB,en;q=0.9" };
  if (toSite && siteCookie) headers.Cookie = siteCookie;
  const response = await fetch(upstreamUrl(env, target), {
    headers,
    redirect: "follow",
    cf: { cacheTtlByStatus: { "200-299": ttl, "404": Math.min(ttl, 30), "300-399": 0, "400-403": 0, "405-599": 0 }, cacheEverything: true }
  });
  if (toSite) {
    const nid = (response.headers.get("set-cookie") || "").match(/\bNID=[^;,\s]+/);
    if (nid) siteCookie = nid[0];
  }
  return response;
}
/* A file that is not shared publicly answers with Google's sign-in page rather than an error. */
function isSignIn(response) {
  return /accounts\.google\.com|ServiceLogin/.test(response.url || "");
}
async function readText(env, target, ttl) {
  const response = await google(env, target, ttl);
  if (isSignIn(response) || response.status === 401 || response.status === 403) return { status: "restricted" };
  if (response.status === 404) return { status: "missing" };
  if (!response.ok) throw new Error(`Google returned ${response.status}`);
  const text = await response.text();
  if (/<form[^>]+action="https:\/\/accounts\.google\.com/i.test(text.slice(0, 20000))) return { status: "restricted" };
  return { status: "ok", text };
}

/* Pages from the last successful crawl, reused if Google stumbles on one page in a later crawl,
 * so a single failed request never makes a vault vanish from the archive. */
const lastGood = new Map();
async function readPage(env, path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await readText(env, `${SITE_ORIGIN}${path}`, 60).catch(() => ({ status: "error" }));
    if (result.status === "ok") { lastGood.set(path, result.text); return result; }
    if (result.status === "missing" || result.status === "restricted") return result;
  }
  return lastGood.has(path) ? { status: "ok", text: lastGood.get(path) } : { status: "error" };
}

/* A tiny per-isolate memo in front of the Cache API (which is a no-op on workers.dev). */
const memo = new Map();
async function remember(key, ttl, produce, fresh = false) {
  const hit = memo.get(key);
  if (!fresh && hit && hit.expires > Date.now()) return hit.value;
  const value = await produce();
  memo.set(key, { value, expires: Date.now() + ttl * 1000 });
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  return value;
}

/* ───────── Site ───────── */
async function siteResponse(env, ctx, fresh) {
  const cacheKey = new Request("https://archives.cache/api/site/v2");
  if (!fresh) {
    const cached = await caches.default.match(cacheKey).catch(() => null);
    if (cached) return cached;
  }
  const site = await remember("site", SITE_TTL, () => crawlSite(env), fresh);
  const response = json(site, site.ok ? 200 : 503, site.ok ? 45 : 0);
  if (site.ok) ctx?.waitUntil?.(caches.default.put(cacheKey, response.clone()).catch(() => {}));
  return response;
}

async function crawlSite(env) {
  const home = await readPage(env, SITE_HOME);
  if (home.status !== "ok") return { ok: false, error: home.status === "restricted" ? "The Google Site is not published publicly." : "The Google Site could not be found." };

  const siteName = metaContent(home.text, "og:site_name") || titleOf(home.text).split(/\s[-|–]\s/)[0] || "TSO Central Archives";
  const order = [];
  const pages = new Map();
  const note = (path, label) => {
    if (!path) return;
    if (!pages.has(path)) { pages.set(path, { path, label: "", html: null }); order.push(path); }
    const page = pages.get(path);
    if (!page.label && label) page.label = label;
  };
  note(SITE_HOME, "Home");
  for (const link of siteLinks(home.text)) note(link.path, link.label);
  pages.get(SITE_HOME).raw = home.text;

  // Navigation first, then one more pass for pages that are only linked from other pages.
  for (let round = 0; round < 2; round += 1) {
    const pending = order.filter((path) => pages.get(path).raw === undefined).slice(0, Math.max(0, MAX_PAGES - order.filter((path) => pages.get(path).raw !== undefined).length));
    await Promise.all(pending.map(async (path) => {
      const result = await readPage(env, path);
      pages.get(path).raw = result.status === "ok" ? result.text : null;
      if (result.status === "ok") for (const link of siteLinks(mainHtml(result.text))) note(link.path, link.label);
    }));
  }

  const docs = new Map();
  const list = order.map((path) => pages.get(path)).filter((page) => page.raw).slice(0, MAX_PAGES).map((page) => {
    const main = mainHtml(page.raw);
    const refs = fileRefs(main, page.raw);
    for (const ref of refs) {
      const key = refKey(ref);
      const entry = docs.get(key) || { ...ref, label: "", pages: [] };
      if (!entry.label && ref.label) entry.label = ref.label;
      if (!entry.gid && ref.gid) entry.gid = ref.gid;
      if (!entry.pages.includes(page.path)) entry.pages.push(page.path);
      docs.set(key, entry);
    }
    const slugPath = page.path === SITE_HOME ? "" : page.path.slice(SITE_PREFIX.length + 1);
    return {
      path: slugPath,
      source: `${SITE_ORIGIN}${page.path}`,
      title: cleanLabel(page.label) || titleOf(page.raw).split(/\s[-|–]\s/).pop() || "Untitled page",
      html: main,
      files: refs.map(refKey)
    };
  });

  // Fill in a name for linked files that were never given one, within a fixed budget.
  const unnamed = [...docs.values()].filter((doc) => !doc.label || /^(open|view|link|here|click here|document|doc)$/i.test(doc.label)).slice(0, MAX_TITLE_LOOKUPS);
  await Promise.all(unnamed.map(async (doc) => { doc.title = await fileTitle(env, doc).catch(() => ""); }));

  return {
    ok: true,
    name: cleanLabel(siteName),
    source: `${SITE_ORIGIN}${SITE_HOME}`,
    updatedAt: new Date().toISOString(),
    nav: navItems(home.text),
    pages: list,
    files: [...docs.values()].map((doc) => ({ key: refKey(doc), kind: doc.kind, id: doc.id, pub: Boolean(doc.pub), gid: doc.gid || "", label: cleanLabel(doc.label), title: cleanLabel(doc.title || ""), pages: doc.pages.map((path) => (path === SITE_HOME ? "" : path.slice(SITE_PREFIX.length + 1))) }))
  };
}

function metaContent(html, property) {
  const match = html.match(new RegExp(`<meta[^>]+(?:property|name)="${property}"[^>]*content="([^"]*)"`, "i")) || html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]*(?:property|name)="${property}"`, "i"));
  return match ? decodeEntities(match[1]) : "";
}
function titleOf(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]).trim() : "";
}
function stripTags(html) { return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim(); }
function cleanLabel(value = "") { return String(value).replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim().slice(0, 200); }
function decodeEntities(value = "") {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

/* The site's own menu, as Google Sites draws it: every entry of the first <nav> that has
 * any, in order, with its depth in the menu (a dropdown's pages sit one level below the
 * tab they hang from). The depth comes from the item's data-nav-level / aria-level when
 * Google provides one, otherwise from how deeply its list is nested. Entries are pages of
 * this site ({ path }), links that leave it ({ href }), or dropdown tabs that only group
 * other entries ({ group: true }). */
function navItems(html) {
  for (const region of html.match(/<nav\b[\s\S]*?<\/nav>/gi) || []) {
    const raw = [];
    const tag = /<(\/?)(ul|ol|li|a)\b([^>]*)>/gi;
    let match, depth = 0, liLevel = 0;
    while ((match = tag.exec(region))) {
      const [, close, rawName, attrs] = match;
      const name = rawName.toLowerCase();
      if (name === "ul" || name === "ol") { depth = Math.max(0, depth + (close ? -1 : 1)); continue; }
      if (name === "li") { if (!close) liLevel = Number((attrs.match(/\b(?:data-nav-level|aria-level)="(\d+)"/i) || [])[1]) || 0; continue; }
      if (close) continue;
      const end = region.indexOf("</a>", tag.lastIndex);
      const inner = end > 0 ? region.slice(tag.lastIndex, end) : "";
      const href = decodeEntities((attrs.match(/\bhref="([^"]*)"/i) || [])[1] || "").trim();
      const label = cleanLabel(stripTags(inner) || decodeEntities((attrs.match(/\baria-label="([^"]*)"/i) || [])[1] || ""));
      if (!label) continue;
      // A dropdown tab that isn't a page itself is an anchor with no address that opens a submenu.
      if (!href && /\baria-haspopup="true"|\bdata-navtype="4"/i.test(attrs)) { raw.push({ group: true, label, level: liLevel || depth }); continue; }
      if (!href || href.startsWith("#") || /^javascript:/i.test(href)) continue;
      raw.push({ href, label, level: liLevel || depth });
    }
    const listed = raw.filter((item) => item.level > 0);
    if (!listed.length) continue;
    const base = Math.min(...listed.map((item) => item.level));
    const seen = new Set();
    const items = [];
    for (const item of listed) {
      const path = item.group ? "" : sitePath(item.href);
      let entry;
      if (item.group) entry = { group: true };
      else if (path) entry = { path: path === SITE_HOME ? "" : path.slice(SITE_PREFIX.length + 1) };
      else {
        try {
          const url = new URL(unwrapGoogleRedirect(item.href), SITE_ORIGIN);
          if (!["http:", "https:"].includes(url.protocol)) continue;
          entry = { href: url.href };
        } catch { continue; }
      }
      const key = entry.group ? `group:${item.level}:${item.label}` : entry.path ?? entry.href;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ ...entry, label: item.label, level: Math.min(4, item.level - base + 1) });
    }
    if (items.length) return items;
  }
  return [];
}

/* Links to other pages of this site, in document order (the header navigation comes first). */
function siteLinks(html) {
  const out = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const href = (match[1].match(/\bhref="([^"]*)"/i) || [])[1];
    const path = sitePath(href ? decodeEntities(href) : "");
    if (!path) continue;
    const aria = (match[1].match(/\baria-label="([^"]*)"/i) || [])[1];
    out.push({ path, label: stripTags(match[2]) || (aria ? decodeEntities(aria) : "") });
  }
  return out;
}
function sitePath(href) {
  if (!href) return "";
  let path;
  try { path = new URL(unwrapGoogleRedirect(href), SITE_ORIGIN); } catch { return ""; }
  if (path.hostname !== "sites.google.com") return "";
  const clean = path.pathname.replace(/\/+$/, "");
  if (clean === SITE_PREFIX) return SITE_HOME;
  if (!clean.startsWith(`${SITE_PREFIX}/`)) return "";
  return /^[\w\-/%.~]+$/.test(clean) ? clean : "";
}
function unwrapGoogleRedirect(href) {
  try {
    const url = new URL(href, SITE_ORIGIN);
    if (/(^|\.)google\.com$/.test(url.hostname) && url.pathname === "/url") return url.searchParams.get("q") || url.searchParams.get("url") || href;
  } catch {}
  return href;
}

/* The page's own content: the role="main" region with scripts, styles and Google's
 * interaction attributes removed. Falls back to the whole <body> if the region is missing. */
function mainHtml(raw) {
  let start = raw.search(/<[a-z]+[^>]*\brole="main"/i);
  if (start < 0) start = raw.search(/<body\b/i);
  if (start < 0) start = 0;
  let end = raw.search(/<footer\b|<\/body>/i);
  if (end <= start) end = raw.length;
  return raw.slice(start, end)
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(link|meta)\b[^>]*>/gi, "")
    .replace(/\s(?:js[a-z]*|jsaction|jscontroller|jsmodel|jsname|jsdata|jsshadow|jsslot|data-(?:ved|p|ow|id|tooltip-[\w-]+|is-[\w-]+|hveid|rtid|initial-[\w-]+|dynamic-[\w-]+|maxwidth|first-[\w-]+))="[^"]*"/gi, "")
    .replace(/\s{2,}/g, " ")
    .slice(0, 600_000);
}

/* Every Google file the page refers to: links, embeds and data-embed-* attributes, with
 * URLs unwrapped from google.com/url?q= redirects and any JS/percent escaping undone. */
function fileRefs(main, raw) {
  const refs = new Map();
  const add = (ref) => { if (ID.test(ref.id) && KINDS.includes(ref.kind)) { const key = refKey(ref); const old = refs.get(key); if (!old || (!old.label && ref.label)) refs.set(key, { ...old, ...ref, label: ref.label || old?.label || "" }); } };

  const labelled = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = labelled.exec(main))) {
    const href = (match[1].match(/\bhref="([^"]*)"/i) || [])[1];
    if (!href) continue;
    const ref = parseFileUrl(unwrapGoogleRedirect(decodeEntities(href)));
    const aria = (match[1].match(/\baria-label="([^"]*)"/i) || [])[1];
    if (ref) add({ ...ref, label: stripTags(match[2]) || (aria ? decodeEntities(aria) : "") });
  }
  const text = unescapeUrls(main);
  const loose = /https?:\/\/(?:docs|drive)\.google\.com\/[^\s"'<>\\)]+/g;
  while ((match = loose.exec(text))) { const ref = parseFileUrl(match[0]); if (ref) add(ref); }
  const embeds = /data-embed-(?:doc-id|open-url|download-url)="([^"]+)"/gi;
  while ((match = embeds.exec(raw))) {
    const value = decodeEntities(match[1]);
    const ref = parseFileUrl(value) || (ID.test(value) ? { kind: "file", id: value } : null);
    if (ref && ![...refs.values()].some((item) => item.id === ref.id)) add(ref);
  }
  // An embed links the same file twice: a generic Drive link ("Open Document, <title> in new
  // window") and its Docs/Sheets/Slides preview. One record per file: the specific kind wins,
  // and the embed's own label is reduced to the title.
  const byId = new Map();
  for (const ref of refs.values()) {
    const old = byId.get(ref.id);
    if (!old) { byId.set(ref.id, ref); continue; }
    const keep = old.kind === "file" && ref.kind !== "file" ? ref : old;
    const other = keep === ref ? old : ref;
    byId.set(ref.id, { ...keep, label: keep.label || other.label, gid: keep.gid || other.gid || "" });
  }
  return [...byId.values()].map((ref) => {
    const embed = embedLabel(ref.label);
    return { ...ref, kind: ref.kind === "file" && embed.kind ? embed.kind : ref.kind, label: embed.title };
  });
}
const EMBED_KINDS = { document: "document", spreadsheet: "spreadsheets", presentation: "presentation", form: "forms", drawing: "drawings", folder: "folder" };
function embedLabel(label = "") {
  const match = label.match(/^Open\s+(\w+)?,?\s*(.*?)\s+in new window$/i);
  if (!match) return { title: label, kind: "" };
  return { title: match[2].trim(), kind: EMBED_KINDS[(match[1] || "").toLowerCase()] || "" };
}
function unescapeUrls(text) {
  return decodeEntities(text)
    .replace(/\\u003d/gi, "=").replace(/\\u0026/gi, "&").replace(/\\\//g, "/")
    .replace(/%3A/gi, ":").replace(/%2F/gi, "/").replace(/%3F/gi, "?").replace(/%3D/gi, "=").replace(/%26/gi, "&").replace(/%23/gi, "#");
}
function parseFileUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const path = url.pathname.replace(/\/u\/\d+\//, "/");
  const gid = (url.hash.match(/gid=(\d+)/) || url.search.match(/gid=(\d+)/) || [])[1] || "";
  if (url.hostname === "docs.google.com") {
    const doc = path.match(/^\/(document|spreadsheets|presentation|forms|drawings)\/d\/(e\/)?([A-Za-z0-9_-]{20,})/);
    if (doc) return { kind: doc[1], id: doc[3], pub: Boolean(doc[2]), gid };
    const open = url.searchParams.get("id");
    if (path === "/open" && open) return { kind: "file", id: open };
  }
  if (url.hostname === "drive.google.com") {
    const file = path.match(/^\/file\/d\/([A-Za-z0-9_-]{20,})/);
    if (file) return { kind: "file", id: file[1] };
    const folder = path.match(/^\/drive\/folders\/([A-Za-z0-9_-]{20,})/);
    if (folder) return { kind: "folder", id: folder[1] };
    const open = url.searchParams.get("id");
    if ((path === "/open" || path === "/uc" || path === "/embeddedfolderview") && open) return { kind: path === "/embeddedfolderview" ? "folder" : "file", id: open };
  }
  return null;
}
const refKey = (ref) => `${ref.kind}:${ref.pub ? "e/" : ""}${ref.id}`;

/* ───────── Files ───────── */
function fileParams(url) {
  const id = url.searchParams.get("id") || "";
  const pub = url.searchParams.get("pub") === "1";
  if (!ID.test(id)) return null;
  return { id, pub };
}
const EDIT_URL = {
  document: (id, pub) => (pub ? `https://docs.google.com/document/d/e/${id}/pub` : `https://docs.google.com/document/d/${id}/edit`),
  spreadsheets: (id, pub) => (pub ? `https://docs.google.com/spreadsheets/d/e/${id}/pubhtml` : `https://docs.google.com/spreadsheets/d/${id}/edit`),
  presentation: (id, pub) => (pub ? `https://docs.google.com/presentation/d/e/${id}/pub` : `https://docs.google.com/presentation/d/${id}/edit`),
  forms: (id, pub) => (pub ? `https://docs.google.com/forms/d/e/${id}/viewform` : `https://docs.google.com/forms/d/${id}/viewform`),
  drawings: (id) => `https://docs.google.com/drawings/d/${id}/edit`,
  file: (id) => `https://drive.google.com/file/d/${id}/view`,
  folder: (id) => `https://drive.google.com/drive/folders/${id}`
};

async function docResponse(env, url) {
  const params = fileParams(url);
  if (!params) return json({ ok: false, error: "Invalid document id" }, 400, 0);
  const result = await remember(`doc:${params.pub}:${params.id}`, DOC_TTL, async () => {
    const source = params.pub ? `https://docs.google.com/document/d/e/${params.id}/pub` : `https://docs.google.com/document/d/${params.id}/export?format=html`;
    const response = await readText(env, source, DOC_TTL);
    if (response.status !== "ok") return { ok: false, status: response.status };
    const html = response.text.replace(/<script\b[\s\S]*?<\/script>/gi, "");
    return { ok: true, title: cleanLabel(titleOf(html).replace(/\s-\sGoogle Docs$/, "")), html };
  });
  return json({ ...result, id: params.id, pub: params.pub, source: EDIT_URL.document(params.id, params.pub) }, result.ok ? 200 : result.status === "missing" ? 404 : 403, result.ok ? 120 : 30);
}

async function sheetResponse(env, url) {
  const params = fileParams(url);
  if (!params) return json({ ok: false, error: "Invalid sheet id" }, 400, 0);
  const gid = /^\d{1,12}$/.test(url.searchParams.get("gid") || "") ? url.searchParams.get("gid") : "";
  const csv = url.searchParams.get("format") === "csv";
  const result = await remember(`sheet:${params.pub}:${params.id}:${gid}:${csv}`, DOC_TTL, async () => {
    const base = params.pub ? `https://docs.google.com/spreadsheets/d/e/${params.id}` : `https://docs.google.com/spreadsheets/d/${params.id}`;
    const source = csv
      ? (params.pub ? `${base}/pub?output=csv${gid ? `&gid=${gid}` : ""}` : `${base}/export?format=csv${gid ? `&gid=${gid}` : ""}`)
      : (params.pub ? `${base}/pubhtml` : `${base}/htmlview`);
    const response = await readText(env, source, DOC_TTL);
    if (response.status !== "ok") return { ok: false, status: response.status };
    if (csv) return { ok: true, csv: response.text.slice(0, 2_000_000) };
    const html = response.text.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "");
    return { ok: true, title: cleanLabel(titleOf(response.text).replace(/\s-\sGoogle (Sheets|Drive)$/, "")), html: html.slice(0, 3_000_000) };
  });
  return json({ ...result, id: params.id, pub: params.pub, source: EDIT_URL.spreadsheets(params.id, params.pub) }, result.ok ? 200 : result.status === "missing" ? 404 : 403, result.ok ? 120 : 30);
}

async function titleResponse(env, url) {
  const params = fileParams(url);
  const kind = url.searchParams.get("kind") || "";
  if (!params || !KINDS.includes(kind)) return json({ ok: false, error: "Invalid file reference" }, 400, 0);
  const title = await remember(`title:${kind}:${params.pub}:${params.id}`, 3600, () => fileTitle(env, { kind, ...params }).catch(() => ""));
  return json({ ok: Boolean(title), title }, 200, title ? 3600 : 60);
}

/* Reads only as far as </title> of the file's public page, then hangs up. */
async function fileTitle(env, ref) {
  const target = EDIT_URL[ref.kind]?.(ref.id, ref.pub);
  if (!target) return "";
  const response = await google(env, target, 3600);
  if (!response.ok || isSignIn(response) || !response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let head = "";
  while (head.length < 200_000) {
    const { value, done } = await reader.read();
    if (done) break;
    head += decoder.decode(value, { stream: true });
    if (/<\/title>/i.test(head)) break;
  }
  reader.cancel().catch(() => {});
  return cleanLabel(titleOf(head).replace(/\s-\sGoogle (Docs|Sheets|Slides|Forms|Drawings|Drive)$/, "").replace(/^Google (Drive|Docs)$/, ""));
}

const IMAGE_HOSTS = /(^|\.)(googleusercontent\.com|ggpht\.com)$/;
async function imageResponse(env, url) {
  let target;
  const thumb = url.searchParams.get("thumb");
  if (thumb) {
    if (!ID.test(thumb)) return new Response("Bad image reference", { status: 400 });
    target = `https://drive.google.com/thumbnail?id=${thumb}&sz=w800`;
  } else {
    try { target = new URL(url.searchParams.get("u") || ""); } catch { return new Response("Bad image reference", { status: 400 }); }
    const drawing = target.hostname === "docs.google.com" && /^\/drawings\/d\/[A-Za-z0-9_-]{20,}\/(export\/png|image)/.test(target.pathname);
    // Google Sites serves its own uploads (banners, logos) from sites.google.com, same-site only.
    const siteImage = target.hostname === "sites.google.com" && /^\/sitesv-images[\w-]*\//.test(target.pathname);
    if (target.protocol !== "https:" || !(IMAGE_HOSTS.test(target.hostname) || drawing || siteImage)) return new Response("Image host not allowed", { status: 403 });
    target = target.href;
  }
  if (new URL(target).hostname === "sites.google.com" && !siteCookie) await readPage(env, SITE_HOME).catch(() => {});
  let media = await google(env, target, 86400);
  // An old cookie (or none yet) is refused; load a page for a fresh one and try once more.
  if (media.status === 403 && new URL(target).hostname === "sites.google.com") {
    siteCookie = "";
    await google(env, `${SITE_ORIGIN}${SITE_HOME}`, 0).catch(() => {});
    media = await google(env, target, 86400);
  }
  const type = media.headers.get("content-type") || "";
  if (!media.ok || !type.toLowerCase().startsWith("image/")) return new Response("Image unavailable", { status: 404 });
  return new Response(media.body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=86400, s-maxage=604800",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
