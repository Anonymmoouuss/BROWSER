/**
 * supervisor.mjs — keeps index.js alive no matter what.
 *
 * `node --watch` does NOT restart a crashed script (it sits on "Waiting
 * for file changes before restarting..." forever — exactly how the engine
 * went dark). This supervisor restarts after any exit, with a backoff,
 * and hard-restarts on file changes too.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

let current = null;
let restarting = false;
let delay = 500;

function start() {
  const child = spawn("node", ["index.js"], { stdio: ["ignore", "inherit", "inherit"] });
  current = child;
  console.log(`[supervisor] started index.js (pid ${child.pid})`);
  child.on("exit", (code, sig) => {
    if (current !== child || restarting) return;
    console.log(`[supervisor] index.js exited (code=${code} sig=${sig}) — restarting in ${delay}ms`);
    setTimeout(() => {
      delay = Math.min(delay * 2, 8000);
      start();
    }, delay);
  });
}

try {
  fs.watchFile("index.js", { interval: 1000 }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs || restarting) return;
    restarting = true;
    console.log("[supervisor] index.js changed — hard restart");
    const old = current;
    if (old) {
      try { old.removeAllListeners("exit"); old.kill("SIGTERM"); } catch {}
    }
    setTimeout(() => {
      restarting = false;
      delay = 500;
      start();
    }, 400);
  });
} catch {
  /* watch unavailable */
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
start();
