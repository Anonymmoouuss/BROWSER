/**
 * scramjet -- mini-service (port 3031) running the Scramjet web proxy engine
 * (Mercury Workshop) behind this app's single-origin edge.
 *
 * What it serves:
 *   GET /sw.js                     generated service worker (registers the
 *                                  scramjet controller inside the SW scope)
 *   GET /bootstrap-init.js         defines window.initBootstrap() used by the
 *                                  Next.js client to boot the controller
 *   GET /scram/*                   scramjet core bundle + wasm rewriter
 *   GET /controller/*              controller api / inject / sw scripts
 *   GET /clients/libcurl-client.js browser-side libcurl transport (WASM)
 *   WS   /wisp/*                   wisp TCP-tunnel endpoint the transport
 *                                  connects to (this is how proxied traffic
 *                                  actually leaves the sandbox)
 *
 * The frontend origin is the Next.js dev server (port 3000); the HTTP routes
 * above are reverse-proxied to this service through next.config.ts rewrites
 * (same-origin service worker + script loading), while the websocket goes
 * through the edge gateway: wss://<host>/wisp/?XTransformPort=3031
 * (hence the non-default wispPath below).
 *
 * ACCESS (SCRM semantics — unlocked, paid, approved user sessions only):
 * besides the signed sj_access cookie, every route (and the wisp upgrade)
 * accepts the same signed value in a `sjt` query parameter. The app embeds
 * its session grant there because the sandbox preview runs the app inside a
 * cross-site iframe where the browser blocks all third-party cookies — the
 * httpOnly cookie never reaches us on those requests. The generated
 * bootstrap config and service worker template thread the per-session token
 * through every engine asset URL, the wisp websocket, and the worker's own
 * script URL, so the whole engine runs cookie-free when it has to.
 *
 * On first start bootstrap() downloads the current scramjet / controller /
 * utils / transport tarballs from the npm registry into
 * node_modules/@mercuryworkshop/proxy-bootstrap/dist/.downloads and caches
 * them; subsequent starts are offline-fast.
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 3031;
const require = createRequire(import.meta.url);
// Portable project root: this file lives at <project>/mini-services/scramjet/,
// so the db/ directory (engine key + tarball cache) resolves on any machine.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/* ---------------- crash-proof bootstrap preamble ----------------
 * The package's bootstrap() re-downloads + re-extracts the transport
 * tarball on EVERY boot, with a racy double-unlink: a network hiccup or
 * a restart race makes `unlink` throw ENOENT and the whole service dies
 * (node --watch then sits on "Waiting for file changes..." forever —
 * which is exactly how the engine went dark and YouTube stopped
 * working). Two guards before the import:
 *   1. fs/promises.unlink swallows ENOENT (the file is gone either way).
 *   2. globalThis.fetch serves registry tarballs from a local cache, so
 *      restarts work offline and never re-hit npm.
 * Must run BEFORE importing @mercuryworkshop/proxy-bootstrap (the package
 * snapshots fs/promises at its own import time — patching the shared
 * default object works because the package resolves the property at
 * call time). */
const nodeFsPromises = require("fs").promises;
const origUnlink = nodeFsPromises.unlink.bind(nodeFsPromises);
nodeFsPromises.unlink = async function tolerantUnlink(p, ...rest) {
  try {
    return await origUnlink(p, ...rest);
  } catch (err) {
    if (err && err.code === "ENOENT") return undefined;
    throw err;
  }
};

