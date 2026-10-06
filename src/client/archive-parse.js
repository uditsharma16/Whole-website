/* TSO Central Archives — content interpreters
 *
 * Google writes HTML for its own editors, not for a website, so nothing from Google is ever
 * placed on the page as-is. Each source is read with DOMParser (inert: nothing in it runs or
 * loads) and rebuilt from scratch as a small, fixed vocabulary of escaped HTML:
 *
 *   sitePage()   a published Google Sites page → headings, text, lists, images, buttons, tables
 *                and cards for every embedded or linked Google file;
 *   googleDoc()  a Google Docs HTML export (or "Publish to web" page) → prose with real
 *                headings, nested lists, callouts, tables, images and footnotes; editor
 *                comments are dropped;
 *   sheet()      a Google Sheets HTML view → one table per tab; csv() is the fallback.
 *
 * Links to other pages of the site and to Google files are rewritten to this archive's own
 * routes, so the whole site, documents included, reads as one place. */
(function () {
  const SITE_PREFIX = "/view/tso-central-archives";
  const KIND_ROUTE = { document: "doc", spreadsheets: "sheet", presentation: "slides", forms: "form", drawings: "drawing", file: "file", folder: "folder" };
  const ROUTE_KIND = Object.fromEntries(Object.entries(KIND_ROUTE).map(([kind, route]) => [route, kind]));

  const esc = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  const clean = (value = "") => String(value).replace(/[​-‍﻿]/g, "").replace(/ /g, " ");
  const squash = (value = "") => clean(value).replace(/\s+/g, " ").trim();
  function slug(value = "") {
    return value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "section";
  }
  const parse = (html) => new DOMParser().parseFromString(html, "text/html");

  /* ───────── Links ───────── */
  function unwrap(href = "") {
    try {
      const url = new URL(href, "https://sites.google.com");
      if (/(^|\.)google\.com$/.test(url.hostname) && url.pathname === "/url") return url.searchParams.get("q") || url.searchParams.get("url") || href;
    } catch {}
    return href;
  }
  function fileRef(href = "") {
    let url;
    try { url = new URL(href); } catch { return null; }
    const path = url.pathname.replace(/\/u\/\d+\//, "/");
    const gid = (url.hash.match(/gid=(\d+)/) || url.search.match(/gid=(\d+)/) || [])[1] || "";
    if (url.hostname === "docs.google.com") {
      const doc = path.match(/^\/(document|spreadsheets|presentation|forms|drawings)\/d\/(e\/)?([A-Za-z0-9_-]{20,})/);
      if (doc) return { kind: doc[1], id: doc[3], pub: Boolean(doc[2]), gid };
      if (path === "/open" && url.searchParams.get("id")) return { kind: "file", id: url.searchParams.get("id"), pub: false };
    }
    if (url.hostname === "drive.google.com") {
      const file = path.match(/^\/file\/d\/([A-Za-z0-9_-]{20,})/);
      if (file) return { kind: "file", id: file[1], pub: false };
      const folder = path.match(/^\/drive\/folders\/([A-Za-z0-9_-]{20,})/);
      if (folder) return { kind: "folder", id: folder[1], pub: false };
      const open = url.searchParams.get("id");
      if (open && /^\/(open|uc)$/.test(path)) return { kind: "file", id: open, pub: false };
      if (open && path === "/embeddedfolderview") return { kind: "folder", id: open, pub: false };
    }
    return null;
  }
  /* Embeds are labelled for screen readers as "Open Document, <title> in new window" or
   * "Google Docs, <title>"; keep the title, and the kind it names. */
  const EMBED_KINDS = { document: "document", docs: "document", spreadsheet: "spreadsheets", sheets: "spreadsheets", presentation: "presentation", slides: "presentation", form: "forms", forms: "forms", drawing: "drawings", folder: "folder" };
  function embedLabel(label = "") {
    const open = label.match(/^Open\s+(\w+)?,?\s*(.*?)\s+in new window$/i);
    if (open) return { title: open[2].trim(), kind: EMBED_KINDS[(open[1] || "").toLowerCase()] || "" };
    const app = label.match(/^Google (Docs|Sheets|Slides|Forms|Drive|Drawings)\s*[,:-]\s*(.*)$/i);
    if (app) return { title: app[2].trim(), kind: EMBED_KINDS[app[1].toLowerCase()] || "" };
    return { title: label, kind: "" };
  }
  const fileKey = (ref) => `${ref.kind}:${ref.pub ? "e/" : ""}${ref.id}`;
  const fileRoute = (ref) => `/${KIND_ROUTE[ref.kind] || "file"}/${ref.pub ? "e/" : ""}${ref.id}${ref.gid ? `?gid=${ref.gid}` : ""}`;
  function sitePageRoute(href) {
    let url;
    try { url = new URL(href, "https://sites.google.com"); } catch { return null; }
    if (url.hostname !== "sites.google.com") return null;
    const path = url.pathname.replace(/\/+$/, "");
    if (path === SITE_PREFIX || path === `${SITE_PREFIX}/home`) return "/";
    if (!path.startsWith(`${SITE_PREFIX}/`)) return null;
    return `/p/${path.slice(SITE_PREFIX.length + 1)}${url.hash || ""}`;
  }
  /* → { href, internal, file? } for any link found in Google content. */
  function resolveLink(raw = "") {
    const href = unwrap(raw.trim());
    if (!href) return null;
    if (href.startsWith("#")) return { href, internal: false, anchor: true };
    const page = sitePageRoute(href);
    if (page) return { href: page, internal: true };
    const ref = fileRef(href);
    if (ref) return { href: fileRoute(ref), internal: true, file: ref };
    try {
      const url = new URL(href);
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
      return { href: url.href, internal: false };
    } catch { return null; }
  }
  function linkHtml(raw, inner, extraClass = "") {
    const link = resolveLink(raw);
    if (!link) return inner;
    if (link.anchor) return `<a href="${esc(link.href)}" data-scroll${extraClass ? ` class="${extraClass}"` : ""}>${inner}</a>`;
    if (link.internal) return `<a href="${esc(link.href)}" data-link${link.file ? ` data-file="${esc(fileKey(link.file))}"` : ""}${extraClass ? ` class="${extraClass}"` : ""}>${inner}</a>`;
    return `<a href="${esc(link.href)}" target="_blank" rel="noopener"${extraClass ? ` class="${extraClass}"` : ""}>${inner}<span class="ext" aria-hidden="true">↗</span></a>`;
  }
  /* Images go through the Worker's allowlisted image proxy. */
  function imageSrc(raw = "") {
    // Docs exports carry their images inline; raster data URIs are inert inside <img>.
    if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(raw)) return raw;
    try {
      const url = new URL(raw, "https://sites.google.com");
      if (url.protocol === "data:") return "";
      if (/(^|\.)(googleusercontent\.com|ggpht\.com)$/.test(url.hostname) || (url.hostname === "docs.google.com" && url.pathname.startsWith("/drawings/")) || (url.hostname === "sites.google.com" && /^\/sitesv-images[\w-]*\//.test(url.pathname))) return `/api/img?u=${encodeURIComponent(url.href)}`;
      if (url.protocol === "https:") return url.href;
    } catch {}
    return "";
  }

  /* ───────── Google Sites page ───────── */
  const BOLD = /font-weight:\s*(bold|[6-9]00)/i;
  const ITALIC = /font-style:\s*italic/i;
  const UNDERLINE = /text-decoration[^;]*underline/i;
  const STRIKE = /text-decoration[^;]*line-through/i;

  function siteInline(node) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { out += esc(clean(child.textContent)); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === "br") { out += "<br>"; continue; }
      if (["script", "style", "svg", "button", "iframe", "img"].includes(tag)) continue;
      let inner = siteInline(child);
      if (!inner.trim()) { out += inner; continue; }
      const style = child.getAttribute("style") || "";
      if (tag === "a") { out += linkHtml(child.getAttribute("href") || "", inner); continue; }
      if (tag === "b" || tag === "strong" || BOLD.test(style)) inner = `<strong>${inner}</strong>`;
      if (tag === "i" || tag === "em" || ITALIC.test(style)) inner = `<em>${inner}</em>`;
      if (tag === "u" || (UNDERLINE.test(style) && !child.closest("a"))) inner = `<u>${inner}</u>`;
      if (tag === "s" || tag === "strike" || STRIKE.test(style)) inner = `<s>${inner}</s>`;
      if (tag === "sup" || tag === "sub") inner = `<${tag}>${inner}</${tag}>`;
      if (tag === "code") inner = `<code>${inner}</code>`;
      out += inner;
    }
    return out;
  }
  // aria-hidden is not treated as hidden: Sites puts it on collapsed text groups whose content is real.
  const isHidden = (el) => /display:\s*none|visibility:\s*hidden/i.test(el.getAttribute("style") || "") || el.hasAttribute("hidden");
  const backgroundImage = (el) => ((el.getAttribute("style") || "").match(/background-image:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i) || [])[1] || "";

  function sitePage(html, options = {}) {
    const doc = parse(`<!doctype html><body>${html}</body>`);
    const blocks = [];
    const seenFiles = new Set();
    let banner = "";
    const push = (block) => {
      const last = blocks[blocks.length - 1];
      if (last && block.html && last.html === block.html) return; // Sites renders some tiles twice for mobile
      blocks.push(block);
    };
    const fileBlock = (ref, label) => {
      const key = fileKey(ref);
      if (seenFiles.has(key)) return;
      seenFiles.add(key);
      push({ type: "file", key, ref, label: embedLabel(squash(label)).title });
    };
    let stray = "";
    const flushStray = () => { const text = squash(stray); if (text.length > 1) push({ type: "p", html: esc(text), text }); stray = ""; };

    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { if (child.textContent.trim()) stray += ` ${child.textContent}`; continue; }
        if (child.nodeType !== 1) continue;
        const el = child;
        const tag = el.tagName.toLowerCase();
        if (["script", "style", "noscript", "svg", "nav", "template", "button", "input", "select", "textarea", "form", "header"].includes(tag) && !(tag === "header" && el.closest("[role=main]"))) continue;
        if (isHidden(el) || (el.getAttribute("role") === "button" && tag !== "a" && !el.querySelector("a[href]"))) continue;
        const bg = backgroundImage(el);
        if (bg && !banner) banner = imageSrc(bg);
        const embedUrl = el.getAttribute("data-embed-open-url") || el.getAttribute("data-embed-download-url") || "";
        const embedId = el.getAttribute("data-embed-doc-id") || "";
        if (embedUrl || embedId) {
          flushStray();
          const ref = fileRef(embedUrl) || (embedId ? { kind: "file", id: embedId, pub: false } : null);
          const frame = el.querySelector("iframe[aria-label], iframe[title]");
          const opener = el.querySelector("a[aria-label], a[title]");
          // Prefer the preview's own address (it names the kind: Docs, Sheets…) over the generic Drive link.
          const preview = fileRef(el.querySelector("iframe")?.getAttribute("src") || el.querySelector("iframe")?.getAttribute("data-src") || "");
          const label = el.getAttribute("aria-label") || el.getAttribute("data-embed-title") || frame?.getAttribute("aria-label") || frame?.getAttribute("title") || opener?.getAttribute("aria-label") || opener?.getAttribute("title") || "";
          const named = embedLabel(label);
          const chosen = preview && preview.id === ref?.id ? preview : ref && ref.kind === "file" && named.kind ? { ...ref, kind: named.kind } : ref;
          if (chosen) { fileBlock(chosen, named.title); continue; }
        }
        if (/^h[1-6]$/.test(tag)) {
          flushStray();
          const text = squash(el.textContent);
          if (text) push({ type: "h", level: Math.min(4, Math.max(2, Number(tag[1]) + 1)), html: siteInline(el).trim(), text, id: slug(text) });
          continue;
        }
        if (tag === "p" || tag === "blockquote") {
          flushStray();
          const text = squash(el.textContent);
          if (text) push({ type: tag === "p" ? "p" : "quote", html: siteInline(el).trim(), text, align: /text-align:\s*center/i.test(el.getAttribute("style") || "") ? "center" : "" });
          el.querySelectorAll("img").forEach((img) => imageBlock(img));
          continue;
        }
        if (tag === "ul" || tag === "ol") {
          flushStray();
          const html = listHtml(el);
          if (html) push({ type: "list", html, text: squash(el.textContent) });
          continue;
        }
        if (tag === "table") {
          flushStray();
          const rows = [...el.rows].map((row) => [...row.cells].map((cell) => siteInline(cell).trim()));
          if (rows.some((row) => row.some(Boolean))) push({ type: "table", html: tableHtml(rows), text: squash(el.textContent) });
          continue;
        }
        if (tag === "hr") { flushStray(); push({ type: "rule" }); continue; }
        if (tag === "img") { flushStray(); imageBlock(el); continue; }
        if (tag === "iframe") {
          flushStray();
          const src = el.getAttribute("src") || el.getAttribute("data-src") || "";
          const ref = fileRef(src);
          if (ref) fileBlock(ref, el.getAttribute("title") || el.getAttribute("aria-label") || "");
          else {
            const video = (src.match(/(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{6,20})/) || [])[1];
            if (video) push({ type: "video", id: video });
          }
          continue;
        }
        if (tag === "a") {
          flushStray();
          const href = el.getAttribute("href") || "";
          const link = resolveLink(href);
          const label = squash(el.textContent) || squash(el.getAttribute("aria-label") || "");
          if (link?.file) { fileBlock(link.file, label); continue; }
          if (link && label) push({ type: "button", html: linkHtml(href, esc(label), "btn"), text: label });
          el.querySelectorAll("img").forEach((img) => imageBlock(img));
          continue;
        }
        walk(el);
        if (/^(div|section|li|td)$/.test(tag)) flushStray();
      }
    };
    const imageBlock = (img) => {
      const src = imageSrc(img.getAttribute("src") || img.getAttribute("data-src") || "");
      const width = Number(img.getAttribute("width")) || 0;
      if (!src || (width && width < 48)) return;
      push({ type: "img", src, alt: squash(img.getAttribute("alt") || ""), html: src });
    };
    walk(doc.body);
    flushStray();
    // Google's own page chrome, in case any of it is inside the content region.
    for (let i = blocks.length - 1; i >= 0; i -= 1) if (/^(report abuse|page details|page updated\b.*|google sites|skip to (main content|navigation)|search this site|embedded files?)$/i.test(blocks[i].text || "")) blocks.splice(i, 1);

    // The page header repeats the page's own title; the archive shows its own heading instead.
    const names = [options.title, options.siteName].map((name) => squash(name || "").toLowerCase()).filter(Boolean);
    const first = blocks.findIndex((block) => block.type === "h");
    if (first >= 0 && first < 3 && names.includes(blocks[first].text.toLowerCase())) blocks.splice(first, 1);

    return { blocks, banner, text: blocks.map((block) => block.text || block.label || "").join(" ").replace(/\s+/g, " ").trim(), headings: blocks.filter((block) => block.type === "h" && block.level <= 3) };
  }
  function listHtml(list) {
    const tag = list.tagName.toLowerCase() === "ol" ? "ol" : "ul";
    const items = [...list.children].filter((child) => child.tagName === "LI").map((li) => {
      const nested = [...li.children].filter((child) => /^(UL|OL)$/.test(child.tagName));
      nested.forEach((child) => child.remove());
      const body = siteInline(li).trim();
      return body || nested.length ? `<li>${body}${nested.map(listHtml).join("")}</li>` : "";
    }).join("");
    return items ? `<${tag}>${items}</${tag}>` : "";
  }
  function tableHtml(rows) {
    const width = Math.max(...rows.map((row) => row.length));
    const [head, ...body] = rows;
    const cells = (row, cell) => Array.from({ length: width }, (_, i) => `<${cell}>${row[i] || ""}</${cell}>`).join("");
    return `<div class="table-wrap"><table><thead><tr>${cells(head, "th")}</tr></thead><tbody>${body.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody></table></div>`;
  }

  /* ───────── Google Doc ───────── */
  function classStyles(doc) {
    const css = [...doc.querySelectorAll("style")].map((style) => style.textContent).join("\n");
    const map = new Map();
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    while ((match = rule.exec(css))) {
      for (const selector of match[1].split(",")) {
        const name = selector.trim().match(/^(?:[a-z0-9]+)?\.([\w-]+)$/i);
        if (name) map.set(name[1], (map.get(name[1]) || "") + ";" + match[2]);
      }
    }
    return map;
  }
  function styleOf(el, classes) {
    let style = "";
    for (const name of el.classList) style += classes.get(name) || "";
    return style + ";" + (el.getAttribute("style") || "");
  }
  const fontSize = (style) => { const all = [...style.matchAll(/font-size:\s*([\d.]+)pt/gi)]; return all.length ? Number(all[all.length - 1][1]) : 0; };
  const lastValue = (style, prop) => { const all = [...style.matchAll(new RegExp(`${prop}:\\s*([^;]+)`, "gi"))]; return all.length ? all[all.length - 1][1].trim().toLowerCase() : ""; };

  function googleDoc(html) {
    const doc = parse(html);
    const classes = classStyles(doc);
    const root = doc.querySelector("#contents") || doc.body;
    root.querySelectorAll("style, script, #header, #footer, #banners").forEach((el) => el.remove());

    // Editor comments come along with an export; they are working notes, not the document.
    root.querySelectorAll('a[id^="cmnt"]:not([id^="cmnt_ref"])').forEach((a) => (a.closest("div") || a.closest("p") || a).remove());
    root.querySelectorAll('a[href^="#cmnt"]').forEach((a) => (a.closest("sup") || a).remove());

    const title = squash(doc.querySelector("title")?.textContent || "").replace(/\s-\sGoogle Docs$/, "");
    const sizes = new Map();
    root.querySelectorAll("p span").forEach((span) => {
      const size = fontSize(styleOf(span, classes)) || 11;
      const length = span.textContent.trim().length;
      if (length) sizes.set(size, (sizes.get(size) || 0) + length);
    });
    const baseSize = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 11;
    const realHeadings = root.querySelectorAll("h1, h2, h3, h4").length;
    const headings = [];
    const usedIds = new Set();
    const uniqueId = (wanted) => { let id = wanted || "section"; let n = 2; while (usedIds.has(id)) id = `${wanted}-${n++}`; usedIds.add(id); return id; };
    let docTitle = "", subtitle = "";
    let wordCount = 0;
    const textParts = [];

    const inline = (node) => {
      let out = "";
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { out += esc(clean(child.textContent)); continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toLowerCase();
        if (tag === "br") { out += "<br>"; continue; }
        if (tag === "img") { out += docImage(child); continue; }
        if (["script", "style", "svg", "iframe", "object"].includes(tag)) continue;
        const style = styleOf(child, classes);
        let inner = inline(child);
        if (tag === "a") {
          const href = child.getAttribute("href");
          const id = child.getAttribute("id");
          const anchor = id && /^(ftnt|ftnt_ref|id\.|kix\.|h\.)/.test(id) ? `<span id="${esc(id)}"></span>` : "";
          out += anchor + (href ? linkHtml(href, inner, /^#ftnt/.test(href) ? "footnote-ref" : "") : inner);
          continue;
        }
        if (!inner.replace(/<br>/g, "").trim()) { out += inner; continue; }
        const weight = lastValue(style, "font-weight");
        if (tag === "b" || tag === "strong" || weight === "bold" || Number(weight) >= 600) inner = `<strong>${inner}</strong>`;
        if (tag === "i" || tag === "em" || lastValue(style, "font-style") === "italic") inner = `<em>${inner}</em>`;
        const decoration = lastValue(style, "text-decoration");
        if (decoration.includes("line-through")) inner = `<s>${inner}</s>`;
        if (decoration.includes("underline") && !child.closest("a") && !child.querySelector("a")) inner = `<u>${inner}</u>`;
        const valign = lastValue(style, "vertical-align");
        if (tag === "sup" || valign === "super") inner = `<sup>${inner}</sup>`;
        if (tag === "sub" || valign === "sub") inner = `<sub>${inner}</sub>`;
        const highlight = lastValue(style, "background-color");
        if (highlight && !/^(#fff(fff)?|transparent|white|initial|inherit|none)$/.test(highlight)) inner = `<mark>${inner}</mark>`;
        out += inner;
      }
      return out;
    };
    const docImage = (img) => {
      const src = imageSrc(img.getAttribute("src") || "");
      if (!src) return "";
      const box = img.closest("span") || img;
      const width = parseFloat((box.getAttribute("style") || "").match(/width:\s*([\d.]+)px/)?.[1] || img.getAttribute("width") || "0");
      const height = parseFloat((box.getAttribute("style") || "").match(/height:\s*([\d.]+)px/)?.[1] || img.getAttribute("height") || "0");
      const alt = squash(img.getAttribute("alt") || img.getAttribute("title") || "");
      if (width && width < 42) return `<img class="inline-img" src="${esc(src)}" alt="${esc(alt)}" loading="lazy" style="width:${Math.round(width)}px" />`;
      const ratio = width && height ? ` style="aspect-ratio:${(width / height).toFixed(4)};max-width:${Math.round(Math.max(width, 120))}px"` : "";
      return `\u0001<figure class="doc-figure"><button data-zoom="${esc(src)}" aria-label="Enlarge image"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"${ratio} /></button></figure>\u0001`;
    };
    // Figures can't live inside <p>; split them out of a paragraph's inline HTML.
    const paragraphs = (html, attrs = "") => html.split("\u0001").map((part, index) => (index % 2 ? part : part.replace(/^(\s|<br>)+|(\s|<br>)+$/g, "") ? `<p${attrs}>${part.replace(/^(\s|<br>)+|(\s|<br>)+$/g, "")}</p>` : "")).join("");
    const alignOf = (el) => {
      const align = lastValue(styleOf(el, classes), "text-align");
      return align === "center" ? ' class="center"' : align === "right" ? ' class="right"' : "";
    };
    const countText = (text) => { if (text) { textParts.push(text); wordCount += text.split(/\s+/).filter(Boolean).length; } };

    const heading = (level, html, text, sourceId) => {
      const id = uniqueId(slug(text));
      if (level <= 3) headings.push({ level, text, id });
      return `<h${level} id="${esc(id)}">${sourceId ? `<span id="${esc(sourceId)}"></span>` : ""}${html}</h${level}>`;
    };
    const promoted = (p, text) => {
      if (realHeadings >= 3 || text.length > 90 || text.length < 3) return 0;
      const spans = [...p.querySelectorAll("span")].filter((span) => span.textContent.trim());
      if (!spans.length || p.querySelector("img, a")) return 0;
      const allBold = spans.every((span) => { const weight = lastValue(styleOf(span, classes), "font-weight"); return weight === "bold" || Number(weight) >= 600; });
      const size = Math.max(...spans.map((span) => fontSize(styleOf(span, classes)) || baseSize));
      if (size >= baseSize + 5) return 2;
      if (allBold && (size >= baseSize + 2 || (text === text.toUpperCase() && /[A-Z]/.test(text)))) return 3;
      return 0;
    };

    const block = (el) => {
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const text = squash(el.textContent);
        if (!text) return el.querySelector("img") ? paragraphs(inline(el)) : "";
        countText(text);
        return heading(Math.min(4, Number(tag[1]) + 1), inline(el).replace(/\u0001/g, ""), text, el.getAttribute("id"));
      }
      if (tag === "p") {
        const text = squash(el.textContent);
        const hasImage = el.querySelector("img");
        if (!text && !hasImage) return "";
        if (el.classList.contains("title") && text && !docTitle) { docTitle = text; countText(text); return ""; }
        if (el.classList.contains("subtitle") && text && !subtitle) { subtitle = text; countText(text); return `<p class="doc-subtitle">${inline(el).replace(/\u0001/g, "")}</p>`; }
        countText(text);
        const level = text && !hasImage ? promoted(el, text) : 0;
        if (level) return heading(level, esc(text), text);
        return paragraphs(inline(el), alignOf(el));
      }
      if (tag === "table") return table(el);
      if (tag === "hr") return /display:\s*none|page-break/i.test(el.getAttribute("style") || "") ? "" : "<hr>";
      if (tag === "div") return [...el.children].map(block).join("");
      if (tag === "ul" || tag === "ol") return "";
      return paragraphs(inline(el));
    };

    /* Docs exports every list level as its own flat <ul>/<ol class="lst-kix_…-N">;
     * consecutive ones are stitched back into real nested lists. */
    const listLevel = (list) => Number(([...list.classList].map((name) => name.match(/^lst-kix_[\w]+-(\d+)$/)).find(Boolean) || [])[1] || 0);
    const lists = (group) => {
      const root = { level: -1, items: [] };
      const stack = [root];
      for (const list of group) {
        const level = listLevel(list);
        const ordered = list.tagName === "OL";
        for (const li of list.children) {
          if (li.tagName !== "LI") continue;
          while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
          const parent = stack[stack.length - 1];
          const host = parent === root ? root : parent.items[parent.items.length - 1] || parent;
          host.children ||= [];
          let current = host.children[host.children.length - 1];
          if (!current || current.level !== level || current.ordered !== ordered || current.closed) {
            current = { level, ordered, items: [], start: Number(list.getAttribute("start")) || 1 };
            host.children.push(current);
          }
          const text = squash(li.textContent);
          countText(text);
          current.items.push({ html: inline(li).replace(/\u0001/g, ""), children: [] });
          stack.push(current);
        }
      }
      const render = (node) => (node.children || []).map((list) => `<${list.ordered ? "ol" : "ul"}${list.ordered && list.start > 1 ? ` start="${list.start}"` : ""}>${list.items.map((item) => `<li>${item.html}${render(item)}</li>`).join("")}</${list.ordered ? "ol" : "ul"}>`).join("");
      return render(root);
    };

    /* A one-cell table is how Docs authors draw a box around text: it becomes a callout. */
    const table = (el) => {
      const rows = [...el.rows].filter((row) => row.cells.length);
      if (!rows.length) return "";
      const cellBody = (cell) => convert([...cell.children]) || inline(cell);
      if (rows.length === 1 && rows[0].cells.length === 1) {
        const body = cellBody(rows[0].cells[0]);
        return body.trim() ? `<aside class="callout">${body}</aside>` : "";
      }
      const width = Math.max(...rows.map((row) => [...row.cells].reduce((sum, cell) => sum + (Number(cell.getAttribute("colspan")) || 1), 0)));
      const firstRowBold = [...rows[0].cells].every((cell) => !squash(cell.textContent) || cell.querySelector("span") && [...cell.querySelectorAll("span")].filter((span) => span.textContent.trim()).every((span) => { const weight = lastValue(styleOf(span, classes), "font-weight"); return weight === "bold" || Number(weight) >= 600; }));
      const renderRow = (row, cellTag) => `<tr>${[...row.cells].map((cell) => {
        const span = Number(cell.getAttribute("colspan")) || 1;
        const rowSpan = Number(cell.getAttribute("rowspan")) || 1;
        return `<${cellTag}${span > 1 ? ` colspan="${span}"` : ""}${rowSpan > 1 ? ` rowspan="${rowSpan}"` : ""}>${cellBody(cell)}</${cellTag}>`;
      }).join("")}</tr>`;
      const head = firstRowBold && rows.length > 1 ? `<thead>${renderRow(rows[0], "th")}</thead>` : "";
      const body = (head ? rows.slice(1) : rows).map((row) => renderRow(row, "td")).join("");
      return `<div class="table-wrap${width > 4 ? " wide" : ""}"><table>${head}<tbody>${body}</tbody></table></div>`;
    };

    const convert = (nodes) => {
      let out = "";
      let group = [];
      const flush = () => { if (group.length) { out += lists(group); group = []; } };
      for (const el of nodes) {
        if (el.tagName === "UL" || el.tagName === "OL") { group.push(el); continue; }
        // Docs repeats empty paragraphs between list chunks; they don't end the list.
        if (el.tagName === "P" && group.length && !squash(el.textContent) && !el.querySelector("img")) continue;
        flush();
        out += block(el);
      }
      flush();
      return out;
    };

    // Footnotes sit in trailing <div>s after a final <hr>; they get their own section.
    const children = [...root.children];
    const footnoteStart = children.findIndex((el) => el.tagName === "DIV" && el.querySelector('a[id^="ftnt"]:not([id^="ftnt_ref"])'));
    const main = footnoteStart >= 0 ? children.slice(0, footnoteStart) : children;
    let body = convert(main);
    if (footnoteStart >= 0) {
      const notes = children.slice(footnoteStart).filter((el) => el.tagName === "DIV").map((el) => {
        const text = inline(el.querySelector("p") || el).replace(/\u0001/g, "");
        return text.trim() ? `<li>${text}</li>` : "";
      }).join("");
      if (notes) body = body.replace(/(<hr>)+$/, "") + `<section class="footnotes" aria-label="Footnotes"><h4>Notes</h4><ol>${notes}</ol></section>`;
    }
    body = body.replace(/(<hr>)+$/, "").replace(/^(<hr>)+/, "");
    // A document that opens with its own name as a heading would repeat the page title.
    if (!docTitle && headings.length) {
      const lead = body.match(/^([\s\S]*?)<h([234]) id="([^"]+)">([\s\S]*?)<\/h\2>/);
      const name = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (lead && lead[3] === headings[0].id && lead[1].replace(/<[^>]+>/g, "").trim().length < 200 && name(headings[0].text).length > 3 && name(title).includes(name(headings[0].text))) {
        docTitle = headings[0].text.replace(/^([A-Z0-9\s|:&'-]+)$/, (all) => all.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()));
        body = lead[1] + body.slice(lead[0].length);
        headings.shift();
      }
    }
    return { title: docTitle || title, subtitle, html: body, headings, words: wordCount, text: textParts.join(" ").replace(/\s+/g, " ").trim() };
  }

  /* ───────── Google Sheet ───────── */
  function sheet(html) {
    const doc = parse(html);
    const names = new Map();
    doc.querySelectorAll('#sheet-menu li[id^="sheet-button-"], #sheet-menu li').forEach((li) => {
      const gid = (li.id || "").replace("sheet-button-", "");
      const label = squash(li.textContent);
      if (gid && label) names.set(gid, label);
    });
    const tabs = [];
    const containers = [...doc.querySelectorAll("#sheets-viewport > div[id]")];
    const tables = containers.length ? containers.map((div) => ({ gid: div.id, table: div.querySelector("table") })) : [...doc.querySelectorAll("table.waffle, table")].map((table, index) => ({ gid: String(index), table }));
    for (const { gid, table } of tables) {
      if (!table) continue;
      const rows = [];
      for (const row of table.querySelectorAll("tbody tr")) {
        const cells = [...row.children].filter((cell) => cell.tagName === "TD" && !cell.classList.contains("freezebar-cell")).map((cell) => {
          const links = [...cell.querySelectorAll("a[href]")];
          const text = squash(cell.textContent);
          return links.length === 1 && squash(links[0].textContent) === text ? { text, href: links[0].getAttribute("href") } : { text };
        });
        if (cells.length) rows.push(cells);
      }
      const trimmed = trimGrid(rows);
      if (trimmed.length) tabs.push({ gid, name: names.get(gid) || `Sheet ${tabs.length + 1}`, rows: trimmed });
    }
    return { title: squash(doc.querySelector("title")?.textContent || "").replace(/\s-\sGoogle (Sheets|Drive)$/, ""), tabs };
  }
  function trimGrid(rows) {
    const filled = rows.filter((row) => row.some((cell) => cell.text));
    if (!filled.length) return [];
    let width = 0;
    for (const row of filled) for (let i = row.length - 1; i >= 0; i -= 1) if (row[i].text) { width = Math.max(width, i + 1); break; }
    let first = width;
    for (const row of filled) { const index = row.findIndex((cell) => cell.text); if (index >= 0) first = Math.min(first, index); }
    return filled.map((row) => Array.from({ length: width - first }, (_, i) => row[first + i] || { text: "" }));
  }
  function csv(text = "") {
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
        else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") { row.push({ text: cell.trim() }); cell = ""; }
      else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[i + 1] === "\n") i += 1;
        row.push({ text: cell.trim() }); rows.push(row); row = []; cell = "";
      } else cell += char;
    }
    if (cell || row.length) { row.push({ text: cell.trim() }); rows.push(row); }
    return trimGrid(rows);
  }

  window.ArchiveParse = { sitePage, googleDoc, sheet, csv, resolveLink, fileRef, fileKey, fileRoute, KIND_ROUTE, ROUTE_KIND, slug, esc, imageSrc };
})();
