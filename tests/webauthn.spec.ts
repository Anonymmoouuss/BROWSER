import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const origin = process.env.E2E_FRONTEND_ORIGIN;
if (!origin) throw new Error("Set E2E_FRONTEND_ORIGIN to a disposable empty workspace.");
test.setTimeout(240_000);

test("password, face, and real WebAuthn ceremonies are required; replay and tampering are rejected", async ({ page, context, request }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const post = async (action: string, data: Record<string, unknown> = {}, headers: Record<string, string> = {}, admin = false) => {
    const response = await request.post(`${origin}/api/${admin ? "admin" : "access"}`, {
      headers: { origin, ...headers }, data: { action, ...data },
    });
    return { status: response.status(), body: await response.json() };
  };
  const initial = await request.get(`${origin}/api/access`);
  expect((await initial.json()).initialized).toBe(false);
  await page.goto(origin);
  const images = {
    admin: (await readFile("e2e-assets/admin-face.jpeg.b64", "utf8")).trim(),
    user: (await readFile("e2e-assets/member-face.jpeg.b64", "utf8")).trim(),
  };
  const init = await post("init", { userPassword: "member-pass-12345", adminPassword: "admin-pass-123456" });
  expect(init.status).toBe(200);
  const face = async (role: "admin" | "user", purpose: string, extra: Record<string, unknown> = {}) => {
    const password = await post("password", { password: role === "admin" ? "admin-pass-123456" : "member-pass-12345", role });
    expect(password.status).toBe(200);
    const headers = { "x-sj-preauth": password.body.preauthToken };
    const challenge = await post("challenge", { purpose, ...extra }, headers);
    expect(challenge.status).toBe(200);
    return post(purpose, { challengeId: challenge.body.challengeId, images: Array(purpose === "login" ? 3 : 20).fill(images[role]), ...extra }, headers);
  };
  const options = async (stage: string) => {
    const result = await post("passkey-options", { passkeyStageToken: stage });
    expect(result.status).toBe(200);
    expect(result.body.options.userVerification ?? result.body.options.authenticatorSelection?.userVerification).toBe("required");
    expect(result.body.options.rp?.id).toBeUndefined();
    expect(result.body.options.rpId).toBeUndefined();
    return result.body;
  };
  const credential = async (body: { mode: string; options: unknown }) => page.evaluate(async ({ mode, options: json }) => {
    const result = mode === "register"
      ? await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(json as PublicKeyCredentialCreationOptionsJSON) })
      : await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(json as PublicKeyCredentialRequestOptionsJSON) });
    return (result as PublicKeyCredential).toJSON();
  }, body);
  const finish = async (stage: string) => {
    const generated = await options(stage);
    const response = await credential(generated);
    const result = await post("passkey-verify", { passkeyStageToken: stage, challengeId: generated.challengeId, response });
    return { ...result, generated, response };
  };
  const setup = await face("admin", "setup", { setupToken: init.body.setupSecret });
  expect(setup.body.passkeyRequired).toBe(true);
  expect(setup.body.sessionToken).toBeUndefined();
  expect((await request.get(`${origin}/api/admin`)).status()).toBe(403);
  const admin = await finish(setup.body.passkeyStageToken);
  expect(admin.status).toBe(200);
  expect(admin.body.role).toBe("admin");
  const adminHeaders = { "x-sj-session": admin.body.sessionToken };
  expect((await request.get(`${origin}/api/admin`, { headers: adminHeaders })).status()).toBe(200);
  const replay = await post("passkey-verify", { passkeyStageToken: setup.body.passkeyStageToken, challengeId: admin.generated.challengeId, response: admin.response });
  expect(replay.status).toBe(401);
  const enrollment = await face("user", "enroll", { name: "WebAuthn Test Member", consent: true });
  expect(enrollment.body.passkeyRequired).toBe(true);
  expect(enrollment.body.sessionToken).toBeUndefined();
  const pending = await finish(enrollment.body.passkeyStageToken);
  expect(pending.status).toBe(202);
  expect(pending.body.status).toBe("pending");
  expect(pending.body.sessionToken).toBeUndefined();
  const membersResponse = await request.get(`${origin}/api/admin`, { headers: adminHeaders });
  const member = (await membersResponse.json()).users[0];
  expect((await post("approve", { id: member.id }, adminHeaders, true)).status).toBe(200);
  const payments = await post("payments", {}, adminHeaders, true);
  expect((await post("confirm-payment", { id: member.id, period: payments.body.users[0].payment.period }, adminHeaders, true)).status).toBe(200);
  const login = await face("user", "login");
  expect(login.body.passkeyRequired).toBe(true);
  expect(login.body.sessionToken).toBeUndefined();
  const stage = login.body.passkeyStageToken;
  const deniedOrigin = await post("passkey-options", { passkeyStageToken: stage }, { origin: "https://evil.example" });
  expect(deniedOrigin.status).toBe(403);
  const generated = await options(stage);
  expect(generated.mode).toBe("authenticate");
  const assertion = await credential(generated);
  const invalid = structuredClone(assertion);
  if (!("signature" in invalid.response)) throw new Error("Expected authentication assertion");
  invalid.response.signature = "AAAA";
  const badSignature = await post("passkey-verify", { passkeyStageToken: stage, challengeId: generated.challengeId, response: invalid });
  expect(badSignature.status).toBe(401);
  expect(badSignature.body.sessionToken).toBeUndefined();
  const consumed = await post("passkey-verify", { passkeyStageToken: stage, challengeId: generated.challengeId, response: assertion });
  expect(consumed.status).toBe(401);
  const valid = await finish(stage);
  expect(valid.status).toBe(202);
  expect(valid.body.deviceApprovalRequired).toBe(true);
  expect(valid.body.unlocked).toBe(false);
  expect(valid.body.sessionToken).toBeUndefined();
  expect(valid.body.sessionGrant).toBeUndefined();
  const approvalReceipt = valid.body.receipt;
  expect((await post("device-status", { receipt: approvalReceipt })).body.status).toBe("pending");
  const deviceList = await post("devices", {}, adminHeaders, true);
  expect(deviceList.status).toBe(200);
  const device = deviceList.body.devices.find((entry: { user: { id: string } }) => entry.user.id === member.id);
  expect(device.approved).toBe(false);
  expect(device.requestAddress).toBeTruthy();
  expect((await post("approve-device", { id: device.id }, { "x-sj-session": "0".repeat(64) }, true)).status).toBe(403);
  expect((await post("approve-device", { id: device.id }, { ...adminHeaders, origin: "https://evil.example" }, true)).status).toBe(403);
  await page.evaluate((receipt) => sessionStorage.setItem("scramjet-device-approval-receipt", receipt), approvalReceipt);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Owner approval required", exact: true })).toBeVisible();
  expect((await post("approve-device", { id: device.id }, adminHeaders, true)).status).toBe(200);
  await page.getByRole("button", { name: "Check approval", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Access approved", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Return to sign-in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Private access", exact: true })).toBeVisible();
  const approvedLogin = await face("user", "login");
  const approved = await finish(approvedLogin.body.passkeyStageToken);
  expect(approved.status).toBe(200);
  expect(approved.body.unlocked).toBe(true);
  expect(approved.body.sessionGrant).toBeTruthy();
  expect((await post("approve-device", { id: device.id }, { "x-sj-session": approved.body.sessionToken }, true)).status).toBe(403);
  const session = await request.get(`${origin}/api/access`, { headers: { "x-sj-session": approved.body.sessionToken } });
  expect((await session.json()).unlocked).toBe(true);
  const asset = await request.get(`${origin}/sw.js?sjt=${encodeURIComponent(approved.body.sessionGrant)}`);
  expect(asset.status()).toBe(200);
  const socketBase = origin.replace(/^http/, "ws");
  const socketUrls = [
    `${socketBase}/wisp/?XTransformPort=3031&sjt=${encodeURIComponent(approved.body.sessionGrant)}&x=/`,
    `${socketBase}/ws?XTransformPort=3030&sjt=${encodeURIComponent(approved.body.sessionGrant)}`,
  ];
  const opened = await page.evaluate(async (urls) => {
    const sockets = urls.map((url) => new WebSocket(url));
    (window as Window & { __approvalTestSockets?: WebSocket[] }).__approvalTestSockets = sockets;
    return Promise.all(sockets.map((socket) => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      socket.onopen = () => { clearTimeout(timer); resolve(true); };
      socket.onerror = () => { clearTimeout(timer); resolve(false); };
    })));
  }, socketUrls);
  expect(opened).toEqual([true, true]);
  await page.waitForFunction((started) => {
    const sockets = (window as Window & { __approvalTestSockets?: WebSocket[] }).__approvalTestSockets;
    if (!sockets || sockets.some((socket) => socket.readyState !== WebSocket.OPEN)) throw new Error("An approved connection closed during its authorization refresh.");
    return Date.now() - started > 16_000;
  }, Date.now(), { timeout: 22_000, polling: 250 });
  expect((await post("revoke-device", { id: device.id }, adminHeaders, true)).status).toBe(200);
  expect((await (await request.get(`${origin}/api/access`, { headers: { "x-sj-session": approved.body.sessionToken } })).json()).unlocked).toBe(false);
  expect((await request.get(`${origin}/sw.js?sjt=${encodeURIComponent(approved.body.sessionGrant)}`)).status()).toBe(401);
  expect((await request.get(`${origin}/api/proxy?XTransformPort=3030&sjt=${encodeURIComponent(approved.body.sessionGrant)}&url=https%3A%2F%2Fexample.com`)).status()).toBe(401);
  await page.waitForFunction(() => (window as Window & { __approvalTestSockets?: WebSocket[] }).__approvalTestSockets?.every((socket) => socket.readyState === WebSocket.CLOSED), undefined, { timeout: 25_000 });
  expect((await post("approve-device", { id: device.id }, adminHeaders, true)).status).toBe(200);
  const finalLogin = await face("user", "login");
  const restored = await finish(finalLogin.body.passkeyStageToken);
  expect(restored.status).toBe(200);
  expect(restored.body.unlocked).toBe(true);
  await mkdir(".runtime", { recursive: true });
  await writeFile(".runtime/passkey-test-session.json", JSON.stringify({ sessionToken: restored.body.sessionToken, sessionGrant: restored.body.sessionGrant }), { mode: 0o600 });
  await writeFile(".runtime/passkey-test-admin-session.json", JSON.stringify({ sessionToken: admin.body.sessionToken }), { mode: 0o600 });
});