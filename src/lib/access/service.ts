import { createHmac, randomUUID, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { adb } from "./db";
import {
  hashSecret,
  newToken,
  hashPassword,
  verifyPasswordHash,
  seal,
  unseal,
  verifyPayload,
  TTL,
} from "./crypto";
import { billingPeriod, billingPeriodAt, PAYMENT_AMOUNT_CENTS } from "./billing";
import { beginPasskey, handlePasskey } from "./passkeys";

/**
 * SCRM-style access service (ported from devperson8000/SCRM
 * api/_lib/auth-service.ts to Prisma + SQLite for this Next.js app).
 *
 * The access condition "approved face + paid current month" protects the
 * session cookies, the browser engine assets (scramjet :3031) and the legacy
 * proxy (browser-backend :3030) — the mini-services verify the signed
 * sj_access cookie with the shared secret in db/access-engine.key.
 */

export type AuthConfig = {
  userHash: string;
  adminHash: string;
  setupHash: string | null;
  templateKey: Buffer;
  secret: string;
};
type Credentials = { preauth?: string; session?: string };
export type Result = {
  status: number;
  body: Record<string, unknown>;
  preauth?: string;
  preauthRole?: "user" | "admin";
  session?: string;
  sessionRole?: "user" | "admin";
  sessionName?: string;
  sessionTtl?: number;
  clear?: boolean;
};
export type AuthSession = {
  id: string;
  userId: string;
  role: "user" | "admin";
  name: string;
};

export const FACE_THRESHOLD = 0.48;
/** Login matching tolerance: slightly wider than the enrollment consistency
 * threshold to absorb real-webcam pose/lighting noise between the averaged
 * 20-photo template and the login capture. */
export const LOGIN_THRESHOLD = 0.52;

class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
function deny(status: number, message: string): never {
  throw new AuthError(status, message);
}

const tokenHash = (value?: string) =>
  value && /^[a-f0-9]{64}$/.test(value) ? hashSecret(value) : "";

export function faceDistance(a: number[], b: number[]): number {
  if (
    a.length !== 128 ||
    b.length !== 128 ||
    !a.every(Number.isFinite) ||
    !b.every(Number.isFinite)
  )
    throw new Error("Invalid face template.");
  return Math.sqrt(a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0));
}

const ENGINE_KEY_FILE = join(process.cwd(), "db", "access-engine.key");

/** Mirror the HMAC secret into db/access-engine.key for the mini-services. */
async function ensureEngineKey(secret: string) {
  try {
    const current = await readFile(ENGINE_KEY_FILE, "utf8").catch(() => null);
    if (current !== secret) {
      await mkdir(dirname(ENGINE_KEY_FILE), { recursive: true });
      await writeFile(ENGINE_KEY_FILE, secret, { mode: 0o600 });
    }
  } catch {
    /* best effort — the gate still works without it */
  }
}

/* ---------------- face checker (mini-service :3032) ---------------- */

type FaceVerifyResponse = {
  descriptor?: unknown;
  reviewFrameIndex?: unknown;
  code?: string;
  message?: string;
};

async function verifyFace(
  images: unknown,
  purpose: "login" | "enroll",
): Promise<{ descriptor: number[]; reviewFrameIndex: number }> {
  let body: FaceVerifyResponse | null = null;
  let status = 503;
  try {
    const res = await fetch("http://127.0.0.1:3032/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images, purpose }),
      signal: AbortSignal.timeout(70_000),
    });
    status = res.status;
    body = (await res.json().catch(() => null)) as FaceVerifyResponse | null;
  } catch {
    deny(503, "The face checker is unavailable. Please retry in a moment.");
  }
  if (status === 200) {
    const descriptor = body?.descriptor;
    if (
      Array.isArray(descriptor) &&
      descriptor.length === 128 &&
      descriptor.every((v) => typeof v === "number" && Number.isFinite(v))
    ) {
      return {
        descriptor: descriptor as number[],
        reviewFrameIndex:
          typeof body?.reviewFrameIndex === "number" ? body.reviewFrameIndex : 0,
      };
    }
    deny(503, "The face checker returned an invalid scan. Retry the scan.");
  }
  deny(
    status === 400 || status === 503 ? status : 503,
    typeof body?.message === "string"
      ? body.message
      : "The face scan could not be processed. Try again.",
  );
}

