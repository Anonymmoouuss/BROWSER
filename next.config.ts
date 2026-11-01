import type { NextConfig } from "next";

/**
 * Scramjet mini-service (mini-services/scramjet, port 3031) serves the web
 * proxy engine's client assets. The browser app lives on the Next.js origin
 * (single external port through the edge gateway), so those assets must be
 * reachable same-origin for the service worker + script loading to work:
 * reverse-proxy the engine's route prefixes to the service here. The wisp
 * websocket does NOT go through these rewrites (Next cannot proxy WS
 * upgrades); the client connects with the edge's XTransformPort query param
 * instead: wss://<host>/wisp/?XTransformPort=3031.
 */
const configuredBackend = process.env.BACKEND_ORIGIN?.trim();
let backendOrigin: string | undefined;
if (configuredBackend) {
  const backend = new URL(configuredBackend);
  if (
    !["http:", "https:"].includes(backend.protocol) ||
    backend.username || backend.password ||
    backend.pathname !== "/" || backend.search || backend.hash
  ) {
    throw new Error("BACKEND_ORIGIN must be an HTTP(S) origin without a path, query, or credentials.");
  }
  if (process.env.VERCEL && backend.protocol !== "https:") {
    throw new Error("BACKEND_ORIGIN must use HTTPS on Vercel.");
  }
  backendOrigin = backend.origin;
}
if (process.env.VERCEL && !backendOrigin) {
  throw new Error("Set BACKEND_ORIGIN to your persistent backend's HTTPS origin before deploying to Vercel.");
}
const SCRAMJET_UPSTREAM = backendOrigin ?? "http://127.0.0.1:3031";

const nextConfig: NextConfig = {
  output: process.env.VERCEL ? undefined : "standalone",
  env: {
    NEXT_PUBLIC_BACKEND_ORIGIN: backendOrigin ?? "",
  },
  outputFileTracingExcludes: {
    "/*": ["./db/**/*", "./e2e-assets/**/*", "./.runtime/**/*", "./scramjet-workspace.zip", "./scramjet-workspace.tar.gz"],
  },
  /* config options here */
  experimental: {
    // The Turbopack persistent cache is an LMDB database. On this sandbox's
    // overlayfs container filesystem, LMDB writes do not survive a process
    // restart: every reload panics with "Failed to restore task data
    // (corrupted database or bug) ... Invalid argument (os error 22)" and
    // the server hangs forever after. Disable the on-disk dev cache — the
    // in-memory cache is unaffected and a cold compile only takes seconds.
    turbopackFileSystemCacheForDev: false,
  },
  reactStrictMode: false,
  // The /p/ proxy serves real-site URLs as paths — trailing slashes are
  // semantically significant upstream (e.g. DDG /html/), so never normalize.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return { beforeFiles: [
      ...(backendOrigin ? [
        { source: "/api/:path*", destination: `${backendOrigin}/api/:path*` },
        {
          source: "/:path*",
          has: [{ type: "query" as const, key: "XTransformPort", value: "(?:3030|3031)" }],
          destination: `${backendOrigin}/:path*`,
        },
      ] : []),
      { source: "/sw.js", destination: `${SCRAMJET_UPSTREAM}/sw.js` },
      { source: "/bootstrap-init.js", destination: `${SCRAMJET_UPSTREAM}/bootstrap-init.js` },
      { source: "/scram/:path*", destination: `${SCRAMJET_UPSTREAM}/scram/:path*` },
      { source: "/controller/:path*", destination: `${SCRAMJET_UPSTREAM}/controller/:path*` },
      { source: "/clients/:path*", destination: `${SCRAMJET_UPSTREAM}/clients/:path*` },
    ], afterFiles: [], fallback: [] };
  },
};

export default nextConfig;
