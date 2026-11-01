/**
 * watchdog -- mini-service (port 3034, health-only) that keeps every other
 * service alive, INCLUDING the Next.js app itself.
 *
 * Why this exists: the scramjet engine died silently (the proxy-bootstrap
 * package's tarball re-extraction race crashed it, and `node --watch` sits
 * on "Waiting for file changes before restarting..." forever after a
 * crash). The whole browser engine was dark until someone noticed —
 * "YouTube isn't working". This watchdog polls each service's /health
 * endpoint; after consecutive failures it restarts the service through
 * its daemonize.py launcher (double-fork, survives tool-call boundaries)
 * and logs the event.
 *
 * The Next.js app (:3000) used to be excluded ("managed by the sandbox
 * platform") — but that assumption proved fatal: the kernel OOM-killed
 * next-server twice (2.9GB RSS on a 3.9GB no-swap box) and NOTHING brought
 * it back. The user saw "The authentication service returned an invalid
 * response" (502 HTML from the gateway) and a dead preview for hours.
 * The app is now watched like everything else; on restart the corrupted-
 * cache risk after a hard kill is neutralised by wiping .next first (the
 * Turbopack panic "Failed to restore task data" brick).
 *
 * Services (restartable):
 *   :3000 app               (bun run dev -> next dev, .next wiped on restart)
 *   :3030 browser-backend   (bun --hot index.ts)
 *   :3031 scramjet          (node supervisor.mjs -> node index.js)
 *   :3032 face-auth         (node --watch index.js)
 */

import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICES = dirname(HERE);
const PROJECT_ROOT = dirname(SERVICES); // /home/z/my-project
const LOG_FILE = join(HERE, "watchdog.log");

const PORT = 3034;
const POLL_MS = 20_000;
const FAIL_THRESHOLD = 3;

const WATCHED = [
  {
    name: "app",
    port: 3000,
    path: "/api/health",
    root: PROJECT_ROOT,
    daemonize: join(HERE, "daemonize.py"),
    cmd: ["bun", "run", "dev"],
    log: "dev-server.log",
    wipeCache: ".next", // hard kills corrupt the Turbopack cache -> panic loop
    cooldownMs: 180_000, // dev server needs time to boot + first compile
  },
  { name: "browser-backend", port: 3030, path: "/health", dir: "browser-backend", cmd: ["bun", "run", "dev"], log: "browser-backend.log" },
  { name: "scramjet", port: 3031, path: "/health", dir: "scramjet", cmd: ["bun", "run", "dev"], log: "scramjet.log" },
  { name: "face-auth", port: 3032, path: "/health", dir: "face-auth", cmd: ["bun", "run", "dev"], log: "face-auth.log" },
];

for (const svc of WATCHED) {
  if (!svc.root) svc.root = join(SERVICES, svc.dir);
  if (!svc.daemonize) svc.daemonize = join(svc.root, "daemonize.py");
  if (!svc.cooldownMs) svc.cooldownMs = 60_000;
}

function log(line) {
  const stamp = new Date().toISOString().slice(11, 19);
  const text = `[${stamp}] ${line}`;
  console.log(text);
  try {
    fs.appendFileSync(LOG_FILE, text + "\n");
  } catch {
    /* disk full etc — console still has it */
  }
}

async function healthy(svc) {
  try {
    const res = await fetch(`http://127.0.0.1:${svc.port}${svc.path}`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Find and kill every process still listening on the port before restart. */
function killPortHolders(port) {
  try {
    const out = spawnSyncText("ss", ["-tlnp"]);
    for (const line of out.split("\n")) {
      if (!line.includes(`:${port} `)) continue;
      const m = /pid=(\d+)/.exec(line);
      if (m) {
        try { process.kill(parseInt(m[1], 10), "SIGKILL"); log(`killed stale pid ${m[1]} on :${port}`); } catch { /* already gone */ }
      }
    }
  } catch {
    /* ss unavailable — try anyway */
  }
}

function spawnSyncText(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (out += d.toString()));
    p.on("exit", () => resolve(out));
    p.on("error", () => resolve(""));
  });
}

const restarts = new Map(); // name -> ts of last restart

async function restartService(svc) {
  const last = restarts.get(svc.name) ?? 0;
  if (Date.now() - last < svc.cooldownMs) {
    log(`${svc.name}: restart suppressed (attempted <${Math.round(svc.cooldownMs / 1000)}s ago)`);
    return;
  }
  restarts.set(svc.name, Date.now());
  log(`${svc.name} DOWN — restarting (${svc.cmd.join(" ")} in ${svc.root})`);
  killPortHolders(svc.port);
  if (svc.wipeCache) {
    // A hard kill (OOM) can leave the Turbopack incremental cache corrupt,
    // which makes next dev panic + hang forever on "restore task data".
    try {
      fs.rmSync(join(svc.root, svc.wipeCache), { recursive: true, force: true });
      log(`${svc.name}: wiped ${svc.wipeCache} (post-crash corruption guard)`);
    } catch (err) {
      log(`${svc.name}: cache wipe FAILED — ${err}`);
    }
  }
  const logPath = join(svc.root, svc.log);
  try {
    spawn("python3", [svc.daemonize, logPath, ...svc.cmd], {
      cwd: svc.root,
      stdio: "ignore",
      detached: true,
    }).unref();
    log(`${svc.name}: restart issued (log: ${svc.log})`);
  } catch (err) {
    log(`${svc.name}: restart FAILED — ${err}`);
  }
}

const failures = new Map();

async function tick() {
  for (const svc of WATCHED) {
    const ok = await healthy(svc);
    const count = (failures.get(svc.name) ?? 0) + (ok ? 0 : 1);
    if (ok) {
      if (count - 1 > 0) log(`${svc.name}: healthy again`);
      failures.set(svc.name, 0);
    } else {
      failures.set(svc.name, count);
      if (count >= FAIL_THRESHOLD) {
        await restartService(svc);
        failures.set(svc.name, 0); // give it time before counting again
      }
    }
  }
}

const server = http.createServer((req, res) => {
  if ((req.url ?? "/").split("?")[0] === "/health") {
    const status = WATCHED.map((s) => ({ name: s.name, port: s.port, failures: failures.get(s.name) ?? 0 }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "watchdog", port: PORT, watched: status }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  log(`watchdog listening on :${PORT} — watching ${WATCHED.map((s) => s.name + " :" + s.port).join(", ")} every ${POLL_MS / 1000}s`);
});
tick();
setInterval(tick, POLL_MS);
