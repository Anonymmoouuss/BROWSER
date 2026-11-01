"use client";

/**
 * Reader-mode extraction: readability-lite article extraction from a live
 * (same-origin, proxied) frame document.
 *
 * Scoring follows the classic Readability idea — every substantial paragraph
 * votes for its ancestors; the densest container wins. The winner is then
 * walked in document order, emitting structured blocks (headings, paragraphs
 * with inline link runs, list items, quotes, code, images, rules) that the
 * ReaderView renders in a clean typographic layout. Image srcs keep their RAW
 * external URL under Scramjet, so they are rewritten through the live frame's
 * interception prefix (same trick as the download interceptor).
 */

export type ReaderRun = { text: string; href?: string };

export type ReaderBlock =
  | { type: "heading"; level: 2 | 3 | 4; text: string }
  | { type: "paragraph"; runs: ReaderRun[] }
  | { type: "caption"; text: string }
  | { type: "list-item"; text: string }
  | { type: "quote"; text: string }
  | { type: "code"; text: string }
  | { type: "image"; src: string; alt: string; caption?: string }
  | { type: "rule" };

export interface ReaderDoc {
  url: string;
  title: string;
  byline: string | null;
  published: string | null;
  readingMinutes: number;
  words: number;
  blocks: ReaderBlock[];
}

const SKIP_WITHIN = "nav,header,footer,aside,noscript,script,style,button,select,form,svg";
const MAX_BLOCKS = 1500;

function textOf(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Paragraph that is mostly link text = navigation chrome, not content. */
function isNavJunk(el: Element): boolean {
  const total = textOf(el);
  if (total.length <= 200) return false;
  let linkText = 0;
  for (const a of el.querySelectorAll("a")) linkText += textOf(a).length;
  return linkText / total.length > 0.7;
}

function isProbablyIcon(img: HTMLImageElement): boolean {
  const haystack = `${img.className} ${img.id} ${img.src}`;
  return /(^|[^a-z])(icon|logo|badge|sprite|avatar|bullet|button|arrow)([^a-z]|$)/i.test(haystack);
}

/** Rewrite an img src into a URL the top window can actually load. */
function rewriteImgSrc(src: string, prefix: string | null): string | null {
  try {
    const u = new URL(src, window.location.origin);
    if (u.origin === window.location.origin) return u.href; // already proxied
    return prefix ? prefix + encodeURIComponent(u.href) : null; // raw external
  } catch {
    return null;
  }
}

/** Paragraph content as styled runs, keeping inline links alive. */
function collectRuns(el: Element, out: ReaderRun[] = []): ReaderRun[] {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.nodeValue ?? "").replace(/\s+/g, " ");
      if (t.trim()) out.push({ text: t });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const e = node as Element;
      if (e.tagName === "A") {
        const anchor = e as HTMLAnchorElement;
        const href = anchor.getAttribute("href");
        const t = textOf(e);
        if (t && href && !href.startsWith("javascript:")) out.push({ text: t, href: anchor.href });
        else if (t) out.push({ text: t });
      } else if (e.tagName === "BR") {
        out.push({ text: " " });
      } else if (e.tagName !== "IMG" && e.tagName !== "SVG") {
        collectRuns(e, out);
      }
    }
  }
  return out;
}

function mergeRuns(runs: ReaderRun[]): ReaderRun[] {
  const merged: ReaderRun[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && !last.href && !r.href) last.text += r.text;
    else merged.push({ ...r });
  }
  return merged;
}

/** Readability-style ancestor voting over substantial paragraphs. */
function pickCandidate(doc: Document): Element | null {
  const paras = Array.from(doc.querySelectorAll("p")).filter((p) => {
    if (!p.isConnected || p.closest(SKIP_WITHIN)) return false;
    if (p.parentElement?.closest("li, blockquote, pre")) return false;
    return textOf(p).length >= 25;
  });
  if (paras.length < 2) return null;
  const scores = new Map<Element, number>();
  for (const p of paras) {
    const len = textOf(p).length;
    let level = 0;
    let el: Element | null = p.parentElement;
    while (el && el !== doc.body && level < 5) {
      const tag = el.tagName;
      const bonus = tag === "ARTICLE" || tag === "MAIN" || tag === "SECTION" || tag === "TD" || tag === "DIV" ? 15 : 0;
      scores.set(el, (scores.get(el) ?? 0) + len + bonus);
      el = el.parentElement;
      level++;
    }
  }
  let best: Element | null = null;
  let bestScore = 0;
  for (const [el, s] of scores) {
    if (s > bestScore) {
      best = el;
      bestScore = s;
    }
  }
  return best;
}

