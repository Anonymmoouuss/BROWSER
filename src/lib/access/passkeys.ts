import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { adb } from "./db";
import { hashSecret, newToken, TTL } from "./crypto";
import type { Result } from "./service";

export function passkeyContext(value: string): { origin: string; rpId: string } {
  const defaults = [
    "https://linewizesucks.vercel.app",
    "http://localhost:8080", "http://localhost:3000",
    "http://127.0.0.1:8080", "http://127.0.0.1:3000",
  ];
  if (process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    defaults.push(`https://${process.env.CODESPACE_NAME}-8080.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`);
  }
  const trusted = (process.env.WEBAUTHN_ORIGINS?.split(",") ?? defaults).map((entry) => entry.trim()).filter(Boolean);
  const url = new URL(value);
  if (
    url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
    !trusted.some((entry) => new URL(entry).origin === url.origin)
  ) {
    throw new Error("Open the workspace at its configured address to use a passkey.");
  }
  return { origin: url.origin, rpId: url.hostname };
}

export async function beginPasskey(user: { id: string; name: string; role: string }, purpose: string): Promise<Result> {
  const stage = newToken();
  await adb.accessToken.create({
    data: {
      hash: hashSecret(stage), kind: "passkey-stage", role: user.role, userId: user.id,
      purpose, expiresAt: new Date(Date.now() + 300_000),
    },
  });
  return {
    status: 200,
    body: { passkeyRequired: true, passkeyStageToken: stage, role: user.role, name: user.name, unlocked: false },
  };
}

function storedTransports(value: string): AuthenticatorTransportFuture[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is AuthenticatorTransportFuture => typeof item === "string") : [];
}

