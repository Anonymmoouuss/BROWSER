import { NextResponse } from "next/server";

/**
 * DB-free liveness endpoint for the watchdog (mini-services/watchdog).
 * Must never touch Prisma or any mini-service so a broken dependency
 * cannot make a HEALTHY process server look dead (or vice versa).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, service: "app", port: 3000 });
}