/* ------------------------------- service ------------------------------- */

export class AccessService {
  private config: AuthConfig | null | undefined;
  private configAt = 0;

  async getConfig(): Promise<AuthConfig | null> {
    // short TTL cache: hot per-request lookups stay cheap, but resets /
    // re-inits of the backing tables take effect within a few seconds.
    if (this.config !== undefined && Date.now() - this.configAt < 5000)
      return this.config;
    const row = await adb.accessConfig.findUnique({ where: { id: 1 } });
    if (!row) {
      this.config = null;
      this.configAt = Date.now();
      return null;
    }
    this.config = {
      userHash: row.userHash,
      adminHash: row.adminHash,
      setupHash: row.setupHash,
      templateKey: Buffer.from(row.templateKey, "hex"),
      secret: row.sessionSecret,
    };
    this.configAt = Date.now();
    void ensureEngineKey(row.sessionSecret);
    return this.config;
  }

  async initialized(): Promise<boolean> {
    return (await this.getConfig()) !== null;
  }

  /** Extract the raw opaque token from a signed cookie value. */
  async rawCookie(value: string | undefined): Promise<string | undefined> {
    const config = await this.getConfig();
    if (!config || !value) return undefined;
    return verifyPayload(config.secret, value)?.tid;
  }

  /** First-run wizard: create the two workspace passwords. Returns the
   *  one-time admin setup secret (shown exactly once). */
  async init(userPassword: unknown, adminPassword: unknown): Promise<Result> {
    const existing = await adb.accessConfig.findUnique({ where: { id: 1 } });
    if (existing) deny(409, "This workspace is already set up.");
    if (
      typeof userPassword !== "string" ||
      typeof adminPassword !== "string" ||
      Buffer.byteLength(userPassword) < 12 ||
      Buffer.byteLength(adminPassword) < 12 ||
      Buffer.byteLength(userPassword) > 512 ||
      Buffer.byteLength(adminPassword) > 512
    )
      deny(400, "Choose two distinct passwords of at least 12 characters each.");
    if (userPassword === adminPassword)
      deny(400, "The two passwords must be different.");
    const setupSecret = newToken();
    await adb.accessConfig.create({
      data: {
        id: 1,
        userHash: hashPassword(userPassword),
        adminHash: hashPassword(adminPassword),
        setupHash: hashSecret(setupSecret),
        templateKey: randomBytes(32).toString("hex"),
        sessionSecret: randomBytes(32).toString("hex"),
      },
    });
    this.config = undefined; // reload on next getConfig()
    await ensureEngineKey((await this.getConfig())!.secret);
    await adb.accessAudit.create({
      data: { action: "init", target: null, actor: null },
    });
    return {
      status: 200,
      body: { setupSecret },
    };
  }

  async throttle(address: string, action: string, limit: number, windowMs = 300_000) {
    // Before first-run init there is no secret yet — fall back to a constant.
    const config = await this.getConfig();
    const secret = config ? config.secret : "pre-init-throttle";
    const key = createHmac("sha256", secret)
      .update(action + ":" + address)
      .digest("hex");
    const now = new Date();
    const existing = await adb.accessRate.findUnique({ where: { key } });
    let count = 1;
    if (!existing || existing.expiresAt <= now) {
      await adb.accessRate.upsert({
        where: { key },
        create: { key, count: 1, expiresAt: new Date(now.getTime() + windowMs) },
        update: { count: 1, expiresAt: new Date(now.getTime() + windowMs) },
      });
    } else {
      count = (await adb.accessRate.update({
        where: { key },
        data: { count: { increment: 1 } },
      })).count;
    }
    if (count > limit) deny(429, "Too many attempts. Try again later.");
  }