export async function handlePasskey(action: string, body: Record<string, unknown>, requestOrigin: string, request: { address: string; agent: string } = { address: "unknown", agent: "" }): Promise<Result> {
  const reject = (error: string, status = 401): Result => ({ status, body: { error } });
  let context: ReturnType<typeof passkeyContext>;
  try { context = passkeyContext(requestOrigin); }
  catch { return reject("Open the workspace at its configured address to use a passkey.", 403); }
  const raw = body.passkeyStageToken;
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) return reject("Verify your password and face first.");
  const stage = await adb.accessToken.findUnique({ where: { hash: hashSecret(raw) }, include: { user: true } });
  if (!stage || stage.kind !== "passkey-stage" || stage.expiresAt <= new Date() || !stage.user) {
    return reject("The passkey step expired. Verify your password and face again.");
  }
  const user = stage.user;
  if (user.status !== "approved" && !(stage.purpose === "enroll" && user.status === "pending")) {
    return reject("This account is not approved.", 403);
  }
  const credentials = await adb.accessPasskey.findMany({ where: { userId: user.id } });
  const matching = credentials.filter((credential) => credential.rpId === context.rpId);
  if (credentials.length && !matching.length) {
    return reject("Use the workspace address where your passkey was enrolled. A different domain cannot use that credential.", 409);
  }
  if (action === "passkey-options") {
    const kind = matching.length ? "authenticate" : "register";
    const options = kind === "register"
      ? await generateRegistrationOptions({
        rpName: "Browser Workspace", rpID: context.rpId, userID: Buffer.from(user.id),
        userName: user.id, userDisplayName: user.name, timeout: 60_000,
        attestationType: "none", supportedAlgorithmIDs: [-7, -257, -8],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      })
      : await generateAuthenticationOptions({
        rpID: context.rpId, timeout: 60_000, userVerification: "required",
        allowCredentials: matching.map((credential) => ({ id: credential.id, transports: storedTransports(credential.transports) })),
      });
    if ("rp" in options) delete options.rp.id;
    if ("rpId" in options) delete options.rpId;
    const challengeId = newToken();
    await adb.accessPasskeyChallenge.deleteMany({ where: { stageHash: stage.hash } });
    await adb.accessPasskeyChallenge.create({
      data: { id: challengeId, stageHash: stage.hash, challenge: options.challenge, kind, ...context, expiresAt: new Date(Date.now() + 120_000) },
    });
    return { status: 200, body: { mode: kind, challengeId, options } };
  }
  if (action !== "passkey-verify") return reject("Unknown passkey action.", 400);
  if (typeof body.challengeId !== "string" || typeof body.response !== "object" || !body.response) {
    return reject("Invalid passkey response.", 400);
  }
  const challenge = await adb.accessPasskeyChallenge.findUnique({ where: { id: body.challengeId } });
  if (!challenge || challenge.stageHash !== stage.hash || challenge.origin !== context.origin || challenge.rpId !== context.rpId || challenge.expiresAt <= new Date()) {
    return reject("This passkey challenge expired or belongs to a different address. Retry verification.");
  }
  const consumed = await adb.accessPasskeyChallenge.deleteMany({ where: { id: challenge.id, stageHash: stage.hash, expiresAt: { gt: new Date() } } });
  if (consumed.count !== 1) return reject("This passkey challenge was already used.");
  let registered: { id: string; publicKey: Uint8Array<ArrayBuffer>; counter: number; transports: string; deviceType: string; backedUp: boolean } | undefined;
  let authenticated: { id: string; oldCounter: number; counter: number; deviceType: string; backedUp: boolean } | undefined;
  try {
    const response = body.response as RegistrationResponseJSON | AuthenticationResponseJSON;
    const clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8"));
    if (clientData.crossOrigin === true) return reject("Open this workspace in its own browser tab to verify a passkey.", 403);
    if (challenge.kind === "register") {
      if (credentials.length) return reject("A passkey is already enrolled. Verify the existing passkey.");
      const verified = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON, expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin, expectedRPID: challenge.rpId,
        requireUserVerification: true, supportedAlgorithmIDs: [-7, -257, -8],
      });
      if (!verified.verified || !verified.registrationInfo) return reject("Passkey enrollment was not verified.");
      const info = verified.registrationInfo;
      registered = {
        id: info.credential.id, publicKey: new Uint8Array(info.credential.publicKey), counter: info.credential.counter,
        transports: JSON.stringify(info.credential.transports ?? []), deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp,
      };
    } else {
      const credential = matching.find((item) => item.id === response.id);
      if (!credential) return reject("Use the passkey enrolled for this account.");
      const verified = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON, expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin, expectedRPID: challenge.rpId, requireUserVerification: true,
        credential: { id: credential.id, publicKey: new Uint8Array(credential.publicKey), counter: credential.counter, transports: storedTransports(credential.transports) },
      });
      if (!verified.verified) return reject("The passkey signature could not be verified.");
      authenticated = {
        id: credential.id, oldCounter: credential.counter, counter: verified.authenticationInfo.newCounter,
        deviceType: verified.authenticationInfo.credentialDeviceType, backedUp: verified.authenticationInfo.credentialBackedUp,
      };
    }
  } catch {
    return reject("Passkey verification failed. Retry with your enrolled passkey.");
  }
  const session = newToken();
  const approvalReceipt = newToken();
  let approvalNeeded = false;
  const ttl = user.role === "admin" ? TTL.adminSession : TTL.userSession;
  try {
    await adb.$transaction(async (transaction) => {
      const claimed = await transaction.accessToken.deleteMany({ where: { hash: stage.hash, kind: "passkey-stage", expiresAt: { gt: new Date() } } });
      if (claimed.count !== 1) throw new Error("Stage expired");
      const current = await transaction.accessUser.findUniqueOrThrow({ where: { id: user.id } });
      if (current.status !== "approved" && !(stage.purpose === "enroll" && current.status === "pending")) throw new Error("Account revoked");
      if (registered) await transaction.accessPasskey.create({ data: {
        ...registered, userId: user.id, rpId: context.rpId, approved: user.role === "admin",
        approvedAt: user.role === "admin" ? new Date() : null,
        requestAddress: request.address.slice(0, 100), requestAgent: request.agent.slice(0, 200),
      } });
      if (authenticated) {
        const updated = await transaction.accessPasskey.updateMany({
          where: { id: authenticated.id, counter: authenticated.oldCounter },
          data: { counter: authenticated.counter, deviceType: authenticated.deviceType, backedUp: authenticated.backedUp, lastUsedAt: new Date(), requestAddress: request.address.slice(0, 100), requestAgent: request.agent.slice(0, 200) },
        });
        if (updated.count !== 1) throw new Error("Concurrent assertion");
      }
      if (stage.purpose !== "enroll") {
        if (user.role !== "admin" && !(await transaction.accessPayment.count({ where: { userId: user.id, periodStart: { lte: new Date() }, periodEnd: { gt: new Date() } } }))) throw new Error("Payment expired");
        const credentialId = registered?.id ?? authenticated?.id;
        if (!credentialId) throw new Error("Missing verified passkey");
        const currentCredential = await transaction.accessPasskey.findUniqueOrThrow({ where: { id: credentialId } });
        if (user.role !== "admin" && !currentCredential.approved) {
          approvalNeeded = true;
          await transaction.accessToken.create({ data: { hash: hashSecret(approvalReceipt), kind: "device-receipt", role: "user", userId: user.id, purpose: credentialId, expiresAt: new Date(Date.now() + TTL.receipt) } });
        } else {
          await transaction.accessToken.create({ data: { hash: hashSecret(session), kind: "session", role: user.role, userId: user.id, passkeyId: credentialId, purpose: "webauthn", expiresAt: new Date(Date.now() + ttl) } });
        }
      }
      await transaction.accessAudit.create({ data: { actor: user.id, action: registered ? "passkey-enrolled" : "passkey-login", target: user.id } });
    });
  } catch {
    return reject("The sign-in step expired or your account changed. Verify your password and face again.");
  }
  if (stage.purpose === "enroll") {
    const receipt = newToken();
    await adb.accessToken.create({ data: { hash: hashSecret(receipt), kind: "receipt", role: "user", userId: user.id, expiresAt: new Date(Date.now() + TTL.receipt) } });
    return { status: 202, body: { status: "pending", receipt } };
  }
  if (approvalNeeded) {
    return { status: 202, body: { deviceApprovalRequired: true, receipt: approvalReceipt, role: "user", unlocked: false } };
  }
  return {
    status: 200, body: { unlocked: user.role === "user", role: user.role, sessionToken: session },
    session, sessionRole: user.role as "user" | "admin", sessionName: user.name, sessionTtl: ttl,
  };
}