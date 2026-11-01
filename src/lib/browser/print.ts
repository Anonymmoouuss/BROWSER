"use client";

/**
 * Printing helpers.
 *
 * printHtml(): renders `html` in a hidden same-origin iframe and opens the
 * browser print dialog on exactly that document — this is how the reader
 * prints a clean article (no app chrome) and how internal pages print their
 * content. The iframe is marked with a data attribute and removed a moment
 * after the dialog closes (print() blocks in real browsers).
 *
 * printFrameWindow(): prints a live same-origin proxy frame directly (the
 * user sees the page exactly as rendered).
 */

const PRINT_IFRAME_FLAG = "data-cw-print-frame";

export function printHtml(html: string, title: string): boolean {
  // reuse any leftover frame from an aborted previous print
  document.querySelector(`iframe[${PRINT_IFRAME_FLAG}]`)?.remove();
  const frame = document.createElement("iframe");
  frame.setAttribute(PRINT_IFRAME_FLAG, "1");
  frame.setAttribute("aria-hidden", "true");
  frame.title = `Print preview: ${title}`;
  // must stay on-screen-ish for some engines to lay it out, but invisible
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    return false;
  }
  doc.open();
  doc.write(html);
  doc.close();
  const win = frame.contentWindow;
  if (!win) {
    frame.remove();
    return false;
  }
  // print once images/fonts have settled (best effort, short timeout)
  const go = () => {
    try {
      win.focus();
      win.print();
    } catch {
      /* printing refused — still remove the frame below */
    }
    setTimeout(() => frame.remove(), 1500);
  };
  if (doc.readyState === "complete") setTimeout(go, 80);
  else frame.addEventListener("load", () => setTimeout(go, 80), { once: true });
  return true;
}

/** Print a live same-origin frame (proxied web page) as rendered. */
export function printFrameWindow(win: (Window & typeof globalThis) | null): boolean {
  if (!win) return false;
  try {
    win.focus();
    win.print();
    return true;
  } catch {
    return false;
  }
}

/* ---------------- reader -> printable document ---------------- */

import type { ReaderDoc } from "@/lib/browser/reader";

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Serialize an extracted reader document into a clean, print-optimized HTML
 * document: article title + byline, the block list with print styles, and
 * page margins/rules that match Chrome's reader printing.
 */
export function readerToPrintableHtml(doc: ReaderDoc): string {
  const parts: string[] = [];
  let i = 0;
  while (i < doc.blocks.length) {
    const b = doc.blocks[i];
    if (b.type === "list-item") {
      const items: string[] = [];
      while (i < doc.blocks.length) {
        const li = doc.blocks[i];
        if (li.type !== "list-item") break;
        items.push(`<li>${escapeHtmlText(li.text)}</li>`);
        i++;
      }
      parts.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    switch (b.type) {
      case "heading":
        parts.push(`<h${b.level}>${escapeHtmlText(b.text)}</h${b.level}>`);
        break;
      case "paragraph":
        parts.push(`<p>${b.runs.map((r) => (r.href ? `<a href="${r.href}">${escapeHtmlText(r.text)}</a>` : escapeHtmlText(r.text))).join("")}</p>`);
        break;
      case "caption":
        parts.push(`<p class="caption">${escapeHtmlText(b.text)}</p>`);
        break;
      case "quote":
        parts.push(`<blockquote>${escapeHtmlText(b.text)}</blockquote>`);
        break;
      case "code":
        parts.push(`<pre>${escapeHtmlText(b.text)}</pre>`);
        break;
      case "image":
        parts.push(
          `<figure><img src="${b.src}" alt="${escapeHtmlText(b.alt)}" />${b.caption || b.alt ? `<figcaption>${escapeHtmlText(b.caption || b.alt)}</figcaption>` : ""}</figure>`,
        );
        break;
      case "rule":
        parts.push("<hr />");
        break;
    }
    i++;
  }
  const byline = [doc.byline, doc.published].filter(Boolean).join(" · ");
  return `<!doctype html>
<html><head><meta charset="utf-8" /><title>${escapeHtmlText(doc.title)}</title>
<style>
  @page { margin: 18mm 16mm; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Georgia, "Times New Roman", serif; color: #1a1a1a; line-height: 1.7; margin: 0; }
  header.article-head { border-bottom: 1px solid #d4d4d4; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { font-size: 26px; line-height: 1.25; margin: 0 0 8px; }
  .byline { color: #666; font-size: 13px; margin: 0; }
  .src { color: #888; font-size: 11px; margin: 4px 0 0; }
  h2, h3, h4 { line-height: 1.3; margin: 1.4em 0 0.5em; }
  h2 { font-size: 20px; } h3 { font-size: 17px; } h4 { font-size: 15px; }
  p { margin: 0.75em 0; }
  a { color: #065f46; text-decoration: none; }
  ul { margin: 0.75em 0; padding-left: 1.6em; }
  li { margin: 0.3em 0; }
  blockquote { margin: 1em 0 1em 0.8em; padding-left: 1em; border-left: 3px solid #10b981; color: #444; font-style: italic; }
  pre { background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 6px; padding: 10px 12px; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  figure { margin: 1.2em 0; text-align: center; page-break-inside: avoid; }
  figure img { max-width: 100%; }
  figcaption, p.caption { color: #777; font-size: 12px; font-style: italic; }
  hr { border: 0; border-top: 1px solid #d4d4d4; margin: 1.8em auto; width: 40%; }
</style></head>
<body>
<header class="article-head">
  <h1>${escapeHtmlText(doc.title)}</h1>
  ${byline ? `<p class="byline">${escapeHtmlText(byline)}</p>` : ""}
  <p class="src">${escapeHtmlText(doc.url)}</p>
</header>
<article>${parts.join("\n")}</article>
</body></html>`;
}