const TARBALL_CACHE_DIR = join(PROJECT_ROOT, "db", "tarball-cache");
try {
  fs.mkdirSync(TARBALL_CACHE_DIR, { recursive: true });
} catch {
  /* best effort */
}
const origFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async function cachedTarballFetch(input, init) {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : null;
    if (url && url.includes("registry.npmjs.org/") && url.endsWith(".tgz")) {
      const { createHash } = await import("node:crypto");
      const key = createHash("sha256").update(url).digest("hex").slice(0, 32) + ".tgz";
      const cachePath = join(TARBALL_CACHE_DIR, key);
      try {
        const cached = await fsp.readFile(cachePath);
        return new Response(cached, { status: 200, headers: { "content-type": "application/x-tar+gzip" } });
      } catch {
        /* not cached — download and cache */
      }
      const res = await origFetch(input, init);
      if (res.ok) {
        const bytes = Buffer.from(await res.arrayBuffer());
        fsp.writeFile(cachePath, bytes).catch(() => {});
        return new Response(bytes, { status: 200, headers: { "content-type": "application/x-tar+gzip" } });
      }
      return res;
    }
  } catch {
    /* fall through to the real fetch */
  }
  return origFetch(input, init);
};

const { bootstrap } = await import("@mercuryworkshop/proxy-bootstrap");

/* ---------- SCRM access enforcement (signed sj_access value) ----------
 * The engine's scripts and the wisp tunnel only serve unlocked (paid,
 * approved user) sessions; the HMAC secret is shared through
 * db/access-engine.key, written by the Next.js /api/access route. Admin
 * sessions deliberately do not grant proxy access (SCRM semantics). */
const ENGINE_KEY_FILE = join(PROJECT_ROOT, "db", "access-engine.key");
let cachedSecret = null;
let cachedSecretAt = 0;

function engineSecret() {
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
function verifyAccessValue(value) {
  if (typeof value !== "string" || value.length > 2000) return false;
  const secret = engineSecret();
  if (!secret) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expected = createHmac("sha256", secret).update(parts[1]).digest();
  let sig;
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
      Number.isFinite(payload?.exp) &&
      payload.exp > Date.now()
    );
  } catch {
    return false;
  }
}

/** Unlocked-session check: sj_access cookie OR ?sjt=<signed value>. */
function accessGranted(req) {
  const cookie = req.headers.cookie ?? "";
  const m = /(?:^|;\s*)sj_access=([^;]+)/.exec(cookie);
  if (m && verifyAccessValue(m[1])) return true;
  try {
    const q = new URL(req.url ?? "/", "http://internal");
    const sjt = q.searchParams.get("sjt");
    if (sjt && verifyAccessValue(sjt)) return true;
  } catch {
    /* fallthrough */
  }
  return false;
}

/** DB-backed session check (revocation / payment) through the Next.js access
 *  API, used on wisp tunnel upgrades so revoked members cannot reconnect.
 *  Falls open to the signature-only verdict when the app is unreachable. */