export function extractReaderDoc(doc: Document, pageUrl: string, imgPrefix: string | null): ReaderDoc | null {
  if (!doc.body) return null;
  const candidate = pickCandidate(doc);
  if (!candidate) return null;

  const blocks: ReaderBlock[] = [];
  let textLen = 0;
  const push = (b: ReaderBlock, len: number) => {
    blocks.push(b);
    textLen += len;
  };

  const els = candidate.querySelectorAll("h2, h3, h4, p, li, blockquote, pre, img, hr, figcaption");
  for (const el of els) {
    if (blocks.length >= MAX_BLOCKS) break;
    if (!el.isConnected || el.closest(SKIP_WITHIN)) continue;
    const tag = el.tagName;

    if (tag === "P" || tag === "FIGCAPTION") {
      if (el.parentElement?.closest("li, blockquote, pre")) continue; // covered by their block
      const runs = mergeRuns(collectRuns(el, []).filter((r) => r.text.trim()));
      const joined = runs.map((r) => r.text).join("").trim();
      if (joined.length < 2 || isNavJunk(el)) continue;
      push(
        tag === "FIGCAPTION" ? { type: "caption", text: joined.slice(0, 400) } : { type: "paragraph", runs: runs.map((r) => ({ text: r.text.slice(0, 2000), href: r.href })) },
        joined.length,
      );
    } else if (tag === "LI") {
      if (el.querySelector("li")) continue; // emit leaves only, no duplicated nesting
      const t = textOf(el);
      if (!t) continue;
      push({ type: "list-item", text: t.slice(0, 2000) }, t.length);
    } else if (tag === "BLOCKQUOTE") {
      const t = textOf(el);
      if (t.length < 10) continue;
      push({ type: "quote", text: t.slice(0, 6000) }, t.length);
    } else if (tag === "PRE") {
      const t = (el.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
      if (!t) continue;
      push({ type: "code", text: t.slice(0, 8000) }, t.length);
    } else if (tag === "IMG") {
      const img = el as HTMLImageElement;
      if (!img.src || img.src.startsWith("data:")) continue;
      const w = img.naturalWidth || img.width || parseInt(img.getAttribute("width") ?? "", 10) || 0;
      if (w > 0 && w < 100) continue; // icons / tracking pixels
      if (isProbablyIcon(img)) continue;
      const src = rewriteImgSrc(img.src, imgPrefix);
      if (!src) continue;
      const fig = img.closest("figure");
      const cap = fig?.querySelector("figcaption");
      blocks.push({ type: "image", src, alt: img.alt || "", caption: cap ? textOf(cap).slice(0, 300) : undefined });
    } else if (tag === "HR") {
      blocks.push({ type: "rule" });
    } else {
      // h2–h4
      if (el.parentElement?.closest("blockquote, pre")) continue;
      const t = textOf(el);
      if (!t) continue;
      push({ type: "heading", level: tag === "H2" ? 2 : tag === "H3" ? 3 : 4, text: t.slice(0, 300) }, t.length);
    }
  }

  // not enough substance for a reading view
  if (blocks.length < 3 || textLen < 400) return null;

  const title = (() => {
    const h = candidate.querySelector("h1") ?? doc.querySelector("h1") ?? candidate.querySelector("h2");
    return (h ? textOf(h) : "") || (doc.title || "").trim() || "Article";
  })();

  const meta = (sel: string) => doc.querySelector(sel)?.getAttribute("content")?.trim() || null;
  let byline = meta('meta[name="author"]') ?? meta('meta[property="article:author"]');
  if (!byline) {
    const el = doc.querySelector(".byline, .by-line, [rel=author], .author");
    if (el && textOf(el).length <= 80 && !isNavJunk(el)) byline = textOf(el);
  }
  const published =
    meta('meta[property="article:published_time"]') ??
    meta('meta[name="date"]') ??
    doc.querySelector("time[datetime]")?.getAttribute("datetime") ??
    null;

  const words = Math.round((textLen + title.length) / 5.2); // ~5.2 chars per word
  return {
    url: pageUrl,
    title: title.slice(0, 300),
    byline: byline ? byline.slice(0, 120) : null,
    published,
    readingMinutes: Math.max(1, Math.round(words / 220)),
    words,
    blocks,
  };
}
