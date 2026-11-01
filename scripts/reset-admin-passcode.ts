import { PrismaClient } from "@prisma/client";
import { isAbsolute, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { hashPassword, verifyPasswordHash } from "../src/lib/access/crypto";

export async function resetAdminPasscode(database: PrismaClient, password: string): Promise<void> {
  const replacement = hashPassword(password);
  await database.$transaction(async (transaction) => {
    const configuration = await transaction.accessConfig.findUnique({ where: { id: 1 } });
    if (!configuration) throw new Error("This workspace has not been initialized.");
    if (verifyPasswordHash(password, configuration.userHash)) {
      throw new Error("The administrator and member passcodes must be different.");
    }
    await transaction.accessConfig.update({ where: { id: 1 }, data: { adminHash: replacement } });
    await transaction.accessToken.deleteMany({
      where: { role: "admin", kind: { in: ["preauth", "session", "challenge"] } },
    });
    await transaction.accessAudit.create({ data: { actor: "local-owner", action: "admin-passcode-reset" } });
  });
}

async function hiddenQuestion(reader: Interface, prompt: string): Promise<string> {
  stdout.write(prompt);
  try {
    return await reader.question("");
  } finally {
    stdout.write("\n");
  }
}

async function main(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY || process.argv.length > 2) {
    throw new Error("Run bun run admin:reset in a private interactive terminal. Do not pipe passcodes or pass them as arguments.");
  }
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input: stdin, output: muted, terminal: true });
  reader.once("SIGINT", () => reader.close());
  let password: string;
  try {
    password = await hiddenQuestion(reader, "New administrator passcode (12-512 bytes, input hidden): ");
    const confirmation = await hiddenQuestion(reader, "Repeat administrator passcode: ");
    if (password !== confirmation) throw new Error("Passcodes do not match. Nothing was changed.");
  } finally {
    reader.close();
    muted.end();
  }
  const databaseUrl = process.env.DATABASE_URL ?? "file:../db/custom.db";
  if (!databaseUrl.startsWith("file:")) throw new Error("This recovery command requires the local SQLite database.");
  const datasourceUrl = isAbsolute(databaseUrl.slice(5))
    ? databaseUrl
    : `file:${resolve(process.cwd(), "prisma", databaseUrl.slice(5))}`;
  const database = new PrismaClient({ datasourceUrl });
  try {
    await resetAdminPasscode(database, password);
    stdout.write("Administrator passcode updated. Faces, member access, payments, recovery codes, and signing key were preserved.\nRestart the backend before signing in. Password rate limits may take five minutes to expire.\n");
  } finally {
    await database.$disconnect();
  }
}

if (import.meta.main) {
  await main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}