async function deepVerify(req) {
  try {
    let cookie = req.headers.cookie ?? "";
    try {
      const q = new URL(req.url ?? "/", "http://internal");
      const sjt = q.searchParams.get("sjt");
      if (sjt && !/(?:^|;\s*)sj_access=/.test(cookie)) {
        cookie = (cookie ? cookie + "; " : "") + "sj_access=" + sjt;
      }
    } catch {
      /* no query */
    }
    const res = await fetch("http://127.0.0.1:3000/api/access", {
      headers: { cookie },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return true;
    const body = await res.json();
    return body?.unlocked === true;
  } catch {
    return true;
  }
}

const { routeRequest, routeUpgrade } = await bootstrap({
  // The edge gateway routes websocket upgrades by the XTransformPort query
  // parameter; the client builds its wisp URL as
  //   wss(s)://<origin>/wisp/?XTransformPort=3031[&sjt=<grant>]&x=/
  // The trailing "x=/" exists only to satisfy the wisp client's
  // "URL must end with a forward slash" validation — the gateway forwards
  // the /wisp/ path prefix intact (routeUpgrade matches on it).
  wispPath: "/wisp/?XTransformPort=3031&x=/",
  transport: "libcurl",
});

/* ------------------------- local engine assets ------------------------- */

const PKG_DIR = dirname(require.resolve("@mercuryworkshop/proxy-bootstrap/package.json"));
const DOWNLOADS = join(PKG_DIR, "dist", ".downloads");
const CLIENT_BUNDLE = await fsp.readFile(join(PKG_DIR, "dist", "bootstrap-client.js"), "utf8");
const CLIENT_BUNDLE_B64 = Buffer.from(CLIENT_BUNDLE).toString("base64");

/** Static engine assets, matched by PATHNAME (query-insensitive so the
 *  per-session sjt token can ride along on every URL). */
const ASSET_FILES = new Map([
  ["/controller/controller.api.js", ["controller/package/dist/controller.api.js", "application/javascript"]],
  ["/controller/controller.inject.js", ["controller/package/dist/controller.inject.js", "application/javascript"]],
  ["/controller/controller.sw.js", ["controller/package/dist/controller.sw.js", "application/javascript"]],
  ["/scram/scramjet.js", ["scramjet/package/dist/scramjet.js", "application/javascript"]],
  ["/scram/scramjet.wasm", ["scramjet/package/dist/scramjet.wasm", "application/wasm"]],
  ["/scram/scramjet-utils.js", ["scramjet-utils/package/dist/scramjet-utils.js", "application/javascript"]],
  ["/clients/libcurl-client.js", ["libcurl-transport/package/dist/index.js", "application/javascript"]],
]);

async function serveAsset(res, pathname) {
  const entry = ASSET_FILES.get(pathname);
  if (!entry) return false;
  const data = await fsp.readFile(join(DOWNLOADS, entry[0]));
  res.writeHead(200, {
    "Content-Type": entry[1],
    "Cache-Control": "public, max-age=3600",
    "Content-Length": data.length,
  });
  res.end(data);
  return true;
}

/* -------------------- generated service worker -------------------- */
/* The worker reads its session token from its OWN script URL (registered as
 * /sw.js?sjt=<grant>), keeps the newest token in Cache Storage so a worker
 * restart can reload the controller, and accepts a fresh token over
 * postMessage from the page. All engine-asset fetches it makes itself carry
 * the token in the query (see importScripts below). */
const SW_TEMPLATE = `/* scramjet service worker (session-token aware) */
(function () {
  var loadController = function (token) {
    if (!token || self.$scramjetController) return;
    importScripts("/controller/controller.sw.js?sjt=" + encodeURIComponent(token));
  };
  var rememberToken = function (token) {
    if (!token) return;
    try {
      caches.open("sj-token-v1").then(function (c) {
        c.put("/token", new Response(String(token)));
      });
    } catch (e) {}
  };
  var current = null;
  try {
    current = new URLSearchParams(self.location.search).get("sjt");
  } catch (e) {}
  if (current) {
    /* cookie-less auth: the token rides the worker's own script URL */
    loadController(current);
    rememberToken(current);
  } else {
    /* cookie-authenticated boot (first-party tab): SW fetches carry the
     * sj_access cookie, so import the controller WITHOUT a token right
     * away. A cached token (from a previous cookie-less session) is kept
     * refreshed for worker restarts in blocked-cookie contexts. */
    try {
      if (!self.$scramjetController) importScripts("/controller/controller.sw.js");
    } catch (e) {
      /* cookie missing/blocked — fall back to the cached token below */
      try {
        caches.open("sj-token-v1")
          .then(function (c) { return c.match("/token"); })
          .then(function (r) { return r ? r.text() : null; })
          .then(function (t) { loadController(t); })
          .catch(function () {});
      } catch (e2) {}
    }
    try {
      caches.open("sj-token-v1")
        .then(function (c) { return c.match("/token"); })
        .then(function (r) { return r ? r.text() : null; })
        .then(function (t) { rememberToken(t); })
        .catch(function () {});
    } catch (e) {}
  }
  addEventListener("message", function (e) {
    if (e.data && e.data.type === "sj-token" && e.data.token) {
      rememberToken(e.data.token);
      if (!self.$scramjetController) loadController(e.data.token);
    }
  });
  addEventListener("fetch", function (e) {
    if (self.$scramjetController && $scramjetController.shouldRoute(e)) {
      e.respondWith($scramjetController.route(e));
    }
  });
})();
`;

/* -------------------- generated bootstrap script -------------------- */
/* Mirrors the package's bootstrap-init.js but with a per-request config: the
 * caller's sjt token is embedded in the service-worker URL, the wisp path
 * and every engine asset path, so the whole engine authenticates without
 * cookies (blocked in cross-site preview iframes). */
function bootstrapScript(token) {
  const q = token ? `?sjt=${encodeURIComponent(token)}` : "";
  const config = {
    transport: "libcurl",
    swPath: "/sw.js" + q,
    wispPath: "/wisp/?XTransformPort=3031" + (token ? `&sjt=${encodeURIComponent(token)}` : "") + "&x=/",
    epoxyClientPath: "/clients/epoxy-client.js" + q,
    libcurlClientPath: "/clients/libcurl-client.js" + q,
    bareClientPath: "/clients/bare-client.js" + q,
    bootstrapInitPath: "/bootstrap-init.js" + q,
    scramjetControllerApiPath: "/controller/controller.api.js" + q,
    scramjetControllerInjectPath: "/controller/controller.inject.js" + q,
    scramjetControllerSwPath: "/controller/controller.sw.js" + q,
    scramjetBundlePath: "/scram/scramjet.js" + q,
    scramjetWasmPath: "/scram/scramjet.wasm" + q,
    scramjetUtilsBundlePath: "/scram/scramjet-utils.js" + q,
  };
  return `async function initBootstrap() {
\tconst { init } = await import("data:text/javascript;base64,${CLIENT_BUNDLE_B64}");
\treturn init(${JSON.stringify(config)});
}`;
}

function requestToken(req) {
  try {
    return new URL(req.url ?? "/", "http://internal").searchParams.get("sjt");
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  if (path !== "/health") {
    console.log(`[scramjet] ${req.method} ${req.url?.slice(0, 140)}`);
  }

  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "scramjet", port: PORT }));
    return;
  }

  // Everything else (bootstrap, sw.js, bundles, wisp) requires an unlocked
  // session — cookie or sjt query token.
  if (!accessGranted(req)) {
    res.writeHead(401, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("workspace locked");
    return;
  }

  // Generated service worker (token-aware template; the token rides on the
  // worker's own script URL, not the body).
  if (path === "/sw.js") {
    res.writeHead(200, {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-cache",
    });
    res.end(SW_TEMPLATE);
    return;
  }

  // Generated bootstrap script with the per-session token in its config.
  // Never cached — the config changes with the session.
  if (path === "/bootstrap-init.js") {
    res.writeHead(200, {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-cache",
    });
    res.end(bootstrapScript(requestToken(req)));
    return;
  }

  // Static engine assets (pathname match, query-insensitive).
  if (ASSET_FILES.has(path)) {
    try {
      if (await serveAsset(res, path)) return;
    } catch (err) {
      console.error("[scramjet] asset serve failed:", err);
    }
  }

  // wisp HTTP endpoints (the transport normally only upgrades).
  if (path.startsWith("/wisp/")) {
    if (routeUpgrade(req, res)) return;
  }

  // Fallback: the package router (exact-match legacy paths).
  if (routeRequest(req, res)) return;
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.on("upgrade", async (req, socket, head) => {
  // wisp tunnel: reject upgrades without a valid paid-user session
  if (!accessGranted(req)) {
    socket.destroy();
    return;
  }
  if (!(await deepVerify(req))) {
    socket.destroy();
    return;
  }
  if (routeUpgrade(req, socket, head)) return;
  socket.destroy();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[scramjet] listening on :${PORT} (assets + wisp at /wisp/, sjt token auth)`);
});
