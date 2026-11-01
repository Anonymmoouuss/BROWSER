import { PrismaClient } from "@prisma/client";

/**
 * Quiet Prisma client dedicated to the access-control domain (no query
 * logging — the browser app's shared client spams dev.log otherwise).
 */
const globalForAccess = globalThis as unknown as {
  accessPrisma?: PrismaClient;
};

export const adb =
  globalForAccess.accessPrisma ?? new PrismaClient({ log: ["error"] });

if (process.env.NODE_ENV !== "production")
  globalForAccess.accessPrisma = adb;
