/** API-level E2E: header-token transport (preview-iframe equivalent).
 * Each logical client uses a distinct X-Forwarded-For so per-address
 * throttling (5 passwords / 5 min) models distinct users, not one bot. */
const BASE = process.env.E2E_BASE_URL;
if (!BASE) throw new Error("Set E2E_BASE_URL to a disposable, freshly initialized test backend.");
const admin = await Bun.file(new URL("./admin-face.jpeg.b64", import.meta.url)).text();
const member = await Bun.file(new URL("./member-face.jpeg.b64", import.meta.url)).text();

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, detail); }
}

let ipSeq = 0;
const ip = () => `10.0.0.${++ipSeq}`;

async function req(action: string, data: Record<string, unknown>, headers: Record<string, string> = {}, admin_ = false, clientIp = ip()) {
  const res = await fetch(admin_ ? `${BASE}/api/admin` : `${BASE}/api/access`, {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": clientIp, ...headers },
    body: JSON.stringify({ action, ...data }),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any, headers: res.headers };
}

// 0. pristine state
{
  const s = await (await fetch(`${BASE}/api/access`)).json();
  if (s.initialized !== false) throw new Error("Refusing to run enrollment tests against an existing workspace.");
  check("pristine-first-run", s.initialized === false, JSON.stringify(s));
}

// 1. init
const init = await req("init", { userPassword: "member-pass-12345", adminPassword: "admin-pass-123456" });
check("init-200", init.status === 200 && typeof init.body.setupSecret === "string", JSON.stringify(init.body));
const secret = init.body.setupSecret as string;

{
  const wrongRole = await req("password", { password: "member-pass-12345", role: "admin" });
  check("member-passcode-never-grants-admin", wrongRole.status === 401);
  const adminRole = await req("password", { password: "admin-pass-123456", role: "admin" });
  check("explicit-admin-passcode", adminRole.status === 200 && adminRole.body.role === "admin");
  const sharedAddress = ip();
  for (let attempt = 0; attempt < 5; attempt++) {
    await req("password", { password: "incorrect-password", role: "user" }, {}, false, sharedAddress);
  }
  const blockedMember = await req("password", { password: "member-pass-12345", role: "user" }, {}, false, sharedAddress);
  check("member-password-limit-enforced", blockedMember.status === 429);
  const unblockedAdmin = await req("password", { password: "admin-pass-123456", role: "admin" }, {}, false, sharedAddress);
  check("member-retries-do-not-lock-admin", unblockedAdmin.status === 200 && unblockedAdmin.body.role === "admin");
}

// 2. admin password
const pw = await req("password", { password: "admin-pass-123456" });
check("admin-password", pw.status === 200 && pw.body.role === "admin" && pw.body.setupRequired === true, JSON.stringify(pw.body));
let adminPre = pw.body.preauthToken as string;

// 3. setup challenge + enrollment (20 photos)
const ch = await req("challenge", { purpose: "setup", setupToken: secret }, { "x-sj-preauth": adminPre });
check("setup-challenge", ch.status === 200 && ch.body.challengeId, JSON.stringify(ch.body));
const setup = await req("setup", { challengeId: ch.body.challengeId, images: Array(20).fill(admin) }, { "x-sj-preauth": adminPre });
check("admin-setup", setup.status === 200 && setup.body.role === "admin" && Array.isArray(setup.body.recoveryCodes) && setup.body.recoveryCodes.length === 8, JSON.stringify(setup.body).slice(0, 200));
let adminSession = setup.body.sessionToken as string;
const adminGrant = setup.body.sessionGrant as string;
check("admin-session-grant", typeof adminGrant === "string" && adminGrant.startsWith("v1."));

// 4. session GET shows admin
{
  const s = await (await fetch(`${BASE}/api/access`, { headers: { "x-sj-session": adminSession } })).json();
  check("session-get-admin", s.initialized === true && s.role === "admin" && s.unlocked === false && s.adminEnrolled === true, JSON.stringify(s));
}

// 5. admin panel reachable
{
  const list = await (await fetch(`${BASE}/api/admin`, { headers: { "x-sj-session": adminSession } })).json();
  check("admin-list-empty", Array.isArray(list.users) && list.users.length === 0, JSON.stringify(list));
}

// 6. member enrollment
const mpw = await req("password", { password: "member-pass-12345" });
check("member-password", mpw.status === 200 && mpw.body.role === "user", JSON.stringify(mpw.body));
const memberPre = mpw.body.preauthToken as string;
const ech = await req("challenge", { purpose: "enroll" }, { "x-sj-preauth": memberPre });
check("enroll-challenge", ech.status === 200, JSON.stringify(ech.body));
const en = await req("enroll", { challengeId: ech.body.challengeId, name: "Test Member", consent: true, images: Array(20).fill(member) }, { "x-sj-preauth": memberPre });
check("member-enroll-pending", en.status === 202 && en.body.status === "pending" && en.body.receipt, JSON.stringify(en.body));

// 7. member login before approval -> 401
{
  const pw2 = await req("password", { password: "member-pass-12345" });
  const pre = pw2.body.preauthToken as string;
  const c2 = await req("challenge", { purpose: "login" }, { "x-sj-preauth": pre });
  const lg = await req("login", { challengeId: c2.body.challengeId, images: [member, member, member] }, { "x-sj-preauth": pre });
  check("member-login-blocked-pre-approval", lg.status === 401, JSON.stringify(lg.body));
}

// 8. approve + pay
{
  const list = await (await fetch(`${BASE}/api/admin`, { headers: { "x-sj-session": adminSession } })).json();
  check("admin-list-pending", list.users.length === 1 && list.users[0].status === "pending" && typeof list.users[0].preview === "string", JSON.stringify(list.users?.[0]).slice(0, 100));
  const ap = await req("approve", { id: list.users[0].id }, { "x-sj-session": adminSession }, true);
  check("approve", ap.status === 200, JSON.stringify(ap.body));
  const pays = await req("payments", {}, { "x-sj-session": adminSession }, true);
  check("payments-list", pays.status === 200 && pays.body.users.length === 1 && pays.body.users[0].payment.paid === false, JSON.stringify(pays.body.users?.[0]?.payment));
  const cf = await req("confirm-payment", { id: list.users[0].id, period: pays.body.users[0].payment.period }, { "x-sj-session": adminSession }, true);
  check("confirm-payment", cf.status === 200, JSON.stringify(cf.body));
}

// 9. member login with 3 frames (NEW multi-frame path)
{
  const pw3 = await req("password", { password: "member-pass-12345" });
  const pre = pw3.body.preauthToken as string;
  const c3 = await req("challenge", { purpose: "login" }, { "x-sj-preauth": pre });
  const lg = await req("login", { challengeId: c3.body.challengeId, images: [member, member, member] }, { "x-sj-preauth": pre });
  check("member-login-3-frames", lg.status === 200 && lg.body.unlocked === true && lg.body.role === "user", JSON.stringify(lg.body));
  const memberSession = lg.body.sessionToken as string;
  const s = await (await fetch(`${BASE}/api/access`, { headers: { "x-sj-session": memberSession } })).json();
  check("member-unlocked", s.unlocked === true && s.role === "user", JSON.stringify(s));
  await req("logout", {}, { "x-sj-session": memberSession });
}

// 10. member login with 1 frame still works
{
  const pw4 = await req("password", { password: "member-pass-12345" });
  const pre = pw4.body.preauthToken as string;
  const c4 = await req("challenge", { purpose: "login" }, { "x-sj-preauth": pre });
  const lg = await req("login", { challengeId: c4.body.challengeId, images: [member] }, { "x-sj-preauth": pre });
  check("member-login-1-frame", lg.status === 200 && lg.body.unlocked === true, JSON.stringify(lg.body));
}

// 11. WRONG face at member login -> 401 no match
{
  const pw5 = await req("password", { password: "member-pass-12345" });
  const pre = pw5.body.preauthToken as string;
  const c5 = await req("challenge", { purpose: "login" }, { "x-sj-preauth": pre });
  const lg = await req("login", { challengeId: c5.body.challengeId, images: [admin, admin, admin] }, { "x-sj-preauth": pre });
  check("wrong-face-rejected", lg.status === 401, JSON.stringify(lg.body));
}

// 12. THE USER'S EXACT PATH: fresh admin password -> admin face LOGIN (not setup) -> admin panel
{
  const pw6 = await req("password", { password: "admin-pass-123456" });
  const pre = pw6.body.preauthToken as string;
  check("admin-reauth-password", pw6.status === 200 && pw6.body.setupRequired === false, JSON.stringify(pw6.body));
  const c6 = await req("challenge", { purpose: "login" }, { "x-sj-preauth": pre });
  check("admin-login-challenge", c6.status === 200, JSON.stringify(c6.body));
  const lg = await req("login", { challengeId: c6.body.challengeId, images: [admin, admin, admin] }, { "x-sj-preauth": pre });
  check("ADMIN-FACE-LOGIN", lg.status === 200 && lg.body.role === "admin" && lg.body.unlocked === false, JSON.stringify(lg.body));
  const newAdminSession = lg.body.sessionToken as string;
  const list = await (await fetch(`${BASE}/api/admin`, { headers: { "x-sj-session": newAdminSession } })).json();
  check("admin-panel-after-face-login", Array.isArray(list.users) && list.users.length === 1 && list.users[0].name === "Test Member", JSON.stringify(list));
  const s = await (await fetch(`${BASE}/api/access`, { headers: { "x-sj-session": newAdminSession } })).json();
  check("admin-session-role", s.role === "admin", JSON.stringify(s));
  await req("logout", {}, { "x-sj-session": newAdminSession });
}

// 13. setup secret consumed -> setup challenge now rejected
{
  const pw7 = await req("password", { password: "admin-pass-123456" });
  const pre = pw7.body.preauthToken as string;
  const c7 = await req("challenge", { purpose: "setup", setupToken: secret }, { "x-sj-preauth": pre });
  check("setup-secret-burned", c7.status === 403 || c7.status === 409, JSON.stringify(c7.body));
}

// 14. challenge reuse -> 401
{
  const pw8 = await req("password", { password: "admin-pass-123456" });
  const pre = pw8.body.preauthToken as string;
  const c8 = await req("challenge", { purpose: "login" }, { "x-sj-preauth": pre });
  await req("login", { challengeId: c8.body.challengeId, images: [admin, admin, admin] }, { "x-sj-preauth": pre });
  const re = await req("login", { challengeId: c8.body.challengeId, images: [admin, admin, admin] }, { "x-sj-preauth": pre });
  check("challenge-single-use", re.status === 401, JSON.stringify(re.body));
}

// 15. unknown action -> always JSON, never an HTML error page
{
  const res = await fetch(`${BASE}/api/access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "bogus" }) });
  const ct = res.headers.get("content-type") ?? "";
  const body = await res.json().catch(() => null);
  check("unknown-action-json-only", ct.includes("json") && (res.status === 400 || res.status === 401) && body?.error, `${res.status} ${ct}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