  async createToken(
    kind: string,
    role: string | null,
    userId: string | null,
    data: { purpose?: string; preauth?: string; recoverVersion?: number } = {},
    ttl: number,
  ) {
    const raw = newToken();
    await adb.accessToken.create({
      data: {
        hash: hashSecret(raw),
        kind,
        role,
        userId,
        purpose: data.purpose ?? null,
        preauthHash: data.preauth ?? null,
        recoverVersion: data.recoverVersion ?? null,
        expiresAt: new Date(Date.now() + ttl),
      },
    });
    return raw;
  }

  async hasCurrentPayment(userId: string): Promise<boolean> {
    const now = new Date();
    const payment = await adb.accessPayment.findFirst({
      where: { userId, periodStart: { lte: now }, periodEnd: { gt: now } },
      select: { id: true },
    });
    return payment !== null;
  }

  async getSession(raw: string | undefined, role?: "user" | "admin"): Promise<AuthSession | null> {
    const hash = tokenHash(raw);
    if (!hash) return null;
    const token = await adb.accessToken.findUnique({
      where: { hash },
      include: { user: true },
    });
    if (!token || token.kind !== "session" || token.purpose !== "webauthn" || token.expiresAt <= new Date())
      return null;
    const user = token.user;
    if (!user || user.status !== "approved") return null;
    if (role && user.role !== role) return null;
    // The same live payment condition protects cookies and the proxy.
    if (user.role !== "admin") {
      if (!token.passkeyId) return null;
      const credential = await adb.accessPasskey.findUnique({ where: { id: token.passkeyId }, select: { userId: true, approved: true } });
      if (!credential?.approved || credential.userId !== user.id || !(await this.hasCurrentPayment(user.id))) return null;
    }
    return { id: token.hash, userId: user.id, role: user.role as "user" | "admin", name: user.name };
  }

  async cleanup() {
    await adb.accessPasskeyChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const stale = new Date(Date.now() - 604_800_000);
    await adb.accessUser.updateMany({
      where: { status: "pending", createdAt: { lt: stale } },
      data: { status: "rejected", template: null, reviewPhoto: null },
    });
    await adb.accessToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await adb.accessRate.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }

  async preauth(raw: string | undefined) {
    const hash = tokenHash(raw);
    if (hash) {
      const token = await adb.accessToken.findUnique({ where: { hash } });
      if (token && token.kind === "preauth" && token.expiresAt > new Date())
        return token;
    }
    return deny(401, "Enter your password again.");
  }

  async consumeChallenge(
    id: unknown,
    purpose: string,
    prehash: string,
  ) {
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      deny(401, "Invalid or expired scan.");
    const token = await adb.accessToken.findUnique({
      where: { hash: hashSecret(id) },
    });
    if (
      !token ||
      token.kind !== "challenge" ||
      token.expiresAt <= new Date() ||
      token.purpose !== purpose ||
      token.preauthHash !== prehash
    )
      deny(401, "This scan expired or was already used. Start a new scan.");
    await adb.accessToken.delete({ where: { hash: token.hash } });
    return token;
  }

  async audit(actor: string | null, action: string, target: string | null) {
    await adb.accessAudit.create({ data: { actor, action, target } });
  }

  async handle(
    action: string,
    body: Record<string, unknown>,
    credentials: Credentials,
    address: string,
    origin = "",
    agent = "",
  ): Promise<Result> {
    try {
      return await this.run(action, body ?? {}, credentials, address, origin, agent);
    } catch (error) {
      if (error instanceof AuthError)
        return { status: error.status, body: { error: error.message } };
      throw error;
    }
  }

