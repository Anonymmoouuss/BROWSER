/**
 * browser-backend -- mini-service (port 3030) for the "Browser + Console" app.
 *
 * 1) Web proxy:  GET/POST /api/proxy?XTransformPort=3030&url=<absolute http(s) url>
 *      - fetches server-side through a curl subprocess (Bun's own TLS
 *        fingerprint is blocked by Wikimedia and some CDNs; curl's is not)
 *      - strips CSP / X-Frame-Options so pages render inside our iframe
 *      - rewrites every subresource URL (href/src/srcset/style url()/@import,
 *        form actions) back through the proxy so the whole page keeps working
 *      - passes Set-Cookie through under host-prefixed names, so the browser
 *        keeps a per-site cookie jar on our single origin and we re-attach
 *        the right cookies on each upstream request
 *      - folds extra query params into the target (GET forms -> site search)
 *      - injects a tiny reporter script that postMessages navigation events
 *        (url + title) to the parent app
 *
 * 2) Shell console:  WS upgrade on ANY path (client uses /ws).
 *      client -> server:  {type:"exec", command, timeout?}
 *                        {type:"signal", sig:"INT"|"KILL"}
 *      server -> client:  {type:"hello", cwd}
 *                        {type:"out", stream:"stdout"|"stderr", text}
 *                        {type:"done", code, cwd}
 *                        {type:"error", message}
 *    Commands run through bash -c with a cwd that persists per connection
 *    (a \x01CWD\x01 sentinel reports $PWD after every command).
 *
 * 3) GET /health, GET / -> info page.
 */
import fs from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";

const PORT = 3030;
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_UPSTREAM_BYTES = 64 * 1024 * 1024;
const TMP_DIR = `${os.tmpdir()}/browser-backend`;

fs.mkdirSync(TMP_DIR, { recursive: true });
// sweep stale temp files hourly
setInterval(() => {
  try {
    const cutoff = Date.now() - 3600_000;
    for (const f of fs.readdirSync(TMP_DIR)) {
      const p = `${TMP_DIR}/${f}`;
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}, 3600_000).unref?.();

/* ===================== SCRM access enforcement ===================== */

/**
 * The legacy proxy + shell console only serve requests carrying a valid
 * signed sj_access cookie (paid, approved user session) — the cookie is
 * minted by /api/access after password + face verification, and signed with
 * the HMAC secret shared through db/access-engine.key. An admin session
 * cookie deliberately does NOT grant proxy access (SCRM semantics).
 */
// Portable project root: this file lives at <project>/mini-services/browser-backend/,
// so db/access-engine.key resolves on any machine, not just this sandbox.
const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const ENGINE_KEY_FILE = join(PROJECT_ROOT, "db", "access-engine.key");
let cachedSecret: string | null = null;
let cachedSecretAt = 0;

function engineSecret(): string | null {
  if (cachedSecret !== null && Date.now() - cachedSecretAt < 10_000) return cachedSecret;
  try {
    cachedSecret = fs.readFileSync(ENGINE_KEY_FILE, "utf8").trim() || null;
  } catch {
    cachedSecret = null;
  }
  cachedSecretAt = Date.now();
  return cachedSecret;
}

/** Verify one signed sj_access value ("v1.<payload>.<hmac>"). */
function verifyAccessValue(value: string | null | undefined): boolean {
  if (typeof value !== "string" || !value || value.length > 2000) return false;
  const secret = engineSecret();
  if (!secret) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expected = createHmac("sha256", secret).update(parts[1]).digest();
  let sig: Buffer;
  try {
    sig = Buffer.from(parts[2], "base64url");
  } catch {
    return false;
  }
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return (
      payload?.v === 1 &&
      payload?.role === "user" &&
      payload?.amr === "webauthn" &&
      Number.isFinite(payload?.exp) &&
      payload.exp > Date.now()
    );
  } catch {
    return false;
  }
}

/** The signed session value carried in the ?sjt= query parameter — the
 *  cookie-free auth path for the cross-site preview iframe, where the
 *  browser blocks third-party cookies (including same-origin fetches made
 *  from inside the frame). Appended to /api/proxy, /api/search and /ws URLs
 *  by the client and propagated into every URL we rewrite. */
function requestSjt(req: Request): string | null {
  try {
    const v = new URL(req.url).searchParams.get("sjt");
    return v && v.length <= 2000 ? v : null;
  } catch {
    return null;
  }
}

function accessGranted(req: Request): boolean {
  const cookie = req.headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)sj_access=([^;]+)/.exec(cookie);
  if (m && verifyAccessValue(m[1])) return true;
  return verifyAccessValue(requestSjt(req));
}

