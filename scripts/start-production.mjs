import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");
const server = join(standalone, "server.js");
if (!existsSync(server)) throw new Error("Run bun run build before starting the production server.");
const data = join(root, "db");
const sharedData = join(standalone, "db");
mkdirSync(data, { recursive: true });
if (!existsSync(sharedData)) symlinkSync(data, sharedData, "dir");
if (realpathSync(sharedData) !== realpathSync(data)) {
  throw new Error("Standalone output contains a different database directory. Rebuild before starting.");
}
const databaseUrl = process.env.DATABASE_URL ?? "file:../db/custom.db";
if (databaseUrl.startsWith("file:") && !isAbsolute(databaseUrl.slice(5))) {
  process.env.DATABASE_URL = `file:${resolve(root, "prisma", databaseUrl.slice(5))}`;
}
await import(pathToFileURL(server).href);