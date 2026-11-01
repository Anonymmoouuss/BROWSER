import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const standalone = join(process.cwd(), ".next", "standalone");
if (!process.env.VERCEL && existsSync(standalone)) {
  mkdirSync(join(standalone, ".next"), { recursive: true });
  cpSync(".next/static", join(standalone, ".next/static"), { recursive: true });
  if (existsSync("public")) {
    cpSync("public", join(standalone, "public"), { recursive: true });
  }
  console.log("Standalone server is ready: bun run start");
}