function locked(): Response {
  return json({ ok: false, error: "Unlock the workspace first." }, 401);
}

/** DB-backed session check (revocation / payment) through the Next.js access
 *  API, used on console websocket upgrades so revoked members cannot
 *  reconnect. Falls open to the signature-only verdict when unreachable. */
async function deepVerify(req: Request): Promise<boolean> {
  try {
    let cookie = req.headers.get("cookie") ?? "";
    const sjt = requestSjt(req);
    if (sjt && !/(?:^|;\s*)sj_access=/.test(cookie)) {
      cookie = (cookie ? cookie + "; " : "") + "sj_access=" + sjt;
    }
    const res = await fetch("http://127.0.0.1:3000/api/access", {
      headers: { cookie },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { unlocked?: boolean };
    return body?.unlocked === true;
  } catch {
    return false;
  }
}

/* ============================ helpers ============================ */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "*",
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/* ============================ cookie jar ============================ */

interface CookieEntry { host: string; name: string; value: string }
const jar = new Map<string, CookieEntry>();

/** Rename cookies to "<host>__<name>" so multiple sites can share our origin. */
function rewriteSetCookie(sc: string, host: string): string | null {
  const semi = sc.indexOf(";");
  const nv = semi < 0 ? sc : sc.slice(0, semi);
  const eq = nv.indexOf("=");
  if (eq < 1) return null;
  const name = nv.slice(0, eq).trim();
  const value = nv.slice(eq + 1).trim();
  if (!name) return null;
  const attrs = semi < 0 ? [] : sc.slice(semi + 1).split(";").map((a) => a.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const a of attrs) {
    const key = a.split("=")[0].trim().toLowerCase();
    if (key === "expires" || key === "max-age" || key === "samesite" || key === "httponly") kept.push(a);
  }
  if (jar.size > 600) jar.clear(); // keep the jar bounded
  jar.set(`${host}__${name}`, { host, name, value });
  return `${host}__${name}=${value}; Path=/${kept.length ? "; " + kept.join("; ") : ""}`;
}

/** Attach the cookies that belong to the target host (browser echo or jar). */
function collectCookies(req: Request, host: string): string | null {
  const raw = req.headers.get("cookie");
  const parts: string[] = [];
  if (raw) {
    for (const pair of raw.split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const cname = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const entry = jar.get(cname);
      if (entry && (entry.host === host || host.endsWith("." + entry.host))) {
        parts.push(`${entry.name}=${value}`);
      }
    }
  }
  if (!parts.length) {
    for (const entry of jar.values()) {
      if (entry.host === host || host.endsWith("." + entry.host)) parts.push(`${entry.name}=${entry.value}`);
    }
  }
  return parts.length ? parts.join("; ") : null;
}

/* ============================ rewriters ============================ */

/**
 * Rewrite every reachable URL in an HTML document to point at the proxy.
 * Mirror-first: if we cannot resolve/validate a URL we leave it untouched.
 * The sjt session token (cookie-free auth for the preview iframe) is
 * threaded into every rewritten URL so sub-resources authenticate too.
 */
function rewriteHtml(html: string, baseUrl: string, xtp: string, sjt: string | null): string {
  const sjtPart = sjt ? `&sjt=${encodeURIComponent(sjt)}` : "";
  const P = (u: string): string => {
    const raw = u.trim().replace(/&amp;/g, "&");
    if (!raw || /^(data:|blob:|about:|javascript:|mailto:|tel:|sms:|#)/i.test(raw)) return u;
    try {
      const abs = new URL(raw, baseUrl).href;
      if (!/^https?:/i.test(abs)) return u;
      return `/api/proxy?XTransformPort=${xtp}${sjtPart}&url=${encodeURIComponent(abs)}`;
    } catch {
      return u;
    }
  };

  // 1) in-document CSP meta tags would still block the iframe
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");

  // 2) <base href> changes relative resolution; honor it, then remove it
  const baseMatch = html.match(/<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (baseMatch) {
    const bh = (baseMatch[1] ?? baseMatch[2] ?? "").replace(/&amp;/g, "&");
    try {
      baseUrl = new URL(bh, baseUrl).href;
    } catch {
      /* keep original base */
    }
    html = html.replace(/<base\b[^>]*>/i, "");
  }

  // 3) URL-bearing attributes (quoted or bare)
  html = html.replace(
    /(\s(?:href|src|action|poster|formaction|background|data-src|data-href|data-original|data-lazy-src)\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (_m, pre: string, _full: string, dqv?: string, sqv?: string, uqv?: string) => {
      const u = dqv ?? sqv ?? uqv ?? "";
      return `${pre}"${escapeAttr(P(u))}"`;
    },
  );

  // 4) srcset lists ("a.png 1x, b.png 2x")
  html = html.replace(
    /(\ssrcset\s*=\s*)("([^"]*)"|'([^']*)')/gi,
    (_m, pre: string, _full: string, dqv?: string, sqv?: string) => {
      const val = dqv ?? sqv ?? "";
      const out = val
        .split(",")
        .map((part) => {
          const seg = part.trim().split(/\s+/);
          if (seg.length && seg[0]) seg[0] = P(seg[0]);
          return seg.join(" ");
        })
        .join(", ");
      return `${pre}"${escapeAttr(out)}"`;
    },
  );

  // 5) url(...) in style attributes and <style> blocks — CSS never decodes
  //    HTML entities, so escape via percent-encoding instead of &amp;
  //    (a literal &amp; would end up in the request URL and break routing).
  //    Keep the original quote style so style="..." attributes stay intact.
  html = html.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (_m, q: string, u: string) => {
    const rewritten = cssSafe(P(u));
    if (q === "'") return `url('${rewritten.replace(/'/g, "%27")}')`;
    if (q === '"') return `url("${rewritten}")`;
    return `url(${rewritten.replace(/[\s()'"]/g, (c) => encodeURIComponent(c))})`;
  });

  // 6) @import "..."
  html = html.replace(/@import\s+(["'])(.*?)\1/gi, (_m, _q: string, u: string) => `@import "${cssSafe(P(u))}"`);

  // 7) SRI hashes break for rewritten resources; target= breaks out of the iframe
  html = html.replace(/\sintegrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = html.replace(/\starget\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // 8) navigation reporter: same-origin iframe -> postMessage url/title to app
  const reporter =
    `<script>(function(){function real(){try{var u=new URLSearchParams(location.search).get('url');if(u)return u}catch(e){}return location.href}` +
    `function rep(){try{parent.postMessage({__cwNav:1,url:real(),title:document.title||''},'*')}catch(e){}}` +
    `if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',rep);else rep();` +
    `try{var p=history.pushState;if(p)history.pushState=function(){p.apply(this,arguments);rep()}}catch(e){}` +
    `try{var r=history.replaceState;if(r)history.replaceState=function(){r.apply(this,arguments);rep()}}catch(e){}` +
    `window.addEventListener('popstate',rep);window.addEventListener('hashchange',rep);window.addEventListener('load',rep);})()</script>`;
  html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, reporter + "</head>") : reporter + html;
  return html;
}

function cssSafe(u: string): string {
  return u.replace(/"/g, "%22");
}

function rewriteCss(css: string, baseUrl: string, xtp: string, sjt: string | null): string {
  const sjtPart = sjt ? `&sjt=${encodeURIComponent(sjt)}` : "";
  const P = (u: string): string => {
    const raw = u.trim();
    if (!raw || /^(data:|blob:|#)/i.test(raw)) return u;
    try {
      const abs = new URL(raw, baseUrl).href;
      if (!/^https?:/i.test(abs)) return u;
      return `/api/proxy?XTransformPort=${xtp}${sjtPart}&url=${encodeURIComponent(abs)}`;
    } catch {
      return u;
    }
  };
  css = css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (_m, _q: string, u: string) => `url("${cssSafe(P(u))}")`);
  css = css.replace(/@import\s+(["'])(.*?)\1/gi, (_m, _q: string, u: string) => `@import "${cssSafe(P(u))}"`);
  return css;
}

/* ============================ curl fetch ============================ */

interface CurlResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  headerPairs: Array<[string, string]>;
  body: ArrayBuffer;
  error?: string;
}

/**
 * Fetch through curl: Bun's TLS fingerprint is blocked by several CDNs
 * (Wikimedia etc.) while curl's HTTP/2 + BoringSSL profile passes.
 */
async function curlFetch(
  target: URL,
  headers: Record<string, string>,
  method: string,
  body: ArrayBuffer | null,
): Promise<CurlResult> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const hdrFile = `${TMP_DIR}/cw-${id}.hdr`;
  const bodyFile = `${TMP_DIR}/cw-${id}.body`;
  const inFile = `${TMP_DIR}/cw-${id}.in`;

  const args = [
    "-sS",
    "-L",
    "--compressed",
    "--max-time", "25",
    "--connect-timeout", "10",
    "--max-redirs", "8",
    "-D", hdrFile,
    "-o", bodyFile,
    "-w", "%{http_code}\t%{url_effective}",
  ];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (method === "HEAD") {
    args.push("-I");
  } else if (method !== "GET") {
    if (body && body.byteLength > 0) {
      await Bun.write(inFile, body);
      args.push("--data-binary", `@${inFile}`);
    }
    args.push("-X", method);
  }
  args.push(target.href);

  const proc = Bun.spawn(["curl", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  const errText = (await new Response(proc.stderr).text()).trim();
  await proc.exited;

  let hdrText = "";
  let bodyBuf = new ArrayBuffer(0);
  try {
    hdrText = await Bun.file(hdrFile).text();
  } catch {
    /* no headers */
  }
  try {
    const f = Bun.file(bodyFile);
    if (f.size > 0 && f.size <= MAX_UPSTREAM_BYTES) bodyBuf = await f.arrayBuffer();
    else if (f.size > MAX_UPSTREAM_BYTES) {
      try { fs.unlinkSync(hdrFile); fs.unlinkSync(bodyFile); fs.unlinkSync(inFile); } catch { /* ignore */ }
      return { ok: false, status: 413, finalUrl: target.href, headerPairs: [], body: new ArrayBuffer(0), error: "upstream resource too large" };
    }
  } catch {
    /* no body */
  }
  try {
    fs.unlinkSync(hdrFile);
    fs.unlinkSync(bodyFile);
    fs.unlinkSync(inFile);
  } catch {
    /* ignore */
  }

  if (!hdrText && (errText || out === "")) {
    return {
      ok: false,
      status: 502,
      finalUrl: target.href,
      headerPairs: [],
      body: new ArrayBuffer(0),
      error: errText || "upstream request failed",
    };
  }

  let status = 502;
  let finalUrl = target.href;
  const tab = out.indexOf("\t");
  if (tab > 0) {
    status = parseInt(out.slice(0, tab), 10) || 502;
    finalUrl = out.slice(tab + 1).trim() || target.href;
  } else if (out) {
    status = parseInt(out, 10) || 502;
  }

  // headers of the FINAL response (redirects produce multiple blocks)
  const blocks = hdrText.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
  const lastBlock = blocks.length ? blocks[blocks.length - 1] : "";
  const pairs: Array<[string, string]> = [];
  for (const line of lastBlock.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const name = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (name) pairs.push([name, value]);
    }
  }
  return { ok: true, status, finalUrl, headerPairs: pairs, body: bodyBuf };
}

/* ============================ proxy handler ============================ */

const STRIP_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
  "report-to",
  "reporting-endpoints",
  "nel",
  "alt-svc",
  "link",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "vary",
  "server",
  "via",
  "date",
  "referrer-policy",
  "x-content-type-options",
  "if-none-match",
  "if-modified-since",
]);

function headerValue(pairs: Array<[string, string]>, name: string): string | null {
  for (const [k, v] of pairs) {
    if (k.toLowerCase() === name) return v;
  }
  return null;
}

function decodeBuffer(buf: ArrayBuffer, ct: string, sniffMeta: boolean): string {
  let label = "utf-8";
  const m = ct.match(/charset=["']?([\w-]+)/i);
  if (m) label = m[1];
  else if (sniffMeta) {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 2048));
    const mm = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
    if (mm) label = mm[1];
  }
  try {
    return new TextDecoder(label.toLowerCase()).decode(buf);
  } catch {
    return new TextDecoder().decode(buf);
  }
}

function errorPage(target: URL, err: unknown): Response {
  const msg = err instanceof Error ? err.message : String(err);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Could not load page</title><style>
body{background:#09090b;color:#e4e4e7;font:14px/1.6 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:560px;padding:32px;border:1px solid #27272a;border-radius:12px;background:#18181b}
h1{font-size:17px;margin:0 0 12px;color:#f4f4f5} code{color:#a1a1aa;word-break:break-all;font-size:12px}
pre{color:#f87171;background:#09090b;border:1px solid #27272a;padding:8px 10px;border-radius:8px;font-size:12px;overflow:auto;white-space:pre-wrap}
</style></head><body><div class="card"><h1>This site could not be reached</h1>
<p><code>${escapeHtml(target.href)}</code></p><pre>${escapeHtml(msg.slice(0, 400))}</pre></div></body></html>`;
  return new Response(html, {
    status: 502,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleProxy(req: Request, url: URL): Promise<Response> {
  const xtp = url.searchParams.get("XTransformPort") || "3030";
  const sjt = requestSjt(req);
  const rawTarget = url.searchParams.get("url");
  if (!rawTarget) return json({ ok: false, error: "missing url parameter" }, 400);
  // raw=1: pass the upstream body through UNREWRITTEN (view-source and
  // save-page-as need the original bytes, not the proxy-rewritten copy)
  const rawMode = url.searchParams.get("raw") === "1";

  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    return json({ ok: false, error: "invalid url" }, 400);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return json({ ok: false, error: "only http(s) URLs are supported" }, 400);
  }

  // fold extra query params into the target (GET form submissions land here)
  if (req.method === "GET") {
    for (const [k, v] of url.searchParams) {
      if (
        k === "url" ||
        k === "raw" ||
        k === "sjt" ||
        k.toLowerCase() === "xtransformport"
      )
        continue;
      target.searchParams.append(k, v);
    }
  }

  const headers: Record<string, string> = {
    "user-agent": UA,
    accept:
      req.headers.get("accept") ||
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    // English/Australia by default: the workspace audience is Australian, and
    // the sandbox egress IP is Asian-geo (sites otherwise serve Chinese UIs
    // by geo-IP even with an English browser). The caller's own header wins.
    "accept-language": req.headers.get("accept-language") || "en-AU,en;q=0.9",
    "accept-encoding": "gzip, deflate",
  };
  // Search-engine SERP pages are fetched COOKIELESS. Bing's anti-bot layer
  // keys a rotating __Host-XY session token to its cookie set; when a proxy
  // replays a token out of order (concurrent subresources all snapshot the
  // same jar) Bing serves junk result pages — unrelated SERPs for random
  // popular queries (verified live: "youtube" returned Wordle/WhatsApp/
  // POSEIDON results while cookieless requests got the real SERP every
  // time). Search results need no cookies, so send none for the SERP itself;
  // every other request keeps the normal per-site cookie jar.
  const isSearchSerp = /(^|\.)bing\.com$/.test(target.hostname) && target.pathname === "/search";
  if (!isSearchSerp) {
    const cookies = collectCookies(req, target.hostname);
    if (cookies) headers.cookie = cookies;
  } else {
    // same heuristic as /api/search: an English Accept-Language from this
    // Asian-geo IP triggers Bing's junk-SERP bot path — send none
    delete headers["accept-language"];
  }

  // if the request came from a proxied page, send the real page URL as referer
  const ref = req.headers.get("referer");
  if (ref) {
    try {
      const refUrl = new URL(ref, url);
      const inner = refUrl.searchParams.get("url");
      if (inner) headers.referer = new URL(inner, target).href;
    } catch {
      /* ignore bad referer */
    }
  }
  const range = req.headers.get("range");
  if (range) headers.range = range;

  let reqBody: ArrayBuffer | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    reqBody = await req.arrayBuffer();
    if (reqBody.byteLength > MAX_BODY_BYTES) return json({ ok: false, error: "body too large" }, 413);
    const rct = req.headers.get("content-type");
    if (rct) headers["content-type"] = rct;
  }

  const result = await curlFetch(target, headers, req.method, reqBody);
  if (!result.ok) return errorPage(target, new Error(result.error ?? "upstream failed"));

  const finalUrl = result.finalUrl || target.href;
  let finalHost = target.hostname;
  try {
    finalHost = new URL(finalUrl).hostname;
  } catch {
    /* keep target host */
  }
  const ct = (headerValue(result.headerPairs, "content-type") || "").toLowerCase();

  // raw passthrough: original bytes, original content-type, no rewriting —
  // used by view-source and save-page-as. The effective (post-redirect) URL
  // rides along as a header so the caller can show what was actually served.
  if (rawMode) {
    const rawHeaders = new Headers();
    rawHeaders.set("content-type", ct || "text/plain; charset=utf-8");
    rawHeaders.set("cache-control", "no-store");
    try {
      rawHeaders.set("x-cw-final-url", finalUrl);
    } catch {
      /* header value refused — ignore */
    }
    return new Response(result.body, { status: result.status, headers: rawHeaders });
  }

  const isHtml = ct.includes("text/html") || ct.includes("application/xhtml");
  const isCss = ct.includes("text/css");

  // response headers: cookies first, then safe passthrough
  const outHeaders = new Headers();
  for (const [k, v] of result.headerPairs) {
    if (k.toLowerCase() === "set-cookie") {
      const rewritten = rewriteSetCookie(v, finalHost);
      if (rewritten) outHeaders.append("set-cookie", rewritten);
    }
  }
  for (const [k, v] of result.headerPairs) {
    const lk = k.toLowerCase();
    if (STRIP_HEADERS.has(lk) || lk === "set-cookie") continue;
    try {
      outHeaders.set(k, v);
    } catch {
      /* skip headers Bun refuses */
    }
  }

  // text rewriting path
  if ((isHtml || isCss || !ct) && req.method === "GET") {
    const head = new TextDecoder("latin1").decode(result.body.slice(0, 1024));
    const htmlish = isHtml || (!isCss && !ct && /<(!doctype\s+html|html[\s>])/i.test(head));
    if ((isHtml || isCss || htmlish) && result.body.byteLength <= MAX_TEXT_BYTES) {
      const text = decodeBuffer(result.body, ct, htmlish);
      const out = isCss && !htmlish ? rewriteCss(text, finalUrl, xtp, sjt) : rewriteHtml(text, finalUrl, xtp, sjt);
      outHeaders.set("content-type", isCss && !htmlish ? "text/css; charset=utf-8" : "text/html; charset=utf-8");
      outHeaders.set("cache-control", "no-store");
      return new Response(out, { status: result.status, headers: outHeaders });
    }
  }

  if (req.method === "HEAD") return new Response(null, { status: result.status, headers: outHeaders });
  return new Response(result.body, { status: result.status, headers: outHeaders });
}

/* ============================ shell console ============================ */

/**
 * Strips the trailing \x01CWD\x01<pwd> sentinel from a stdout stream and
 * remembers the last reported cwd. Handles markers split across chunks.
 */
class CwdFilter {
  private hold = "";
  cwd: string | null = null;

  push(text: string): string {
    this.hold += text;
    const MARK = "\x01CWD\x01";
    const last = this.hold.lastIndexOf(MARK);
    if (last >= 0) {
      const after = this.hold.slice(last + MARK.length);
      const t = after.trim();
      if (t) this.cwd = t;
      this.hold = this.hold.slice(0, last);
    }
    // hold back a possible partial sentinel at the tail (\x01 never appears
    // in normal command output, so this is invisible)
    let cut = this.hold.length;
    const c1 = this.hold.lastIndexOf("\x01");
    if (c1 >= 0 && this.hold.length - c1 < MARK.length + 80) cut = c1;
    const emit = this.hold.slice(0, cut);
    this.hold = this.hold.slice(cut);
    return emit;
  }

  flush(): string {
    const rest = this.hold;
    this.hold = "";
    return rest;
  }
}

interface ShellState {
  cwd: string;
  child: Bun.Subprocess<"ignore", "pipe", "pipe"> | null;
  filter: CwdFilter;
  timer: Timer | null;
}

const shells = new Map<unknown, ShellState>();
const authorizationTimers = new Map<unknown, ReturnType<typeof setInterval>>();

function safeSend(ws: { send: (data: string) => void }, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* socket gone */
  }
}

function killShellTree(sh: ShellState, hard: boolean): void {
  const child = sh.child;
  if (!child) return;
  const sig: number = hard ? 9 : 2;
  try {
    // negative pid = whole process group (bash runs under setsid)
    process.kill(-child.pid, sig);
    return;
  } catch {
    /* group gone or unsupported — fall through */
  }
  try {
    child.kill(sig);
  } catch {
    /* already gone */
  }
}

async function runCommand(ws: { send: (data: string) => void }, sh: ShellState, command: string, timeoutMs: number): Promise<void> {
  if (sh.child) {
    safeSend(ws, { type: "error", message: "a command is already running — send Ctrl+C first" });
    return;
  }
  // cd to the session cwd, run the command, then report $PWD via sentinel.
  // setsid gives bash its own process group so Ctrl+C can kill the whole
  // tree (children would otherwise keep the stdout pipe open as orphans).
  const script = `cd ${shq(sh.cwd)} 2>/dev/null; ${command}\nprintf '\\x01CWD\\x01%s' "$PWD"`;
  const child = Bun.spawn(["setsid", "bash", "-c", script], {
    cwd: sh.cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLUMNS: "110",
      LINES: "30",
      HOME: os.homedir(),
      PWD: sh.cwd,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  sh.child = child;
  sh.filter = new CwdFilter();

  sh.timer = setTimeout(() => {
    killShellTree(sh, true);
    safeSend(ws, { type: "error", message: `command timed out after ${Math.round(timeoutMs / 1000)}s (killed)` });
  }, timeoutMs);

  const pump = async (
    stream: ReadableStream<Uint8Array> | null,
    dec: TextDecoder,
    isStdout: boolean,
  ): Promise<void> => {
    if (!stream) return;
    try {
      for await (const chunk of stream) {
        const text = dec.decode(chunk as Uint8Array, { stream: true });
        if (!text) continue;
        if (isStdout) {
          const emit = sh.filter.push(text);
          if (emit) safeSend(ws, { type: "out", stream: "stdout", text: emit });
        } else {
          safeSend(ws, { type: "out", stream: "stderr", text });
        }
      }
      const tail = dec.decode();
      if (tail) {
        if (isStdout) {
          const emit = sh.filter.push(tail);
          if (emit) safeSend(ws, { type: "out", stream: "stdout", text: emit });
        } else {
          safeSend(ws, { type: "out", stream: "stderr", text: tail });
        }
      }
    } catch {
      /* stream closed */
    }
  };

  await Promise.all([pump(child.stdout, new TextDecoder(), true), pump(child.stderr, new TextDecoder(), false)]);
  const code = await child.exited;
  const finalEmit = sh.filter.flush();
  if (finalEmit) safeSend(ws, { type: "out", stream: "stdout", text: finalEmit });
  if (sh.filter.cwd) sh.cwd = sh.filter.cwd;
  if (sh.timer) clearTimeout(sh.timer);
  sh.child = null;
  safeSend(ws, { type: "done", code, cwd: sh.cwd });
}

/* ============================ server ============================ */

const INFO_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>browser-backend</title><style>
body{background:#09090b;color:#e4e4e7;font:14px/1.7 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:520px;padding:28px;border:1px solid #27272a;border-radius:12px;background:#18181b}
h1{font-size:16px;margin:0 0 10px}code{color:#34d399;font-size:13px}p{color:#a1a1aa;margin:6px 0}
</style></head><body><div class="card"><h1>browser-backend</h1>
<p>Web proxy + shell console for the Browser app.</p>
<p><code>GET /api/proxy?url=...</code> — proxied page</p>
<p><code>WS&nbsp; /ws</code> — shell console (JSON messages)</p>
<p><code>GET /health</code> — health check</p></div></body></html>`;

/* ============================ search (Bing RSS) ============================ */

/**
 * GET /api/search?q=<query>
 *
 * Search results come from Bing's RSS output (search?q=...&format=rss):
 * a completely separate pipeline from the HTML SERP, immune to the
 * anti-bot "junk SERP" behavior Bing's edge serves to proxy clients on
 * popular queries (verified live: the HTML SERP for "youtube" returned
 * unrelated cached result pages while the RSS endpoint returned the real
 * youtube.com results every single time). Results are parsed to JSON,
 * cached 10 minutes per query, and rendered by the app's own Chrome-style
 * results page.
 */
interface SearchResult { title: string; url: string; snippet: string }
const searchCache = new Map<string, { ts: number; results: SearchResult[] }>();

function decodeXmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function parseBingRss(xml: string): SearchResult[] {
  const out: SearchResult[] = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  for (const it of items.slice(0, 12)) {
    const t = it.match(/<title>([\s\S]*?)<\/title>/);
    const l = it.match(/<link>([\s\S]*?)<\/link>/);
    const d = it.match(/<description>([\s\S]*?)<\/description>/);
    if (!t || !l) continue;
    const url = decodeXmlText(l[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      title: decodeXmlText(t[1]) || url,
      url,
      snippet: d ? decodeXmlText(d[1]).slice(0, 400) : "",
    });
  }
  return out;
}

/** Fraction of CJK characters in a string (0..1) — used to detect the
 *  Chinese-market result sets this Asian-geo IP keeps receiving. */
function cjkFraction(s: string): number {
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uff66-\uff9f]/g) ?? []).length;
  return s.length ? cjk / s.length : 0;
}

/** Meaningful query tokens for topical-relevance scoring. */
function queryTokens(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !["the", "and", "for", "with", "how", "what", "when", "where", "best", "does"].includes(t));
}

/** true when a result mentions at least one query token in its title or
 *  hostname — Bing's junk SERPs for flagged IPs are topically UNRELATED
 *  (e.g. "Lane Bryant plus-size clothing" for "australia news"), so
 *  token overlap separates real results from junk even when the junk is
 *  perfectly good English. */
function resultTouchesQuery(r: SearchResult, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const hay = (r.title + " " + r.url).toLowerCase();
  let host = "";
  try {
    host = new URL(r.url).hostname;
  } catch {
    /* keep empty */
  }
  const hostHay = host.replace(/[^a-z0-9]+/g, " ");
  return tokens.some((t) => hay.includes(t) || hostHay.includes(t));
}

/** A result set is "good" when it has enough items, is predominantly
 *  Latin-script (the workspace audience is English/Australian; Bing's
 *  geo-IP result sets for this datacenter IP are half Chinese) and is
 *  topically related to the query. Junk = Chinese-market sets, tiny
 *  sets, or unrelated sets from Bing's bot-scoring. */
function resultsQuality(results: SearchResult[], q: string): { ok: boolean; score: number } {
  if (results.length < 3) return { ok: false, score: results.length };
  const tokens = queryTokens(q);
  const relevant = results.filter((r) => resultTouchesQuery(r, tokens)).length;
  const cjk = results.filter((r) => cjkFraction(r.title) > 0.25).length;
  const latin = results.length - cjk;
  const score = latin * 2 + relevant * 3 + results.length;
  // "good enough to stop" is a high bar: mostly-English AND mostly-relevant
  // (the mixed Chinese-market sets are relevant too — keep trying variants
  // for a cleaner English set before settling).
  const ok = latin >= Math.ceil(results.length * 0.7) && relevant >= Math.ceil(results.length / 2);
  return { ok, score };
}

async function fetchBingRss(q: string, variant: number): Promise<SearchResult[]> {
  const target = new URL("https://www.bing.com/search");
  target.searchParams.set("q", q);
  target.searchParams.set("format", "rss");
  const headers: Record<string, string> = { "user-agent": UA };
  // Variants: the RSS endpoint's result market fluctuates with Bing's
  // bot-scoring for this datacenter IP — an English set from one variant,
  // junk or Chinese-market sets from others. Try a few and keep the best.
  if (variant === 0) {
    target.searchParams.set("setlang", "en");
  } else if (variant === 1) {
    // plain query, no locale pins
  } else if (variant === 2) {
    // ENSEARCH forces the international (non-CN-market) experience
    headers.cookie = "ENSEARCH=BEN VER=1";
  }
  const result = await curlFetch(target, headers, "GET", null);
  if (!result.ok) return [];
  const xml = new TextDecoder("utf-8").decode(result.body);
  return parseBingRss(xml);
}

async function handleSearch(url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 300);
  if (!q) return json({ ok: false, error: "missing q parameter" }, 400);
  const cached = searchCache.get(q);
  if (cached && Date.now() - cached.ts < 600_000) {
    return json({ ok: true, query: q, cached: true, results: cached.results });
  }
  // Header hygiene (verified by bisection against Bing's edge): an English
  // Accept-Language from this sandbox's Asian-geo IP trips Bing's VPN/bot
  // heuristic and serves junk result pages; the RSS endpoint is far more
  // tolerant, so only the UA goes out and locale pins ride the URL.
  let best: SearchResult[] = [];
  let bestScore = -1;
  for (const variant of [0, 1, 2]) {
    const results = await fetchBingRss(q, variant);
    const { ok, score } = resultsQuality(results, q);
    if (score > bestScore) {
      bestScore = score;
      best = results;
    }
    if (ok && results.length >= 5) break; // good enough — stop trying
  }
  if (!best.length) return json({ ok: false, error: "no results returned for this query" }, 502);
  if (searchCache.size > 50) searchCache.clear();
  searchCache.set(q, { ts: Date.now(), results: best });
  return json({ ok: true, query: q, results: best });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.headers.get("upgrade") === "websocket") {
      if (!accessGranted(req)) return locked();
      if (!(await deepVerify(req))) return locked();
      if (srv.upgrade(req, { data: { authorizationRequest: req } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "*",
        },
      });
    }
    if (path === "/health") return json({ ok: true, service: "browser-backend", version: "1.3.0" });
    if (path === "/api/proxy") {
      if (!accessGranted(req)) return locked();
      if (!(await deepVerify(req))) return locked();
      return handleProxy(req, url);
    }
    if (path === "/api/search") {
      if (!accessGranted(req)) return locked();
      if (!(await deepVerify(req))) return locked();
      return handleSearch(url);
    }
    if (path === "/") return new Response(INFO_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    return json({ ok: false, error: "not found" }, 404);
  },
  websocket: {
    open(ws) {
      shells.set(ws, { cwd: os.homedir(), child: null, filter: new CwdFilter(), timer: null });
      const request = (ws.data as { authorizationRequest: Request }).authorizationRequest;
      const timer = setInterval(() => {
        void deepVerify(request).then((allowed) => { if (!allowed) ws.close(4003, "Workspace approval required"); });
      }, 15_000);
      timer.unref();
      authorizationTimers.set(ws, timer);
      safeSend(ws, { type: "hello", cwd: os.homedir() });
    },
    message(ws, message) {
      const sh = shells.get(ws);
      if (!sh) return;
      let msg: { type?: string; command?: string; timeout?: number; sig?: string };
      try {
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message as ArrayBuffer);
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === "exec" && typeof msg.command === "string") {
        if (msg.command.length > 10000) {
          safeSend(ws, { type: "error", message: "command too long" });
          return;
        }
        const timeout = Math.min(Math.max(msg.timeout ?? 30000, 1000), 300000);
        void runCommand(ws, sh, msg.command, timeout);
      } else if (msg.type === "signal" && sh.child) {
        killShellTree(sh, msg.sig === "KILL");
      }
    },
    close(ws) {
      const authorization = authorizationTimers.get(ws);
      if (authorization) clearInterval(authorization);
      authorizationTimers.delete(ws);
      const sh = shells.get(ws);
      if (sh) {
        if (sh.timer) clearTimeout(sh.timer);
        killShellTree(sh, true);
        shells.delete(ws);
      }
    },
  },
});

console.log(`[browser-backend] listening on :${PORT}`);