  private async run(
    action: string,
    body: Record<string, unknown>,
    credentials: Credentials,
    address: string,
    origin: string,
    agent: string,
  ): Promise<Result> {
    if (action === "init") {
      await this.throttle(address, "init", 10, 3_600_000);
      return this.init(body.userPassword, body.adminPassword);
    }
    const config = (await this.getConfig()) ?? deny(503, "This workspace is not set up yet.");

    if (action.startsWith("passkey-")) {
      await this.throttle(address, "passkey", 60);
      return handlePasskey(action, body, origin, { address, agent });
    }

    if (action === "device-status") {
      await this.throttle(address, "device-status", 30, 60_000);
      const receipt = typeof body.receipt === "string" && /^[a-f0-9]{64}$/.test(body.receipt) ? body.receipt : "";
      const token = receipt ? await adb.accessToken.findUnique({ where: { hash: hashSecret(receipt) } }) : null;
      if (!token || token.kind !== "device-receipt" || token.expiresAt <= new Date() || !token.purpose || !token.userId) deny(401, "The approval request expired. Sign in again.");
      const credential = await adb.accessPasskey.findUnique({ where: { id: token.purpose }, select: { userId: true, approved: true } });
      if (!credential || credential.userId !== token.userId) deny(404, "This approval request no longer exists.");
      return { status: 200, body: { status: credential.approved ? "approved" : "pending" } };
    }

    if (action === "session") {
      const session = await this.getSession(credentials.session);
      const admin = await adb.accessUser.findFirst({
        where: { role: "admin" },
        select: { id: true },
      });
      return {
        status: 200,
        body: {
          initialized: true,
          unlocked: session?.role === "user",
          role: session?.role ?? null,
          name: session?.name ?? null,
          adminEnrolled: admin !== null,
        },
      };
    }

    /** Bootstrap escape hatch: wipe the whole workspace (passwords, faces,
     *  sessions, payments) back to the first-run wizard. Requires the
     *  administrator passcode — proof of workspace ownership. Used when the
     *  one-time setup secret was lost before the administrator face was
     *  enrolled, which would otherwise brick the workspace. */
    if (action === "reset") {
      await this.throttle(address, "reset", 5, 3_600_000);
      if (await adb.accessUser.count({ where: { role: "admin" } })) {
        deny(403, "Administrator setup is complete. Use your recovery codes or private server-owner recovery.");
      }
      if (
        typeof body.adminPassword !== "string" ||
        Buffer.byteLength(body.adminPassword) > 512
      )
        deny(400, "Enter the administrator passcode to reset this workspace.");
      if (!verifyPasswordHash(body.adminPassword, config.adminHash))
        deny(401, "Administrator passcode required to reset this workspace.");
      await adb.accessUser.deleteMany({});
      await adb.accessToken.deleteMany({});
      await adb.accessPayment.deleteMany({});
      await adb.accessRate.deleteMany({});
      await adb.accessAudit.deleteMany({});
      await adb.accessPasskeyChallenge.deleteMany({});
      await adb.accessConfig.deleteMany({});
      this.config = undefined;
      await adb.accessAudit.create({
        data: { action: "reset", target: null, actor: null },
      });
      return { status: 200, body: { reset: true }, clear: true };
    }

    if (action === "logout") {
      const hashes = [credentials.session, credentials.preauth, typeof body.passkeyStageToken === "string" ? body.passkeyStageToken : undefined]
        .filter(Boolean)
        .map((raw) => tokenHash(raw))
        .filter(Boolean);
      if (hashes.length) {
        await adb.accessToken.deleteMany({ where: { hash: { in: hashes } } });
        const prehash = tokenHash(credentials.preauth);
        if (prehash)
          await adb.accessToken.deleteMany({
            where: { kind: "session", preauthHash: prehash },
          });
      }
      return { status: 200, body: { unlocked: false }, clear: true };
    }

    if (action === "password") {
      const requestedRole = body.role;
      if (requestedRole !== undefined && requestedRole !== "user" && requestedRole !== "admin")
        deny(400, "Choose member or administrator sign-in.");
      await this.throttle(address, requestedRole ? `password:${requestedRole}` : "password", 5);
      if (
        typeof body.password !== "string" ||
        Buffer.byteLength(body.password) > 512
      )
        deny(400, "Enter a valid password.");
      const user = verifyPasswordHash(body.password, config.userHash);
      const admin = verifyPasswordHash(body.password, config.adminHash);
      if (user === admin) deny(401, "Access denied.");
      const role: "user" | "admin" = admin ? "admin" : "user";
      if (requestedRole && role !== requestedRole)
        deny(401, requestedRole === "admin" ? "Administrator passcode not recognized." : "Member passcode not recognized.");
      const exists = await adb.accessUser.findFirst({ where: { role: "admin" } });
      const prehash = tokenHash(credentials.preauth);
      if (prehash)
        await adb.accessToken.deleteMany({ where: { hash: prehash } });
      const preauth = await this.createToken("preauth", role, null, {}, TTL.preauth);
      return {
        status: 200,
        body: { role, setupRequired: admin && !exists, preauthToken: preauth },
        preauth,
        preauthRole: role,
      };
    }

    if (action === "status") {
      await this.throttle(address, "status", 60, 60_000);
      const hash = tokenHash(typeof body.receipt === "string" ? body.receipt : undefined);
      if (!hash) deny(404, "Enrollment request not found or expired.");
      const token = await adb.accessToken.findUnique({
        where: { hash },
        include: { user: true },
      });
      if (
        !token ||
        token.kind !== "receipt" ||
        token.expiresAt <= new Date() ||
        !token.user
      )
        deny(404, "Enrollment request not found or expired.");
      return {
        status: 200,
        body: { status: token.user.status, name: token.user.name },
      };
    }

    if (action.startsWith("admin-"))
      return this.admin(action.slice("admin-".length), body, credentials.session, address);

    const pre = await this.preauth(credentials.preauth);
    await this.throttle(address, "capture", 20);

    if (action === "challenge") {
      const purpose: unknown = body.purpose;
      if (
        typeof purpose !== "string" ||
        !["login", "enroll", "setup", "recover"].includes(purpose)
      )
        deny(400, "Invalid scan purpose.");
      if (purpose === "enroll" && pre.role !== "user")
        deny(403, "Use the normal password to request enrollment.");
      if (["setup", "recover"].includes(purpose) && pre.role !== "admin")
        deny(403, "Administrator authentication required.");
      if (purpose === "setup") {
        const exists = await adb.accessUser.findFirst({ where: { role: "admin" } });
        if (exists) deny(409, "Administrator setup is already complete.");
        const setupToken: unknown = body.setupToken;
        if (
          typeof setupToken !== "string" ||
          setupToken.length > 256 ||
          hashSecret(setupToken) !== config.setupHash
        )
          deny(403, "Invalid setup secret.");
      }
      let recoverUser: string | null = null;
      let recoverVersion: number | null = null;
      if (purpose === "recover") {
        await this.throttle(address, "recovery", 5);
        const recoveryCode: unknown = body.recoveryCode;
        if (typeof recoveryCode !== "string" || recoveryCode.length > 256)
          deny(403, "Invalid recovery code.");
        const codeHash = hashSecret(recoveryCode);
        const token = await adb.accessToken.findUnique({
          where: { hash: codeHash },
          include: { user: true },
        });
        if (
          !token ||
          token.kind !== "recovery" ||
          token.expiresAt <= new Date() ||
          !token.user
        )
          deny(403, "Invalid recovery code.");
        await adb.accessToken.delete({ where: { hash: codeHash } });
        recoverUser = token.user.id;
        recoverVersion = token.user.authVersion;
      }
      const id = await this.createToken(
        "challenge",
        pre.role,
        recoverUser,
        { purpose, preauth: pre.hash, recoverVersion: recoverVersion ?? undefined },
        TTL.challenge,
      );
      return {
        status: 200,
        body: { challengeId: id, expiresIn: 90 },
      };
    }

    if (!["login", "enroll", "setup", "recover"].includes(action))
      deny(400, "Unknown authentication action.");
    if (
      action === "enroll" &&
      (body.consent !== true ||
        typeof body.name !== "string" ||
        body.name.trim().length < 1 ||
        body.name.trim().length > 80)
    )
      deny(400, "Enter your name and consent to face-template storage.");

    const scan = await this.consumeChallenge(body.challengeId, action, pre.hash);

    let descriptor: number[];
    let reviewFrameIndex = 0;
    try {
      const verified = await verifyFace(
        body.images,
        action === "login" ? "login" : "enroll",
      );
      descriptor = verified.descriptor;
      reviewFrameIndex = verified.reviewFrameIndex;
      faceDistance(descriptor, descriptor); // shape validation
    } catch (error) {
      if (error instanceof AuthError) throw error;
      console.error(
        "[access] Face verification rejected:",
        error instanceof Error ? error.message : "Unknown error",
      );
      deny(400, "The face scan could not be processed. Try again.");
    }

    // Recheck pre-auth and clean stale enrollments after inference.
    const fresh = await adb.accessToken.findUnique({ where: { hash: pre.hash } });
    if (!fresh || fresh.kind !== "preauth" || fresh.expiresAt <= new Date())
      deny(401, "Enter your password again.");
    await this.cleanup();
    const enrolled = await adb.accessUser.findMany({
      where: { template: { not: null }, status: { in: ["pending", "approved"] } },
    });
    const loginThreshold = action === "login" ? LOGIN_THRESHOLD : FACE_THRESHOLD;
    const matches = enrolled.filter((u) => {
      try {
        return (
          faceDistance(
            descriptor,
            unseal<number[]>(u.template!, config.templateKey, u.id),
          ) <= loginThreshold
        );
      } catch (error) {
        // A template sealed under an older workspace generation (or otherwise
        // unreadable) must never crash the login pipeline — treat it as a
        // non-match and log it for the administrator.
        console.error(
          "[access] Skipping unreadable face template for",
          u.id,
          error instanceof Error ? error.message : "unknown error",
        );
        return false;
      }
    });

    if (action === "login") {
      const allowed = matches.filter(
        (u) => u.role === pre.role && u.status === "approved",
      );
      if (allowed.length !== 1)
        deny(401, "No approved face matched. New users can request enrollment.");
      const user = allowed[0];
      if (user.role === "user" && !(await this.hasCurrentPayment(user.id)))
        deny(
          402,
          "Payment required. Your A$5 monthly payment needs administrator confirmation. Contact the administrator, then retry your scan.",
        );
      await adb.accessToken.delete({ where: { hash: pre.hash } });
      return beginPasskey(user, "login");
    }

    if (action === "enroll") {
      if (pre.role !== "user") deny(403, "User enrollment required.");
      if (matches.some((u) => u.role === "user"))
        deny(409, "This face already has an enrollment. Contact the administrator.");
      const id = randomUUID();
      const preview = Array.isArray(body.images)
        ? (body.images[reviewFrameIndex] as unknown)
        : undefined;
      if (
        typeof preview !== "string" ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(preview) ||
        preview.length > 120_000
      )
        deny(400, "A valid enrollment photo is required.");
      await adb.accessUser.create({
        data: {
          id,
          name: (body.name as string).trim(),
          role: "user",
          status: "pending",
          template: seal(descriptor, config.templateKey, id),
          reviewPhoto: seal(preview, config.templateKey, id),
        },
      });
      await this.audit(null, "enroll", id);
      return beginPasskey({ id, name: (body.name as string).trim(), role: "user" }, "enroll");
    }

    if (pre.role !== "admin")
      deny(403, "Administrator authentication required.");
    const existing = await adb.accessUser.findFirst({ where: { role: "admin" } });
    let id = scan.userId ?? undefined;
    if (action === "setup") {
      if (existing) deny(409, "Administrator setup is already complete.");
      id = randomUUID();
      await adb.accessUser.create({
        data: {
          id,
          name: "Administrator",
          role: "admin",
          status: "approved",
          template: seal(descriptor, config.templateKey, id),
        },
      });
      await adb.accessConfig.update({
        where: { id: 1 },
        data: { setupHash: null },
      });
      this.config = undefined;
    } else {
      if (!existing || existing.id !== id)
        deny(403, "Invalid recovery request.");
      if (existing.authVersion !== scan.recoverVersion)
        deny(401, "This recovery scan was invalidated. Start a new recovery.");
      await adb.accessUser.update({
        where: { id: existing.id },
        data: {
          template: seal(descriptor, config.templateKey, existing.id),
          authVersion: { increment: 1 },
        },
      });
      await adb.accessToken.deleteMany({ where: { userId: existing.id } });
      await adb.accessPasskey.deleteMany({ where: { userId: existing.id } });
    }
    const recoveryCodes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const code = newToken();
      recoveryCodes.push(code);
      await adb.accessToken.create({
        data: {
          hash: hashSecret(code),
          kind: "recovery",
          role: "admin",
          userId: id!,
          expiresAt: new Date(Date.now() + TTL.recovery),
        },
      });
    }
    await adb.accessToken.deleteMany({ where: { hash: pre.hash } });
    await this.audit(id!, action, id!);
    const stage = await beginPasskey({ id: id!, name: "Administrator", role: "admin" }, action);
    stage.body.recoveryCodes = recoveryCodes;
    return stage;
  }

  /* ------------------------------ admin ------------------------------ */

  private async admin(
    action: string,
    body: Record<string, unknown>,
    raw: string | undefined,
    address: string,
  ): Promise<Result> {
    const session =
      (await this.getSession(raw, "admin")) ??
      deny(403, "Administrator authentication required.");
    await this.throttle(address, "admin", 120, 60_000);

    if (action === "devices") {
      const devices = await adb.accessPasskey.findMany({
        orderBy: { createdAt: "desc" }, take: 500,
        select: { id: true, rpId: true, approved: true, approvedAt: true, requestAddress: true, requestAgent: true, backedUp: true, deviceType: true, createdAt: true, lastUsedAt: true, user: { select: { id: true, name: true, role: true, status: true } } },
      });
      return { status: 200, body: { devices: devices.map(({ id, ...device }) => ({ ...device, id, owner: device.user.role === "admin" })) } };
    }

    if (action === "approve-device" || action === "revoke-device") {
      if (typeof body.id !== "string" || body.id.length > 2000) deny(400, "Choose a valid passkey request.");
      const device = await adb.accessPasskey.findUnique({ where: { id: body.id }, include: { user: { select: { role: true, status: true } } } });
      if (!device || device.user.role !== "user") deny(404, "Member passkey not found.");
      if (action === "approve-device" && !["approved", "pending"].includes(device.user.status)) deny(409, "This member no longer has an active enrollment.");
      await adb.$transaction(async (transaction) => {
        await transaction.accessPasskey.update({ where: { id: device.id }, data: { approved: action === "approve-device", approvedAt: action === "approve-device" ? new Date() : null } });
        if (action === "revoke-device") {
          await transaction.accessToken.deleteMany({ where: { userId: device.userId, kind: "session" } });
        }
        await transaction.accessAudit.create({ data: { actor: session.userId, action, target: device.userId } });
      });
      return { status: 200, body: { ok: true } };
    }

    if (action === "payments") {
      const users = await adb.accessUser.findMany({
        where: { role: "user" },
        orderBy: { createdAt: "desc" },
        take: 500,
        include: { payments: { orderBy: { period: "desc" } } },
      });
      const now = new Date();
      return {
        status: 200,
        body: {
          users: users.map((user) => {
            const period = billingPeriod(user.createdAt, now);
            return {
              id: user.id,
              name: user.name,
              status: user.status,
              created: user.createdAt.toISOString(),
              payment: {
                ...period,
                amountCents: PAYMENT_AMOUNT_CENTS,
                paid: user.payments.some(
                  (p) =>
                    p.period === period.period &&
                    new Date(p.periodStart) <= now &&
                    new Date(p.periodEnd) > now,
                ),
              },
              payments: user.payments.map((p) => ({
                period: p.period,
                start: p.periodStart.toISOString(),
                end: p.periodEnd.toISOString(),
                amountCents: p.amountCents,
                confirmedAt: p.confirmedAt.toISOString(),
              })),
            };
          }),
        },
      };
    }

    if (action === "list") {
      await this.cleanup();
      const config = (await this.getConfig())!;
      const users = await adb.accessUser.findMany({
        where: { role: "user" },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      return {
        status: 200,
        body: {
          users: users.map((user) => ({
            id: user.id,
            name: user.name,
            status: user.status,
            created: user.createdAt.toISOString(),
            preview: (() => {
              if (user.status !== "pending" || !user.reviewPhoto) return null;
              try {
                return unseal<string>(
                  user.reviewPhoto,
                  config.templateKey,
                  user.id,
                );
              } catch {
                return null; // unreadable review photo must never break listing
              }
            })(),
          })),
        },
      };
    }

    if (
      !["approve", "reject", "revoke", "delete", "confirm-payment"].includes(
        action,
      ) ||
      typeof body.id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(body.id)
    )
      deny(400, "Invalid administrator action.");
    const user = await adb.accessUser.findUnique({ where: { id: body.id } });
    if (!user || user.role !== "user") deny(404, "User not found.");

    if (action === "confirm-payment") {
      if (!["pending", "approved"].includes(user.status))
        deny(409, "Only pending or approved members can have payments confirmed.");
      const current = billingPeriod(user.createdAt);
      const period = body.period;
      if (
        !Number.isSafeInteger(period) ||
        (period as number) < 0 ||
        (period as number) > current.period
      )
        deny(400, "Select a registration month that is already due.");
      const at = billingPeriodAt(user.createdAt, period as number);
      const saved = await adb.accessPayment.upsert({
        where: { userId_period: { userId: user.id, period: period as number } },
        create: {
          userId: user.id,
          period: period as number,
          periodStart: new Date(at.start),
          periodEnd: new Date(at.end),
          amountCents: PAYMENT_AMOUNT_CENTS,
          confirmedBy: session.userId,
        },
        update: {},
      });
      if (saved)
        await this.audit(session.userId, "payment-confirmed", user.id);
      return { status: 200, body: { ok: true } };
    }

    if (action === "approve") {
      if (
        user.status !== "pending" ||
        !user.template ||
        user.createdAt.getTime() < Date.now() - 604_800_000
      )
        deny(409, "Only current pending requests can be approved.");
      await adb.accessUser.update({
        where: { id: user.id },
        data: { status: "approved", reviewPhoto: null },
      });
    } else if (action === "delete") {
      await adb.accessUser.delete({ where: { id: user.id } });
    } else {
      await adb.accessUser.update({
        where: { id: user.id },
        data: {
          status: action === "reject" ? "rejected" : "revoked",
          template: null,
          reviewPhoto: null,
        },
      });
      await adb.accessToken.deleteMany({
        where: { userId: user.id, kind: "session" },
      });
    }
    await this.audit(session.userId, action, user.id);
    return { status: 200, body: { ok: true } };
  }
}

let defaultService: AccessService | undefined;
export function getAccessService() {
  if (!defaultService) defaultService = new AccessService();
  return defaultService;
}
